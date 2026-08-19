import type { MetricResult } from './types.js'
import type { ServerHandle } from './serve.js'
import type { BrowserInfo } from './browser.js'

/**
 * Browser-level metrics via Lighthouse-as-a-library against the served build (Layer 2a, browser
 * kind). Determinism choices, all recorded in the protocol as LIGHTHOUSE_PROFILE:
 *
 *  - SIMULATED throttling: Lighthouse computes throttled metrics from an unthrottled trace.
 *    Far more repeatable than applied throttling — §5.1 cares about repeatability between two
 *    sides on one machine, not absolute realism.
 *  - Fixed desktop device profile and viewport; identical flags both sides by construction.
 */

/** Bumped when any determinism choice changes — it rides in the protocol hash. */
export const LIGHTHOUSE_PROFILE = 'simulated/desktop/v5'

/**
 * The warm-up law (spec v24): every fresh execution context runs its first iteration slow —
 * discard it. v2 warmed only the side's first route, and a base-side /blog promptly traced
 * 1.86s vs 1.70s steady (M4 acceptance b) — each route's first trace is its own fresh context.
 * v3: one discarded run PER ROUTE, samples 3→2 — the spread data shows 2 stays in noise once
 * warmed, so the per-route run count is unchanged and the estimator becomes law-correct.
 */
export const LIGHTHOUSE_WARMUP = 1

/** Lighthouse runs cost ~5-10s each — cap harder than route latency. */
export const LIGHTHOUSE_ROUTE_LIMIT = 3

/** Samples per route, after the per-route warm-up. Spread: ≤7ms across boots once warmed. */
export const LIGHTHOUSE_SAMPLES = 2

const CHROME_FLAGS = [
  '--headless=new',
  // Pinned Chrome-for-Testing binaries carry no AppArmor profile, and Ubuntu 24 runners block
  // unprivileged user namespaces — the sandbox cannot start. One flag set everywhere (part of
  // LIGHTHOUSE_PROFILE): the browser only ever loads the app we just built, on localhost.
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--disable-background-networking',
  '--mute-audio',
]

/**
 * Lighthouse targets: subset of the servable routes, dynamic-first, but '/' is ALWAYS included
 * even when static — client-side cost is exactly where SSG routes still regress.
 */
export function selectLighthouseRoutes(
  routes: readonly string[],
  prerendered: ReadonlySet<string>,
): string[] {
  const concrete = routes.filter((r) => !r.includes('['))
  const byPriority = (a: string, b: string) => a.length - b.length || (a < b ? -1 : 1)
  const dynamic = concrete.filter((r) => r !== '/' && !prerendered.has(r)).sort(byPriority)
  const staticRest = concrete.filter((r) => r !== '/' && prerendered.has(r)).sort(byPriority)

  const ordered = concrete.includes('/') ? ['/', ...dynamic, ...staticRest] : [...dynamic, ...staticRest]
  return ordered.slice(0, LIGHTHOUSE_ROUTE_LIMIT)
}

interface RouteAudit {
  readonly lcpMs: number
  readonly tbtMs: number
  readonly fcpMs: number
  readonly transferBytes: number
}

export async function measureLighthouse(
  server: ServerHandle,
  browser: BrowserInfo,
  routes: readonly string[],
  progress: (message: string) => void = () => {},
): Promise<MetricResult[]> {
  const metrics: MetricResult[] = []

  for (const route of routes) {
    progress(`lighthouse ${route}: warm-up + ${LIGHTHOUSE_SAMPLES} runs…`)
    metrics.push(...(await auditRoute(server, browser, route)))
  }
  return metrics
}

async function auditRoute(
  server: ServerHandle,
  browser: BrowserInfo,
  route: string,
): Promise<MetricResult[]> {
  const samples: RouteAudit[] = []

  // Per-route warm-up (see LIGHTHOUSE_WARMUP) — outcome deliberately discarded.
  await runOnce(server, browser, route)

  for (let i = 0; i < LIGHTHOUSE_SAMPLES; i += 1) {
    const outcome = await runOnce(server, browser, route)
    if ('error' in outcome) {
      return ['lcp', 'tbt', 'fcp', 'transfer_size'].map((kind) => ({
        id: `${kind as 'lcp'}:${route}` as MetricResult['id'],
        status: 'skipped' as const,
        label: `${kind.toUpperCase().replace('_SIZE', ' size')} ${route}`,
        reason: outcome.error,
      }))
    }
    samples.push(outcome)
  }

  const med = (pick: (a: RouteAudit) => number) => median(samples.map(pick))
  const raw = (pick: (a: RouteAudit) => number) => samples.map(pick)
  const collectedBy = `median of ${LIGHTHOUSE_SAMPLES} lighthouse runs after ${LIGHTHOUSE_WARMUP} discarded per-route warm-up (${LIGHTHOUSE_PROFILE}, ${browser.signature}) against the built app`

  return [
    metric(`lcp:${route}`, `LCP ${route}`, med((a) => a.lcpMs), 'ms', raw((a) => a.lcpMs), collectedBy),
    metric(`tbt:${route}`, `TBT ${route}`, med((a) => a.tbtMs), 'ms', raw((a) => a.tbtMs), collectedBy),
    metric(`fcp:${route}`, `FCP ${route}`, med((a) => a.fcpMs), 'ms', raw((a) => a.fcpMs), collectedBy),
    metric(
      `transfer_size:${route}`,
      `transfer size ${route}`,
      med((a) => a.transferBytes),
      'bytes',
      raw((a) => a.transferBytes),
      collectedBy,
    ),
  ]
}

