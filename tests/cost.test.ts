import { describe, expect, it } from 'vitest'

import { renderAnalysis } from '../src/cli/render-analysis.js'
import { renderAnalysisSection } from '../src/adapters/github/render-analysis.js'
import { analysisCostCeiling, projectAnalysisCost, TRIAGE_OUTPUT_TOKENS_PER_FILE } from '../src/ai/cost.js'
import { parseUsd } from '../src/core/index.js'
import type { AnalysisReport, ResultJson } from '../src/core/index.js'

/**
 * Cost projection and `max_cost_per_run` (spec §9e step C).
 *
 * The projection is an UPPER BOUND by construction, and the tests hold it to that: the one thing
 * it must never do is understate, because a ceiling that lets a run through and then costs more
 * is the surprise the ceiling exists to prevent.
 */

const PROVIDER = 'deepseek'
const MODEL = 'deepseek-chat'

describe('the projection is an upper bound, audited against a real run', () => {
  it('brackets the largest eval case: 31 changed files, measured $0.0130', () => {
    // run-a of the eval set, the case M9 was built around. Triage context is given its budget
    // ceiling, which is the worst case for a diff that size.
    const projection = projectAnalysisCost({
      provider: PROVIDER,
      model: MODEL,
      triageContextTokens: 8_000,
      changedFiles: 31,
    })

    expect(projection.usd).not.toBeNull()
    // Never understates — the property the cap depends on.
    expect(projection.usd!).toBeGreaterThan(0.013)
    // And is not so loose as to be useless: within 4x of what the run actually cost.
    expect(projection.usd!).toBeLessThan(0.013 * 4)
  })

  it('scales triage output with the file count, and stops at the M9 cap', () => {
    const small = projectAnalysisCost({ provider: PROVIDER, model: MODEL, triageContextTokens: 1_000, changedFiles: 1 })
    const large = projectAnalysisCost({ provider: PROVIDER, model: MODEL, triageContextTokens: 1_000, changedFiles: 40 })
    const huge = projectAnalysisCost({ provider: PROVIDER, model: MODEL, triageContextTokens: 1_000, changedFiles: 5_000 })

    expect(large.tokens.output - small.tokens.output).toBe(39 * TRIAGE_OUTPUT_TOKENS_PER_FILE)
    // A 5000-file diff cannot project unbounded output: the cap is what the run would enforce.
    expect(huge.tokens.output).toBe(3_200 + 6_000)
    expect(small.basis).toContain('measured')
  })

  it('never prices a model it has no published price for', () => {
    const projection = projectAnalysisCost({
      provider: PROVIDER,
      model: 'model-we-have-never-priced',
      triageContextTokens: 1_000,
      changedFiles: 3,
    })
    expect(projection.usd).toBeNull()
    expect(projection.tokens.input).toBeGreaterThan(0)
  })

  it('doctor and the run share one piece of arithmetic', () => {
    const ceiling = analysisCostCeiling(PROVIDER, MODEL)
    const projection = projectAnalysisCost({
      provider: PROVIDER,
      model: MODEL,
      triageContextTokens: 8_000,
      changedFiles: 1_000,
    })
    // The worst case a projection can reach IS the ceiling doctor prints.
    expect(projection.tokens).toEqual(ceiling.tokens)
    expect(projection.usd).toBe(ceiling.usd)
  })
})

describe('max_cost_per_run parsing', () => {
  it('accepts an amount with or without a dollar sign, and rejects anything else', () => {
    expect(parseUsd('0.05')).toBe(0.05)
    expect(parseUsd('$0.05')).toBe(0.05)
    expect(parseUsd(null)).toBeNull()
    expect(parseUsd('free')).toBeNull()
    expect(parseUsd('0')).toBeNull()
    expect(parseUsd('-1')).toBeNull()
  })
})

describe('the cost_capped outcome', () => {
  const capped: AnalysisReport = {
    outcome: 'cost_capped',
    projectedUsd: 0.0262,
    capUsd: 0.01,
    basis: 'triage 8,000 in (measured) + 1,457 out (31 changed file(s) x 47/file, M9); deep bounded by its 24,000 budget and 6,000 cap',
  }

  it('the terminal says it once, names both numbers, and gives the two remedies', () => {
    const rendered = renderAnalysis(capped, () => null, false)

    expect([...rendered.matchAll(/max_cost_per_run/g)]).toHaveLength(1)
    expect(rendered).toContain('$0.0262')
    expect(rendered).toContain('$0.0100')
    expect(rendered).toContain('raise the cap')
    expect(rendered).toContain('narrow the diff')
    // The verdict is a measurement fact and is untouched by a spending decision.
    expect(rendered).toContain('measurement above is unaffected')
  })

  it('the PR comment says it once too, and never as an error', () => {
    const result = { analysis: capped, config: { auto_fix: 'off' } } as unknown as ResultJson
    const section = renderAnalysisSection(result).join('\n')

    expect([...section.matchAll(/max_cost_per_run/g)]).toHaveLength(1)
    expect(section).toContain('$0.0262')
    expect(section).toContain('$0.0100')
    expect(section).not.toMatch(/error|failed/i)
  })

  it('an unpriced projection is stated as unpriced, never as a number', () => {
    const unpriced: AnalysisReport = { ...capped, projectedUsd: null }

    expect(renderAnalysis(unpriced, () => null, false)).toContain('could not be priced')
    expect(renderAnalysisSection({ analysis: unpriced, config: { auto_fix: 'off' } } as unknown as ResultJson).join('\n')).toContain(
      'unpriced',
    )
  })
})

describe('an analysed run reports actual beside projected', () => {
  it('shows both, so the model is audited by reality on every run', () => {
    const analysed = {
      outcome: 'analysed',
      cause: 'lodash',
      confidence: 0.9,
      evidence: ['e'],
      fix: { kind: 'prose', content: 'x' },
      suspects: [],
      cost: {
        projectedUsd: 0.0262,
        actualUsd: 0.013,
        projectedTokens: { input: 32_000, output: 7_457 },
        actualTokens: { input: 11_000, output: 2_295 },
      },
      stages: {
        triage: { provider: PROVIDER, model: MODEL, tokens: { input: 8_000, output: 1_741 }, durationMs: 1, promptVersion: 2, retried: false },
        deep: { provider: PROVIDER, model: MODEL, tokens: { input: 3_000, output: 554 }, durationMs: 1, promptVersion: 2, retried: false },
      },
      context: {
        triage: { files: [], lockfiles: [], estimatedTokens: 0, budgetTokens: 0, truncated: false },
        deep: { files: [], lockfiles: [], estimatedTokens: 0, budgetTokens: 0, truncated: false },
      },
    } as unknown as AnalysisReport

    const rendered = renderAnalysis(analysed, () => 0.0065, false)

    expect(rendered).toContain('projected $0.0262')
    expect(rendered).toContain('actual $0.0130')
    expect(rendered).toContain('11000→2295 tok vs 32000→7457 projected')
  })
})
