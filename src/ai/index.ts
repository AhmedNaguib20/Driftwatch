import type { AnalysisReport, ResultJson } from '../core/index.js'
import { gatherDiffData } from './analyse/gather.js'
import { runAnalysis } from './analyse/run-analysis.js'
import { createProvider, resolveApiKey } from './providers/index.js'

/**
 * The ai/ module's front door — loaded DYNAMICALLY by the CLI, and only when analysis will
 * actually run. Under --no-ai / DRIFTWATCH_NO_AI / no-key, nothing in this module graph is ever
 * imported (hard rule 6: `--no-ai` is a fully offline run, provably).
 */
export async function analyseRegression(
  result: ResultJson,
  progress: (message: string) => void = () => {},
): Promise<AnalysisReport> {
  const apiKey = resolveApiKey()
  if (!apiKey) return { outcome: 'no_key' }

  let provider
  try {
    provider = createProvider({
      provider: result.config.provider,
      model: result.config.model,
      apiKey,
    })
  } catch (error) {
    return { outcome: 'skipped', reason: (error as Error).message }
  }

  progress(`gathering diff ${result.base.available ? result.base.sha.slice(0, 12) : ''} → working tree…`)
  const diffData = await gatherDiffData(result)
  if ('unavailable' in diffData) {
    return { outcome: 'skipped', reason: diffData.unavailable }
  }

  progress(`triage: asking ${provider.name} whether the diff explains the regression…`)
  const analysis = await runAnalysis(result, diffData, provider, progress)
  return analysis
}

export { PROMPT_VERSION } from './analyse/prompts.js'
export { estimateCostUsd } from './providers/pricing.js'
