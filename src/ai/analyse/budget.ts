/**
 * Token budgets — code constants, like BUILD_SAMPLES: properties of the instrument, not
 * preferences. Sized to the spec §7 cost model (~10-20K input tokens per deep analysis).
 */

/** Triage is the cheap gate — diffstat and numbers, no patch content. */
export const TRIAGE_BUDGET_TOKENS = 4_000

/** Deep analysis carries patches for the suspect files. */
export const DEEP_BUDGET_TOKENS = 24_000

/** Below this many remaining tokens a truncated patch is noise — omit instead. */
export const MIN_PATCH_TOKENS = 500

/** A single file's patch never eats more than this, however large the file. */
export const MAX_PATCH_TOKENS_PER_FILE = 8_000

/**
 * chars/4 — the standard rough estimate for English-plus-code. It is an ESTIMATE and is labelled
 * as such everywhere it surfaces; we never present it as a measured count (rule 3). Measured
 * counts come back from the provider per call.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}
