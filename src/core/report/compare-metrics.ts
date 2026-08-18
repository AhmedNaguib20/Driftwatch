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

/** Every M1 metric is a cost: more milliseconds, more bytes — higher is worse. */
const METRIC_ORDER: readonly MetricId[] = ['install_time', 'build_time', 'bundle_size']

/**
 * Absolute resolution of wall-clock timing. Process spawn alone jitters 5-10ms and a package
 * manager adds tens more (measured: a 15ms script spreads 43% run to run), so a time delta under
 * this quantum is unresolvable regardless of what it is as a percentage. Only bites when 2% of
 * the build is under 100ms — i.e. builds shorter than ~5s; the percent floor governs real builds.
 */
const MIN_TIME_DELTA_MS = 100

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
  const ids = [...METRIC_ORDER].filter(
    (id) => base.some((m) => m.id === id) || current.some((m) => m.id === id),
  )
  return ids.map((id) =>
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
    return { ...shell, delta: null, verdict: 'skipped', exceedsThreshold: false, reason: skipReason }
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

  if (shell.unit === 'ms' && Math.abs(absolute) < MIN_TIME_DELTA_MS) {
    return {
      ...shell,
      delta: null,
      verdict: 'no_change',
      exceedsThreshold: false,
      reason: `time delta is under the ${MIN_TIME_DELTA_MS}ms timing resolution`,
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
