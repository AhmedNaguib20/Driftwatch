import { DEEP_BUDGET_TOKENS, TRIAGE_BUDGET_TOKENS } from './analyse/budget.js'
import { DEEP_MAX_OUTPUT, TRIAGE_MAX_OUTPUT } from './analyse/run-analysis.js'
import { estimateCostUsd } from './providers/pricing.js'
import type { TokenUsage } from './providers/index.js'

/**
 * What an analysis will cost, before it is spent (spec §9e step C).
 *
 * One piece of arithmetic serves two callers — `doctor`, which prints the ceiling, and the run
 * itself, which projects this particular diff. They must not drift apart: a cap that refuses on
 * one set of numbers while the diagnostic quotes another is worse than no cap at all.
 *
 * **Every projection is an UPPER BOUND, and says so.** Triage input is measured exactly (the
 * context is already assembled when the projection is made); everything else is bounded by the
 * constants the code enforces. That direction is deliberate: a cap exists to prevent surprises,
 * so it must overstate rather than understate. The gap is not hidden — every analysed run reports
 * projected beside actual, which is how the model gets audited by reality instead of by argument.
 */

/**
 * Measured at M9: triage output scales with the diff's FILE COUNT, because it ranks one suspect
 * per plausibly-relevant changed file with a one-sentence reason. Modelled against the four eval
 * cases and validated live — a 31-file diff modelled 1559 and produced 1741.
 */
export const TRIAGE_OUTPUT_TOKENS_PER_FILE = 47

export interface CostProjection {
  readonly tokens: TokenUsage
  /** Null when driftwatch has no published price for the model — never a guessed number. */
  readonly usd: number | null
  /** The arithmetic, in words, so any surface can show its working. */
  readonly basis: string
}

/** The most any single analysed regression can cost: both budgets in, both output caps out. */
export function analysisCostCeiling(provider: string, model: string): CostProjection {
  const tokens = {
    input: TRIAGE_BUDGET_TOKENS + DEEP_BUDGET_TOKENS,
    output: TRIAGE_MAX_OUTPUT + DEEP_MAX_OUTPUT,
  }
  return {
    tokens,
    usd: estimateCostUsd(provider, model, tokens),
    basis: `context budgets ${n(TRIAGE_BUDGET_TOKENS)} + ${n(DEEP_BUDGET_TOKENS)} in, output caps ${n(TRIAGE_MAX_OUTPUT)} + ${n(DEEP_MAX_OUTPUT)} out`,
  }
}

export interface ProjectionInput {
  readonly provider: string
  readonly model: string
  /** Exact: the triage context is assembled before the first call is made. */
  readonly triageContextTokens: number
  /** Changed files in the diff — what triage's output scales with. */
  readonly changedFiles: number
}

/**
 * This run's projection. Triage is modelled from measurements; deep is bounded by its budget and
 * cap, because what deep will be shown depends on which suspects triage names — which has not
 * happened yet when this is computed.
 */
export function projectAnalysisCost(input: ProjectionInput): CostProjection {
  const triageOutput = Math.min(input.changedFiles * TRIAGE_OUTPUT_TOKENS_PER_FILE, TRIAGE_MAX_OUTPUT)
  const tokens = {
    input: input.triageContextTokens + DEEP_BUDGET_TOKENS,
    output: triageOutput + DEEP_MAX_OUTPUT,
  }
  return {
    tokens,
    usd: estimateCostUsd(input.provider, input.model, tokens),
    basis:
      `triage ${n(input.triageContextTokens)} in (measured) + ${n(triageOutput)} out ` +
      `(${input.changedFiles} changed file(s) x ${TRIAGE_OUTPUT_TOKENS_PER_FILE}/file, M9); ` +
      `deep bounded by its ${n(DEEP_BUDGET_TOKENS)} budget and ${n(DEEP_MAX_OUTPUT)} cap`,
  }
}

/** Spend that actually happened, for reporting beside the projection. */
export function actualCost(provider: string, model: string, tokens: TokenUsage): CostProjection {
  return { tokens, usd: estimateCostUsd(provider, model, tokens), basis: 'measured' }
}

export function formatUsd(usd: number | null): string {
  if (usd === null) return 'cost unknown'
  if (usd > 0 && usd < 0.0001) return 'under $0.0001'
  return `$${usd.toFixed(4)}`
}

function n(value: number): string {
  return value.toLocaleString('en-US')
}
