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
  const within = (a: number, b: number) => {
    if (b === 0) return a === 0
    const percent = Math.abs(((a - b) / b) * 100)
    const absolute = Math.abs(a - b)
    return percent < NOISE_FLOOR_PERCENT || (quantum > 0 && absolute < quantum)
  }

  if (input.base !== null && within(input.fixed, input.base)) return 'restored'
  if (within(input.fixed, input.current)) return 'no-recovery'
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

export function overallOutcome(metrics: readonly VerificationMetric[]): VerificationOutcome {
  if (metrics.length === 0) return 'no-recovery'
  if (metrics.every((m) => m.verdict === 'restored')) return 'restored'
  if (metrics.every((m) => m.verdict === 'no-recovery')) return 'no-recovery'
  return 'partial'
}
