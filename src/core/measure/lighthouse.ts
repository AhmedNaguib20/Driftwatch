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
export const LIGHTHOUSE_PROFILE = 'simulated/desktop/v2'

/**
 * The warm-up law (spec v24): every fresh execution context runs its first iteration slow —
 * discard it. Measured here: the first Lighthouse run after a fresh boot traced LCP 2707ms vs a
 * 1702ms steady state. One discarded run per side, before any samples.
 */
export const LIGHTHOUSE_WARMUP = 1

/** Lighthouse runs cost ~5-10s each — cap harder than route latency. */
export const LIGHTHOUSE_ROUTE_LIMIT = 3

/** Samples per route; provisional until the spread gate decides (same as every K before it). */
export const LIGHTHOUSE_SAMPLES = 3

const CHROME_FLAGS = [
  '--headless=new',
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

  if (routes.length > 0) {
    progress('lighthouse warm-up run (discarded)…')
    await runOnce(server, browser, routes[0]!) // outcome deliberately ignored — see LIGHTHOUSE_WARMUP
  }

  for (const route of routes) {
    progress(`lighthouse ${route}: ${LIGHTHOUSE_SAMPLES} runs…`)
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
  const collectedBy = `median of ${LIGHTHOUSE_SAMPLES} lighthouse runs after ${LIGHTHOUSE_WARMUP} discarded warm-up (${LIGHTHOUSE_PROFILE}, ${browser.signature}) against the built app`

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
  let chrome: { kill: () => Promise<void> | void; port: number } | null = null
  try {
    const { launch } = await import('chrome-launcher')
    chrome = await launch({ chromePath: browser.path, chromeFlags: CHROME_FLAGS })

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
    return { error: `lighthouse run failed: ${(error as Error).message}` }
  } finally {
    await chrome?.kill()
  }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)
}
