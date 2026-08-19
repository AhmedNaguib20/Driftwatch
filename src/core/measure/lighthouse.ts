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
      return log.trim().split('\n').slice(-6).join('\n')
    } catch {
      return '(no chrome-err.log)'
    }
  }
  let chrome: { kill: () => Promise<void> | void; port: number } | null = null
  try {
    const { launch } = await import('chrome-launcher')
    chrome = await launch({ chromePath: browser.path, chromeFlags: CHROME_FLAGS, userDataDir, logLevel: 'silent' })

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
    return { error: `lighthouse run failed: ${(error as Error).message}; chrome stderr:\n${await chromeErrTail()}` }
  } finally {
    await chrome?.kill()
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {})
  }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)
}
