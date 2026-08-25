import { AI_KEY_ENV, tierMention } from '../../core/index.js'
import type { AnalysisReport, ResultJson } from '../../core/index.js'
import { confidenceLabel, formatTokens, formatValue } from './format.js'

/** The AI section of the PR comment. Honesty rules match the CLI renderer: number + calibrated
 * word, downgrade notes shown, inconclusive framed as information. */

export function renderAnalysisSection(result: ResultJson, fromFork = false): string[] {
  const analysis = result.analysis
  if (!analysis) return []

  switch (analysis.outcome) {
    // Silent, exactly as the terminal is: a clean run and a deliberately disabled run both say
    // nothing about the tier. The outcome stays in the result JSON either way (spec §9e).
    case 'disabled':
    case 'not_applicable':
      return []
    case 'no_key': {
      const mention = tierMention({ fixTier: result.config.auto_fix === 'propose' })
      // One mention, and it must be true for the reader it reaches: a fork PR cannot see
      // repository secrets, so its author is not missing a setting — the run simply had no key.
      const how = fromFork
        ? `This PR comes from a fork, and repository secrets are not exposed to fork runs — so analysis does not run here even when the key is set.`
        : `To enable it, set \`${AI_KEY_ENV}\` in the workflow's secrets.`
      return [
        '',
        `_Driftwatch measured this without a key. Explaining a regression is the optional AI tier, ` +
          `which runs on your own key: ${mention.what} ${how} The measurement above stands on its own._`,
      ]
    }
    case 'skipped':
      return [
        '',
        `_AI analysis skipped: ${analysis.reason.split('\n')[0]}_`,
        // The remedy, when there is one, in the same collapsed shape the comment uses for every
        // other fix stanza — the words are identical to what `driftwatch doctor` prints.
        ...(analysis.fix
          ? ['', '<details>', '<summary>What to do about it</summary>', '', '```', ...analysis.fix.split('\n'), '```', '', '</details>']
          : []),
      ]
    case 'cost_capped':
      return [
        '',
        `_AI analysis was not run: projected **${analysis.projectedUsd === null ? 'unpriced' : `$${analysis.projectedUsd.toFixed(4)}`}** ` +
          `against this repository's \`max_cost_per_run\` of **$${analysis.capUsd.toFixed(4)}**. The projection is an upper bound ` +
          `(${analysis.basis}), so driftwatch refused early rather than overspending. Raise the cap in perf.yml, or analyse a ` +
          `narrower diff. The measurement above is unaffected._`,
      ]
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
      return renderAnalysed(analysis, result.verification)
  }
}

function renderAnalysed(
  analysis: Extract<AnalysisReport, { outcome: 'analysed' }>,
  verification: ResultJson['verification'],
): string[] {
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

  // Spec v35: a diff displayed as prose (confidence bar) that then VERIFIES gets the diff
  // display back, carrying its measured numbers — measurement earned it what confidence couldn't.
  const upgraded = verifiedUpgrade(analysis, verification)

  lines.push('')
  if (upgraded) {
    const outcome = verification!.outcome === 'restored' ? 'restored' : 'partial recovery'
    lines.push(`**Suggested fix** (diff verified by measurement: ${outcome})`)
    lines.push('')
    lines.push(
      `> shown as a ready diff although model confidence is below the display bar — measurement verified it: ${measuredSummary(verification!)}.`,
    )
    lines.push('')
    lines.push('```diff')
    lines.push(analysis.fix.diff!.trimEnd())
    lines.push('```')
  } else {
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
  }

  const whyNot = whyNotHigher(analysis, upgraded)
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

/** The upgrade applies only when the display was held back by the confidence bar (diff survives
 * in fix.diff) AND measurement then proved the fix — restored or partial. */
function verifiedUpgrade(
  analysis: Extract<AnalysisReport, { outcome: 'analysed' }>,
  verification: ResultJson['verification'],
): boolean {
  return (
    analysis.fix.kind === 'prose' &&
    analysis.fix.diff !== undefined &&
    (verification?.outcome === 'restored' || verification?.outcome === 'partial')
  )
}

function measuredSummary(verification: NonNullable<ResultJson['verification']>): string {
  return verification.metrics
    .map(
      (m) =>
        `${m.label} ${formatValue(m.current, m.unit ?? 'bytes')} → ${formatValue(m.fixed, m.unit ?? 'bytes')} (${
          m.verdict === 'restored'
            ? 'restored'
            : m.verdict === 'partial'
              ? 'partial'
              : m.verdict === 'indistinguishable'
                ? 'within noise resolution'
                : 'no recovery'
        })`,
    )
    .join(', ')
}

/**
 * §6.1 asks for a collapsed "why not higher" naming what we could not isolate. Only facts we
 * actually hold are listed — other ranked suspects, truncated context, a downgraded fix. If the
 * data gives no reason (or confidence is already in the top band), the block is omitted rather
 * than padded with boilerplate.
 */
function whyNotHigher(analysis: Extract<AnalysisReport, { outcome: 'analysed' }>, upgraded = false): string[] {
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
  if (analysis.fix.note && !upgraded) {
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
