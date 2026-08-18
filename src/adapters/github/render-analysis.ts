import type { AnalysisReport, ResultJson } from '../../core/index.js'
import { confidenceLabel, formatTokens } from './format.js'

/** The AI section of the PR comment. Honesty rules match the CLI renderer: number + calibrated
 * word, downgrade notes shown, inconclusive framed as information. */

export function renderAnalysisSection(result: ResultJson): string[] {
  const analysis = result.analysis
  if (!analysis) return []

  switch (analysis.outcome) {
    case 'disabled':
      return ['', '_AI analysis disabled for this run._']
    case 'no_key':
      return [
        '',
        '_A regression was found but no `DRIFTWATCH_API_KEY` is available (normal for fork PRs), ' +
          'so there is no analysis of the cause. The measurement above stands on its own._',
      ]
    case 'skipped':
      return ['', `_AI analysis skipped: ${analysis.reason.split('\n')[0]}_`]
    case 'inconclusive':
      return [
        '',
        '### Analysis: the diff does not explain this regression',
        '',
        `> ${analysis.stopReason}`,
        '',
        '_That is the model\'s own conclusion after reading the patches — likely places to look: dependencies, configuration, build environment._',
      ]
    case 'analysed':
      return renderAnalysed(analysis)
  }
}

function renderAnalysed(analysis: Extract<AnalysisReport, { outcome: 'analysed' }>): string[] {
  const lines: string[] = []

  lines.push('')
  lines.push(`### Likely cause  \`confidence ${confidenceLabel(analysis.confidence)}\``)
  lines.push('')
  lines.push(analysis.cause)
  lines.push('')
  lines.push('**Evidence**')
  for (const item of analysis.evidence) {
    lines.push(`- ${item}`)
  }

  lines.push('')
  lines.push(analysis.fix.kind === 'diff' ? '**Suggested fix** (ready diff)' : '**Suggested fix**')
  if (analysis.fix.note) {
    lines.push('')
    lines.push(`> note: ${analysis.fix.note}`)
  }
  lines.push('')
  if (analysis.fix.kind === 'diff') {
    lines.push('```diff')
    lines.push(analysis.fix.content.trimEnd())
    lines.push('```')
  } else {
    lines.push(analysis.fix.content.trim())
  }

  const whyNot = whyNotHigher(analysis)
  if (whyNot.length > 0) {
    lines.push('')
    lines.push('<details>')
    lines.push(`<summary>Why ${Math.round(analysis.confidence * 100)}% and not higher</summary>`)
    lines.push('')
    for (const reason of whyNot) lines.push(`- ${reason}`)
    lines.push('')
    lines.push('</details>')
  }

  return lines
}

/**
 * §6.1 asks for a collapsed "why not higher" naming what we could not isolate. Only facts we
 * actually hold are listed — other ranked suspects, truncated context, a downgraded fix. If the
 * data gives no reason (or confidence is already in the top band), the block is omitted rather
 * than padded with boilerplate.
 */
function whyNotHigher(analysis: Extract<AnalysisReport, { outcome: 'analysed' }>): string[] {
  if (analysis.confidence >= 0.9) return []
  const reasons: string[] = []

  const others = analysis.suspects.slice(1)
  if (others.length > 0) {
    reasons.push(
      `Other changed files could contribute and were not isolated separately: ${others
        .map((s) => `\`${s.path}\``)
        .join(', ')}.`,
    )
  }
  if (analysis.context.deep.truncated) {
    reasons.push('Some patches were truncated to fit the context budget — the model did not see every changed line.')
  }
  if (analysis.fix.note) {
    reasons.push(`The proposed fix was downgraded: ${analysis.fix.note}.`)
  }
  return reasons
}

export function renderAnalysisFooterParts(analysis: AnalysisReport | undefined): string[] {
  if (!analysis || (analysis.outcome !== 'analysed' && analysis.outcome !== 'inconclusive')) {
    return []
  }
  const stages =
    analysis.outcome === 'analysed'
      ? [analysis.stages.triage, analysis.stages.deep]
      : [analysis.stages.triage, ...(analysis.stages.deep ? [analysis.stages.deep] : [])]

  const first = stages[0]!
  const models = [...new Set(stages.map((s) => s.model))].join(', ')
  const tokens = stages.reduce(
    (sum, s) => ({ input: sum.input + s.tokens.input, output: sum.output + s.tokens.output }),
    { input: 0, output: 0 },
  )
  return [
    `analysed by ${first.provider} (${models})`,
    `prompts v${first.promptVersion}`,
    `${formatTokens(tokens.input)}→${formatTokens(tokens.output)} tokens`,
  ]
}
