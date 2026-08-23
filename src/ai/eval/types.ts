/**
 * Eval-set types (spec §7.2). A case is a captured real regression: the measured result JSON,
 * the collected diff data, and expectations. Cases run against the LIVE provider — the point is
 * judging prompt changes on real model behavior, so results are only comparable across identical
 * PROMPT_VERSIONs.
 */

export interface EvalExpectation {
  /** Required analysis outcome. */
  readonly outcome: 'analysed' | 'inconclusive'
  /** Paths that must appear among triage's suspects (analysed only). */
  readonly suspectsInclude?: readonly string[]
  /** Keywords that must ALL appear in the cause, case-insensitive. */
  readonly causeMustContain?: readonly string[]
  /** At least ONE of these must appear in the cause. */
  readonly causeAnyOf?: readonly string[]
  readonly confidence?: { readonly min: number; readonly max: number }
  readonly fix?: {
    /** At least one of these strings must appear in the fix content. */
    readonly mustMentionAnyOf?: readonly string[]
    /** When the fix is a diff, it may only touch these paths. */
    readonly diffMayOnlyTouch?: readonly string[]
  }
}

export interface EvalCaseResult {
  readonly name: string
  readonly passed: boolean
  readonly checks: readonly { readonly check: string; readonly ok: boolean; readonly detail: string }[]
  readonly tokens: { readonly input: number; readonly output: number }
  /** Output tokens per stage — the measurement the M9 caps were sized against. */
  readonly stageOutput: readonly { readonly stage: string; readonly output: number }[]
  readonly costUsd: number | null
  readonly durationMs: number
  readonly promptVersion: number | null
}
