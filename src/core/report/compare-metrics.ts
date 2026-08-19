import type { MetricId } from '../detect/types.js'
import type { MetricResult } from '../measure/types.js'
import type { MetricComparison, MetricVerdict } from './types.js'

/**
 * Per-metric comparison and verdicts.
 *
 * Two lines, two jobs (config-schema.ts): the noise floor decides whether a delta is REPORTED at
 * all; the threshold decides whether a reported regression drives the run verdict. A delta under
 * the floor is not shown even in the JSON — hard rule 4 applies to the contract, not just the
 * terminal.
 */

/** Every metric is a cost: more milliseconds, more bytes — higher is worse. */
const FIXED_ORDER: readonly MetricId[] = ['install_time', 'build_time', 'bundle_size']

/** Fixed metrics first, then per-route classes in a stable class order — deterministic table. */
const ROUTE_CLASS_ORDER = ['route_latency:', 'lcp:', 'tbt:', 'fcp:', 'transfer_size:'] as const

function orderedIds(base: readonly MetricResult[], current: readonly MetricResult[]): MetricId[] {
  const present = new Set<MetricId>([...base, ...current].map((m) => m.id))
  const fixed = FIXED_ORDER.filter((id) => present.has(id))
  const classes = ROUTE_CLASS_ORDER.flatMap((prefix) =>
    [...present].filter((id) => id.startsWith(prefix)).sort(),
  )
  return [...fixed, ...classes]
}

/**
 * Per-class absolute quanta — each metric class carries its own instrument resolution (spec §5
 * quantum table; code constants, never config). A single global quantum would gut whichever class
 * it wasn't calibrated for: 100ms would suppress a 4ms route regressing 25x. Bases are measured,
 * never guessed:
 *
 *  - build_time 100ms: process spawn jitters 5-10ms, package managers add tens more.
 *  - route_latency 5ms: observed ±1ms sequential-fetch noise, x5.
 *  - lcp/fcp 25ms: ≤7ms spread across boots under simulated throttling.
 *  - tbt 50ms: values quantize near zero; real TBT regressions are tens-to-hundreds of ms.
 *  - transfer_size 1KB (bytes): ±2 bytes observed; ≥1KB is a real asset change.
 */
function quantumFor(id: MetricId, unit: 'ms' | 'bytes' | null): number {
  if (unit === 'bytes') return id.startsWith('transfer_size:') ? 1024 : 0
  if (id.startsWith('route_latency:')) return 5
  if (id.startsWith('lcp:') || id.startsWith('fcp:')) return 25
  if (id.startsWith('tbt:')) return 50
  return 100
}

export interface CompareOptions {
  readonly noiseFloorPercent: number
  readonly thresholdPercent: number
  /** Non-empty ⇒ protocols mismatch ⇒ every metric is not_comparable (§5.1). */
  readonly protocolMismatches: readonly string[]
}

export function compareMetrics(
  base: readonly MetricResult[],
  current: readonly MetricResult[],
  options: CompareOptions,
): MetricComparison[] {
  return orderedIds(base, current).map((id) =>
    compareOne(
      base.find((m) => m.id === id) ?? null,
      current.find((m) => m.id === id) ?? null,
      id,
      options,
    ),
  )
}

function compareOne(
  base: MetricResult | null,
  current: MetricResult | null,
  id: MetricId,
  options: CompareOptions,
): MetricComparison {
  const label = current?.label ?? base?.label ?? id
  const shell = {
    id,
    label,
    unit: pickUnit(base, current),
    base: base?.status === 'measured' ? base.value : null,
    current: current?.status === 'measured' ? current.value : null,
  }

  const skipReason = skippedReason(base, current)
  if (skipReason) {
    // Policy exclusions (SSG, dynamic segments, user-disabled layers) are excluded on every side
    // that has the row; a failed measurement is not — only the latter gates the run verdict.
    const policyOnly = [base, current]
      .filter((m): m is MetricResult => m !== null)
      .every((m) => m.status === 'skipped' && m.excluded === true)
    return {
      ...shell,
      delta: null,
      verdict: 'skipped',
      exceedsThreshold: false,
      reason: skipReason,
      ...(policyOnly ? { excluded: true } : {}),
    }
  }

  // §5.1 enforcement: mismatched protocols → no delta, ever. The exact fields are named so the
  // reader knows what to fix rather than just that something is off.
  if (options.protocolMismatches.length > 0) {
    return {
      ...shell,
      delta: null,
      verdict: 'not_comparable',
      exceedsThreshold: false,
      reason: `the two sides were measured under different protocols — ${options.protocolMismatches.join('; ')}`,
    }
  }

  // §5.1 sixth instance: within one invocation the base side installs first (cold package-manager
  // cache), current second (warm). When both sides measured a fresh install, the cache states
  // cannot be shown equal — values reported, delta refused.
  if (id === 'install_time') {
    return {
      ...shell,
      delta: null,
      verdict: 'not_comparable',
      exceedsThreshold: false,
      reason: 'package-manager cache state differs between sides (base installs first, cold; current second, warm)',
    }
  }

  const baseValue = shell.base!
  const currentValue = shell.current!

  if (baseValue === 0) {
    if (currentValue === 0) {
      return { ...shell, delta: null, verdict: 'no_change', exceedsThreshold: false, reason: 'both sides measured 0' }
    }
    return {
      ...shell,
      delta: null,
      verdict: 'not_comparable',
      exceedsThreshold: false,
      reason: 'baseline measured 0 — a percentage delta is undefined',
    }
  }

  const absolute = currentValue - baseValue
  const percent = (absolute / baseValue) * 100

  if (Math.abs(percent) < options.noiseFloorPercent) {
    return {
      ...shell,
      delta: null,
      verdict: 'no_change',
      exceedsThreshold: false,
      reason: `delta is under the ${options.noiseFloorPercent}% noise floor`,
    }
  }

  const quantum = quantumFor(id, shell.unit)
  if (quantum > 0 && Math.abs(absolute) < quantum) {
    return {
      ...shell,
      delta: null,
      verdict: 'no_change',
      exceedsThreshold: false,
      reason: `delta is under this metric class's ${quantum}${shell.unit === 'bytes' ? ' byte' : 'ms'} resolution`,
    }
  }

  const verdict: MetricVerdict = absolute > 0 ? 'regressed' : 'improved'
  return {
    ...shell,
    delta: { absolute, percent: round2(percent) },
    verdict,
    // The threshold applies to regressions only; improvements never need to clear a bar.
    exceedsThreshold: verdict === 'regressed' && Math.abs(percent) >= options.thresholdPercent,
    reason: null,
  }
}

function skippedReason(base: MetricResult | null, current: MetricResult | null): string | null {
  const parts: string[] = []
  if (!base || base.status === 'skipped') {
    parts.push(`base: ${base ? base.reason : 'metric not collected'}`)
  }
  if (!current || current.status === 'skipped') {
    parts.push(`current: ${current ? current.reason : 'metric not collected'}`)
  }
  return parts.length > 0 ? parts.join(' | ') : null
}

function pickUnit(
  base: MetricResult | null,
  current: MetricResult | null,
): 'ms' | 'bytes' | null {
  if (current?.status === 'measured') return current.unit
  if (base?.status === 'measured') return base.unit
  return null
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
