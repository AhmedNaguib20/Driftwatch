/**
 * The analysis block of the result JSON — contract types only.
 *
 * Core OWNS this shape (the result JSON is the contract; conventions) but never produces it:
 * src/ai/ imports these types and returns them, the CLI attaches the block. Core has no runtime
 * dependency on ai/ — `--no-ai` never loads that module graph.
 */

/** Why a file's patch content is or is not in an analysis context. */
export type FileDisposition = 'full' | 'truncated' | 'diffstat-only' | 'withheld' | 'binary'

export interface ManifestEntry {
  readonly path: string
  readonly disposition: FileDisposition
  readonly insertions: number
  readonly deletions: number
  readonly reason: string | null
}

/** Exactly what was sent to the provider, per file — the per-run privacy statement (spec §7.1). */
export interface ContextManifest {
  readonly files: readonly ManifestEntry[]
  readonly lockfiles: readonly string[]
  readonly estimatedTokens: number
  readonly budgetTokens: number
  readonly truncated: boolean
}

export interface StageStats {
  readonly provider: string
  readonly model: string
  readonly tokens: { readonly input: number; readonly output: number }
  readonly durationMs: number
  readonly promptVersion: number
  /** True when the first response was malformed and the corrective retry was used. */
  readonly retried: boolean
}

export interface AnalysisFix {
  readonly kind: 'diff' | 'prose'
  readonly content: string
  /** Set when driftwatch downgraded a diff to prose (confidence bar or unknown files). */
  readonly note?: string
  /**
   * The machine-applicable diff, kept regardless of display kind (spec v35, second de-gating):
   * the confidence bar decides how a fix is SHOWN, never what verification may measure — a
   * measured outcome is stronger evidence than the model's self-confidence. Absent when the
   * model gave prose, or when its diff touched files it was never shown: confinement is a
   * safety guarantee, not a display choice, so such a diff is never measured either.
   */
  readonly diff?: string
}

/** The diff verification may measure, wherever the display rules put the fix. */
export function machineDiff(fix: AnalysisFix): string | null {
  return fix.diff ?? (fix.kind === 'diff' ? fix.content : null)
}

/**
 * Every way the analysis stage can end. The measurement verdict NEVER changes based on this
 * block — analysis annotates the result, it does not overrule it.
 *
 *  - analysed: the two-stage flow completed.
 *  - inconclusive: triage concluded this diff does not explain the regression (a useful answer).
 *  - not_applicable: there was no regression to explain. Not a failure, not a degraded run, and
 *    NOT something any human surface mentions — a keyless user must not read about a tier they
 *    did not ask for on every clean run (spec §9e).
 *  - skipped: a provider or transport failure, with the reason. This one IS reported: we tried,
 *    it cost something, and hiding it would be rule 3 in reverse.
 *  - cost_capped: the projected cost exceeded `max_cost_per_run`, so nothing was sent. A refusal
 *    the user configured — distinct from `skipped` (something went wrong) and from
 *    `not_applicable` (nothing to do), because distinct facts get distinct names.
 *  - no_key: a regression was found but DRIFTWATCH_API_KEY is not set. Not an error.
 *  - disabled: --no-ai / DRIFTWATCH_NO_AI — the ai module graph was never loaded.
 */
export type AnalysisReport =
  | {
      readonly outcome: 'analysed'
      readonly cause: string
      readonly confidence: number
      readonly evidence: readonly string[]
      readonly fix: AnalysisFix
      readonly suspects: readonly { readonly path: string; readonly reason: string }[]
      readonly stages: { readonly triage: StageStats; readonly deep: StageStats }
      readonly context: { readonly triage: ContextManifest; readonly deep: ContextManifest }
      /**
       * What it was projected to cost, beside what it did. Reported on every analysed run so the
       * token model is audited by reality rather than by argument — if it is systematically off,
       * that shows up in the field instead of being assumed away.
       */
      readonly cost?: {
        readonly projectedUsd: number | null
        readonly actualUsd: number | null
        readonly projectedTokens: { readonly input: number; readonly output: number }
        readonly actualTokens: { readonly input: number; readonly output: number }
      }
    }
  | {
      readonly outcome: 'inconclusive'
      /** Deep analysis's own conclusion that the diff does not explain the regression (v2+). */
      readonly stopReason: string
      readonly stages: { readonly triage: StageStats; readonly deep?: StageStats }
      readonly context: { readonly triage: ContextManifest; readonly deep?: ContextManifest }
    }
  | {
      readonly outcome: 'skipped'
      readonly reason: string
      /**
       * What the failed attempt cost, when it reached the provider at all (spec v50). A failed
       * call still spent tokens and still used a prompt version — dropping them hides the spend
       * and the provenance, and provenance is exactly what a misdiagnosed failure needs.
       */
      readonly spend?: {
        readonly stage: 'triage' | 'deep'
        readonly provider: string
        readonly model: string
        readonly promptVersion: number
        readonly tokens: { readonly input: number; readonly output: number }
      }
    }
  | {
      readonly outcome: 'cost_capped'
      /**
       * Both numbers, so the reader can see how far over it was. Null when the model has no
       * published price: an unpriced projection cannot be SHOWN to be under the cap, and a cap
       * that cannot be honoured is not quietly ignored (spec §9e step C).
       */
      readonly projectedUsd: number | null
      readonly capUsd: number
      /** The arithmetic behind the projection, in words. */
      readonly basis: string
    }
  | { readonly outcome: 'not_applicable' }
  | { readonly outcome: 'no_key' }
  | { readonly outcome: 'disabled' }
