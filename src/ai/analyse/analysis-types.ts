import type { ContextManifest } from './types.js'

/** Per-stage accounting — model, cost, duration, and the prompt version that produced it. */
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
}

/** The analysis block. The measurement verdict NEVER changes based on any of this. */
export type Analysis =
  | {
      readonly outcome: 'analysed'
      readonly cause: string
      readonly confidence: number
      readonly evidence: readonly string[]
      readonly fix: AnalysisFix
      readonly suspects: readonly { readonly path: string; readonly reason: string }[]
      readonly stages: { readonly triage: StageStats; readonly deep: StageStats }
      readonly context: { readonly triage: ContextManifest; readonly deep: ContextManifest }
    }
  | {
      readonly outcome: 'inconclusive'
      /** The model's own reason why this diff does not explain the regression. */
      readonly stopReason: string
      readonly stages: { readonly triage: StageStats }
      readonly context: { readonly triage: ContextManifest }
    }
  | {
      readonly outcome: 'skipped'
      readonly reason: string
    }
