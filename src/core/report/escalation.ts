import type { ResultJson } from './types.js'

/**
 * The §5.1 fifth-instance decision: may a cached-base comparison be reported as-is, or must both
 * sides be re-measured fresh in the same invocation first?
 *
 * Time-based metrics drift with the machine (thermals, background load), so a delta against a
 * base measured half an hour ago can be pure drift. Byte counts don't drift — bundle_size never
 * triggers escalation. Only floor-crossing deltas escalate: skipped and not_comparable rows have
 * no delta to confirm, and under-floor rows are already "no change".
 */
export function requiresConfirmation(result: ResultJson): boolean {
  return result.comparison.metrics.some(
    (m) => m.unit === 'ms' && (m.verdict === 'regressed' || m.verdict === 'improved'),
  )
}
