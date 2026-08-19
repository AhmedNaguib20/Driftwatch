import type { MetricId } from '../detect/types.js'
import { NOISE_FLOOR_PERCENT } from '../detect/config-schema.js'
import { quantumFor } from '../report/compare-metrics.js'
import type {
  VerificationMetric,
  VerificationMetricVerdict,
  VerificationOutcome,
} from '../report/verification.js'

/**
 * The three-way math: fixed vs base vs current, judged with the SAME floor and per-class quanta
 * as every other comparison — "equal to base" means what "no change" means everywhere else.
 */

export function assessMetric(input: {
  id: string
  label: string
  unit: 'ms' | 'bytes' | null
  base: number | null
  current: number
  fixed: number
}): VerificationMetric {
  return { ...input, verdict: verdictFor(input) }
}

function verdictFor(input: {
  id: string
  unit: 'ms' | 'bytes' | null
  base: number | null
  current: number
  fixed: number
}): VerificationMetricVerdict {
  const quantum = quantumFor(input.id as MetricId, input.unit)
  // The noise radius around a value: the same floor-OR-quantum rule "no change" uses everywhere.
  const radius = (x: number) => Math.max(quantum, (NOISE_FLOOR_PERCENT / 100) * Math.abs(x))
  const within = (a: number, b: number) => (b === 0 ? a === 0 : Math.abs(a - b) < radius(b))

  // Resolution gate first: when the regression's own magnitude fits inside the combined noise
  // radii, base-like and current-like cannot be told apart at this metric's resolution — no
  // fixed value can certify recovery OR its absence. Without this gate the verdict was
  // order-dependent for values within noise of both sides (the live Run B TBT wobble).
  if (
    input.base !== null &&
    Math.abs(input.current - input.base) <= radius(input.base) + radius(input.current)
  ) {
    return 'indistinguishable'
  }

  // The fix must measurably move the metric off current before any recovery claim.
  if (within(input.fixed, input.current)) return 'no-recovery'
  if (input.base !== null && within(input.fixed, input.base)) return 'restored'
  // Moved meaningfully off current: recovery counts only in the right direction — a fix that
  // made things worse than current is no-recovery (the numbers show the direction).
  const recovered =
    input.base !== null
      ? (input.current - input.fixed) / (input.current - input.base || 1)
      : input.current > input.fixed
        ? 1
        : -1
  return recovered > 0 ? 'partial' : 'no-recovery'
}

/**
 * Indistinguishable rows can never upgrade the outcome: recovery is claimed only on rows whose
 * regression was resolvable. All-restored among resolvable rows is 'restored' only when every
 * row was resolvable — with unknowns in the mix, 'partial' is the most the evidence supports.
 */
export function overallOutcome(metrics: readonly VerificationMetric[]): VerificationOutcome {
  if (metrics.length === 0) return 'no-recovery'
  const certifiable = metrics.filter((m) => m.verdict !== 'indistinguishable')
  if (certifiable.length === 0) return 'no-recovery'
  if (certifiable.every((m) => m.verdict === 'restored')) {
    return certifiable.length === metrics.length ? 'restored' : 'partial'
  }
  if (certifiable.every((m) => m.verdict === 'no-recovery')) return 'no-recovery'
  return 'partial'
}
