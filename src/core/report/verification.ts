/**
 * The verification block — measurement closing the trust loop on the AI's own fix (M6).
 *
 * A suggested diff is applied to a FRESH copy of the current side and measured through the same
 * path, same invocation: a third side, under every §5.1 discipline. The verdicts below are
 * measured facts, not opinions — which is exactly why only they may later justify a fix PR.
 */

export type VerificationMetricVerdict = 'restored' | 'partial' | 'no-recovery'

export interface VerificationMetric {
  readonly id: string
  readonly label: string
  readonly unit: 'ms' | 'bytes' | null
  readonly base: number | null
  readonly current: number
  readonly fixed: number
  /**
   * restored: fixed within floor/quantum of BASE. no-recovery: fixed within floor/quantum of
   * CURRENT (a fix that made things worse also lands here — the numbers say so). partial:
   * meaningfully recovered, not to base.
   */
  readonly verdict: VerificationMetricVerdict
}

export type VerificationOutcome =
  | 'restored' // every regressed metric restored
  | 'partial' // real recovery, not complete
  | 'no-recovery'
  | 'build-broken' // the fixed copy does not build/boot — log tail in reason
  | 'not-applicable' // the diff does not apply cleanly — git's own output in reason
  | 'refused' // §5.1: the third side's protocol did not match — verification refuses itself
  | 'skipped' // gates not met (no diff fix, confidence under the bar, --no-verify, …)

export interface VerificationReport {
  readonly outcome: VerificationOutcome
  /** Present for build-broken / not-applicable / refused / skipped. */
  readonly reason: string | null
  /** Only the metrics that regressed — verification measures nothing else (cost control). */
  readonly metrics: readonly VerificationMetric[]
  /** The exact diff that was measured — it is now measurement-backed evidence. */
  readonly diff: string | null
  readonly elapsedMs: number
  /**
   * True when DRIFTWATCH_DEV_FIX_DIFF substituted the analysis diff before verification (the
   * permanent testing seam for the negative case). Stamped into every surface so no screenshot
   * of an overridden run can ever pass as organic.
   */
  readonly devOverride?: true
}
