import pc from 'picocolors'
import { attachAnalysis, runDriftwatch } from '../core/index.js'
import type { AnalysisReport, ResultJson, StageStats } from '../core/index.js'
import { renderAnalysis } from './render-analysis.js'
import { renderResult } from './render-table.js'

/**
 * `driftwatch run` — measurement, then (conditionally) analysis, then rendering.
 *
 * stdout carries the deliverable (table, or with --json the schema JSON and NOTHING else, so it
 * pipes cleanly); progress goes to stderr. Exit 0 always in M1/M2 (warn-only).
 *
 * The ai/ module graph loads via dynamic import on exactly one path: AI enabled AND a regression
 * AND a key present. --no-ai / DRIFTWATCH_NO_AI / missing key never load it — that is what makes
 * `--no-ai` a provably offline run (hard rule 6).
 */

/** Deliberately duplicated from ai/providers — reading it here must not load the ai graph. */
const API_KEY_ENV = 'DRIFTWATCH_API_KEY'
const NO_AI_ENV = 'DRIFTWATCH_NO_AI'

export interface RunFlags {
  readonly base?: string
  readonly json: boolean
  readonly cache: boolean
  readonly ai: boolean
  readonly cwd?: string
}

export async function runCommand(flags: RunFlags): Promise<void> {
  const progress = (message: string) => {
    console.error(pc.dim(`\u2192 ${message}`))
  }

  try {
    const measured = await runDriftwatch({
      cwd: flags.cwd,
      base: flags.base,
      readCache: flags.cache,
      progress,
    })

    const result = attachAnalysis(measured, await resolveAnalysis(measured, flags, progress))

    if (flags.json) {
      console.log(JSON.stringify(result, null, 2))
      return
    }

    console.log(renderResult(result))
    if (result.analysis) {
      const rendered = renderAnalysis(result.analysis, await costEstimator(result.analysis))
      if (rendered) console.log(rendered)
    }
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
    console.error(pc.red(`driftwatch could not complete the run: ${message}`))
    console.error(pc.red('This is a driftwatch failure, not a verdict about your code.'))
    if (flags.json) {
      console.log(JSON.stringify({ error: 'driftwatch failed before producing a result' }))
    }
  }
}

async function resolveAnalysis(
  result: ResultJson,
  flags: RunFlags,
  progress: (message: string) => void,
): Promise<AnalysisReport> {
  if (!flags.ai || process.env[NO_AI_ENV] === '1') return { outcome: 'disabled' }
  if (result.verdict !== 'regression') {
    return { outcome: 'skipped', reason: 'analysis runs only on a regression verdict' }
  }
  if (!process.env[API_KEY_ENV]?.trim()) return { outcome: 'no_key' }

  // The ONLY entry into the ai/ module graph.
  const ai = await import('../ai/index.js')
  return ai.analyseRegression(result, progress)
}

/** Cost rates live in the ai graph; when it never loaded, there is no cost to estimate. */
async function costEstimator(
  analysis: AnalysisReport,
): Promise<(stage: StageStats) => number | null> {
  if (analysis.outcome !== 'analysed' && analysis.outcome !== 'inconclusive') return () => null
  const ai = await import('../ai/index.js')
  return (stage) => ai.estimateCostUsd(stage.provider, stage.model, stage.tokens)
}
