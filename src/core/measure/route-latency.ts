import { readFile } from 'node:fs/promises'
import path from 'node:path'
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
 * Reads which routes the build prerendered (Next: .next/prerender-manifest.json). Unreadable
 * manifest → empty set: routes are then measured rather than silently excluded.
 */
export async function prerenderedRoutes(
  workspaceDir: string,
  buildOutputDirs: readonly string[],
): Promise<ReadonlySet<string>> {
  for (const dir of buildOutputDirs) {
    try {
      const manifest = JSON.parse(
        await readFile(path.join(workspaceDir, dir, 'prerender-manifest.json'), 'utf8'),
      ) as { routes?: Record<string, unknown> }
      return new Set(Object.keys(manifest.routes ?? {}))
    } catch {
      /* try next dir / fall through */
    }
  }
  return new Set()
}

/**
 * Route-latency scope (spec §5 scope note): prerendered routes measure the file server, not the
 * app — excluded by default (their regressions surface in client_bundle_size; client cost lands with
 * Lighthouse). Dynamic/SSR routes first, '/' leads its group, shortest next — deterministic.
 * Dynamic segments ([slug]) have no concrete URL and are skipped, not guessed at.
 */
export function selectRoutes(
  routes: readonly string[],
  prerendered: ReadonlySet<string> = new Set(),
): {
  selected: string[]
  skipped: { route: string; reason: string }[]
} {
  const skipped = routes
    .filter((r) => r.includes('['))
    .map((route) => ({ route, reason: 'dynamic segment — no concrete URL to measure' }))

  const concrete = routes.filter((r) => !r.includes('['))
  const byPriority = (a: string, b: string) => {
    if (a === '/') return -1
    if (b === '/') return 1
    return a.length - b.length || (a < b ? -1 : 1)
  }
  const dynamic = concrete.filter((r) => !prerendered.has(r)).sort(byPriority)
  const staticRoutes = concrete.filter((r) => prerendered.has(r)).sort(byPriority)

  for (const route of staticRoutes) {
    skipped.push({
      route,
      reason:
        'prerendered (SSG) — served as static files; excluded from route_latency (regressions surface in client_bundle_size / Lighthouse)',
    })
  }

  const selected = dynamic.slice(0, ROUTE_LIMIT)
  for (const route of dynamic.slice(ROUTE_LIMIT)) {
    skipped.push({ route, reason: `beyond the ${ROUTE_LIMIT}-route measurement cap` })
  }
  return { selected, skipped }
}

/** Measures exactly the routes given — selection (SSG exclusion, cap) happens in the caller. */
export async function measureRoutes(
  server: ServerHandle,
  selected: readonly string[],
  progress: (message: string) => void = () => {},
): Promise<MetricResult[]> {
  const metrics: MetricResult[] = []
  for (const route of selected) {
    progress(`route ${route}: warm-up + ${ROUTE_SAMPLES} samples…`)
    metrics.push(await measureRoute(server, route))
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
