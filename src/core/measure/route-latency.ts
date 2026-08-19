import { performance } from 'node:perf_hooks'
import type { MetricResult } from './types.js'
import { ROUTE_SAMPLES, ROUTE_WARMUP_SAMPLES } from './protocol.js'
import type { ServerHandle } from './serve.js'

/**
 * Request-level route latency (Layer 2a, request kind). Per route: one discarded warm-up (first
 * hit fills per-process caches — the same §5.1 logic as builds), then ROUTE_SAMPLES sequential
 * requests, median reported, raw samples recorded. SEQUENTIAL always: parallel requests contend
 * on the same server and §5.1 dies.
 */

/** A 500-route app must not mean 500 measurements. */
export const ROUTE_LIMIT = 5

/**
 * Static priority: '/' first, then shortest paths (they are the app's most-trafficked shape and
 * keep selection deterministic). Dynamic segments ([slug]) have no concrete URL to fetch — they
 * are skipped with a reason, not guessed at.
 */
export function selectRoutes(routes: readonly string[]): {
  selected: string[]
  skipped: { route: string; reason: string }[]
} {
  const skipped = routes
    .filter((r) => r.includes('['))
    .map((route) => ({ route, reason: 'dynamic segment — no concrete URL to measure' }))

  const concrete = routes.filter((r) => !r.includes('['))
  const ordered = [...concrete].sort((a, b) => {
    if (a === '/') return -1
    if (b === '/') return 1
    return a.length - b.length || (a < b ? -1 : 1)
  })

  const selected = ordered.slice(0, ROUTE_LIMIT)
  for (const route of ordered.slice(ROUTE_LIMIT)) {
    skipped.push({ route, reason: `beyond the ${ROUTE_LIMIT}-route measurement cap` })
  }
  return { selected, skipped }
}

export async function measureRoutes(
  server: ServerHandle,
  routes: readonly string[],
  progress: (message: string) => void = () => {},
): Promise<MetricResult[]> {
  const { selected, skipped } = selectRoutes(routes)
  const metrics: MetricResult[] = []

  for (const route of selected) {
    progress(`route ${route}: warm-up + ${ROUTE_SAMPLES} samples…`)
    metrics.push(await measureRoute(server, route))
  }
  for (const { route, reason } of skipped) {
    metrics.push({
      id: `route_latency:${route}`,
      status: 'skipped',
      label: `route ${route}`,
      reason,
    })
  }
  return metrics
}

async function measureRoute(server: ServerHandle, route: string): Promise<MetricResult> {
  const url = `${server.url}${route}`
  const samples: number[] = []

  for (let i = 0; i < ROUTE_WARMUP_SAMPLES + ROUTE_SAMPLES; i += 1) {
    const outcome = await timeRequest(url)
    if (!outcome.ok) {
      return {
        id: `route_latency:${route}`,
        status: 'skipped',
        label: `route ${route}`,
        reason: `${outcome.reason}; last server output:\n${server.logsTail().split('\n').slice(-6).join('\n')}`,
      }
    }
    if (i >= ROUTE_WARMUP_SAMPLES) samples.push(outcome.fullMs)
  }

  const sorted = [...samples].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const median =
    sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)

  return {
    id: `route_latency:${route}`,
    status: 'measured',
    value: median,
    unit: 'ms',
    label: `route ${route}`,
    collectedBy: `median of ${ROUTE_SAMPLES} sequential requests after ${ROUTE_WARMUP_SAMPLES} discarded warm-up, full response time against the built app`,
    samples: ROUTE_SAMPLES,
    sampleValues: samples,
  }
}

async function timeRequest(
  url: string,
): Promise<{ ok: true; fullMs: number } | { ok: false; reason: string }> {
  const started = performance.now()
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: 'manual' })
    if (response.status !== 200) {
      await response.arrayBuffer().catch(() => {})
      return { ok: false, reason: `route answered HTTP ${response.status}` }
    }
    await response.arrayBuffer()
    return { ok: true, fullMs: Math.round(performance.now() - started) }
  } catch (error) {
    return { ok: false, reason: `request failed: ${(error as Error).message}` }
  }
}