function metric(
  id: MetricResult['id'],
  label: string,
  value: number,
  unit: 'ms' | 'bytes',
  sampleValues: number[],
  collectedBy: string,
): MetricResult {
  return {
    id,
    status: 'measured',
    value,
    unit,
    label,
    collectedBy,
    samples: sampleValues.length,
    sampleValues,
  }
}

async function runOnce(
  server: ServerHandle,
  browser: BrowserInfo,
  route: string,
): Promise<RouteAudit | { error: string }> {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  // Our own user-data-dir so chrome-err.log is readable on failure — a dead browser must
  // explain itself in the skip reason, not just leave a refused connection.
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'driftwatch-chrome-'))
  const chromeErrTail = async () => {
    try {
      const log = await readFile(path.join(userDataDir, 'chrome-err.log'), 'utf8')
      const lines = log.trim().split('\n')
      // Crash logs put the fatal reason at the TOP and a register dump at the bottom — keep both.
      if (lines.length <= 40) return lines.join('\n')
      return [...lines.slice(0, 12), `… (${lines.length - 40} lines elided) …`, ...lines.slice(-28)].join('\n')
    } catch {
      return '(no chrome-err.log)'
    }
  }
  let chrome: { kill: () => Promise<void> | void; port: number } | null = null
  let probe = '(probe not run)'
  try {
    const { launch } = await import('chrome-launcher')
    chrome = await launch({ chromePath: browser.path, chromeFlags: CHROME_FLAGS, userDataDir, logLevel: 'silent' })

    // Diagnostic probe: our own fetch of the endpoint lighthouse is about to use. If we succeed
    // where lighthouse fails, the browser is fine and the failure is in the client; if we see
    // ok-then-refused, the browser dies shortly after listening. Rides in the skip reason.
    const attempts: string[] = []
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const res = await fetch(`http://127.0.0.1:${chrome.port}/json/version`, { signal: AbortSignal.timeout(3000) })
        const body = (await res.text()).slice(0, 80)
        attempts.push(`#${attempt} HTTP ${res.status} ${body}`)
        break
      } catch (error) {
        attempts.push(`#${attempt} ${(error as Error).message}: ${((error as Error & { cause?: Error }).cause?.message ?? 'no cause')}`)
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    }
    probe = attempts.join(' | ')

    const { default: lighthouse } = await import('lighthouse')
    const result = await lighthouse(`${server.url}${route}`, {
      port: chrome.port,
      output: 'json',
      logLevel: 'silent',
      onlyAudits: ['largest-contentful-paint', 'total-blocking-time', 'first-contentful-paint', 'total-byte-weight'],
      formFactor: 'desktop',
      screenEmulation: { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1, disabled: false },
      throttlingMethod: 'simulate',
    })

    const audits = result?.lhr?.audits
    const value = (name: string) => audits?.[name]?.numericValue
    const lcp = value('largest-contentful-paint')
    const tbt = value('total-blocking-time')
    const fcp = value('first-contentful-paint')
    const transfer = value('total-byte-weight')
    if ([lcp, tbt, fcp, transfer].some((v) => typeof v !== 'number')) {
      const failed = audits
        ? Object.values(audits).find((a) => a.errorMessage)?.errorMessage
        : undefined
      return { error: `lighthouse produced no numeric value${failed ? `: ${failed}` : ''}` }
    }
    return {
      lcpMs: Math.round(lcp!),
      tbtMs: Math.round(tbt!),
      fcpMs: Math.round(fcp!),
      transferBytes: Math.round(transfer!),
    }
  } catch (error) {
    return {
      error: `lighthouse run failed: ${(error as Error).message}; cause chain: ${causeChain(error)}; version probe: ${probe}; chrome stderr:\n${await chromeErrTail()}`,
    }
  } finally {
    await chrome?.kill()
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {})
  }
}

/** undici's "fetch failed" hides the real error in a cause chain — walk it all. */
function causeChain(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 6 && current instanceof Error; depth += 1) {
    const code = (current as Error & { code?: string }).code
    if (depth > 0) parts.push(`${current.name}: ${current.message}${code ? ` [${code}]` : ''}`)
    if (current instanceof AggregateError) {
      for (const inner of current.errors.slice(0, 4)) {
        const innerCode = (inner as Error & { code?: string }).code
        parts.push(`  agg: ${(inner as Error).message}${innerCode ? ` [${innerCode}]` : ''}`)
      }
    }
    current = (current as Error & { cause?: unknown }).cause
  }
  return parts.length > 0 ? parts.join(' → ') : '(no cause)'
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)
}
