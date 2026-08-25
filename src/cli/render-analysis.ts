import pc from 'picocolors'
import { tierMention } from '../core/index.js'
import type { AnalysisReport, StageStats } from '../core/index.js'

/**
 * Renders the analysis block. Tone rules: confidence is always the number plus a calibrated
 * word — never "definitely", never a bare adjective. Inconclusive is framed as information, not
 * failure. Downgrade notes are shown: the user should know a diff was held back and why.
 */

export function renderAnalysis(
  analysis: AnalysisReport,
  estimateCost: (stage: StageStats) => number | null,
  /** True when `auto_fix: propose` is configured: the same key unlocks the fix tier, and saying
   *  so in the same breath keeps this ONE mention rather than two (spec §9e). */
  fixTier = false,
): string {
  switch (analysis.outcome) {
    // Silent by design (spec §9e): a run with nothing to explain, or with the tier turned off,
    // says nothing about the tier at all. Both states remain in the JSON for machine consumers.
    case 'disabled':
    case 'not_applicable':
      return ''
    case 'no_key': {
      const mention = tierMention({ fixTier })
      return [
        '',
        pc.dim('A regression was found. Driftwatch measures without a key; explaining a regression'),
        pc.dim('is the optional AI tier, which runs on your own key.'),
        pc.dim(`  ${mention.what}`),
        pc.dim(`  To enable:  ${mention.how}   (see README, "AI analysis")`),
      ].join('\n')
    }
    case 'skipped':
      return `\n${pc.dim(`AI analysis skipped: ${analysis.reason}`)}`
    case 'cost_capped':
      return [
        '',
        pc.yellow('AI analysis was not run: it would have cost more than this repository allows.'),
        pc.dim(`  projected  ${money(analysis.projectedUsd)}   ·   cap  $${analysis.capUsd.toFixed(4)}   (max_cost_per_run, perf.yml)`),
        pc.dim(`  ${analysis.basis}`),
        pc.dim('  The projection is an upper bound, so this refuses early rather than overspending.'),
        pc.dim('  Either raise the cap, or narrow the diff this run analyses'),
        pc.dim('  (a smaller changeset costs proportionally less). The measurement above is unaffected.'),
      ].join('\n')
    case 'inconclusive':
      return [
        '',
        pc.bold('AI analysis: inconclusive — and that is informative'),
        `  ${pc.yellow('the diff does not explain this regression.')} The model's reason, verbatim:`,
        `  ${pc.italic(`"${analysis.stopReason}"`)}`,
        `  ${pc.dim('Likely places to look instead: dependencies, configuration, build environment.')}`,
        statsFooter(
          analysis.stages.deep
            ? [analysis.stages.triage, analysis.stages.deep]
            : [analysis.stages.triage],
          estimateCost,
        ),
      ].join('\n')
    case 'analysed':
      return renderAnalysed(analysis, estimateCost)
  }
}

/** A projection that could not be priced is stated as such, never as a number. */
function money(usd: number | null): string {
  return usd === null ? 'could not be priced for this model' : `$${usd.toFixed(4)}`
}

function renderAnalysed(
  analysis: Extract<AnalysisReport, { outcome: 'analysed' }>,
  estimateCost: (stage: StageStats) => number | null,
): string {
  const lines: string[] = ['', pc.bold('AI analysis')]

  lines.push(`  ${pc.bold('cause')}       ${analysis.cause}`)
  lines.push(`  ${pc.bold('confidence')}  ${renderConfidence(analysis.confidence)}`)

  lines.push(`  ${pc.bold('evidence')}`)
  for (const item of analysis.evidence) {
    lines.push(`    - ${item}`)
  }

  const fixLabel = analysis.fix.kind === 'diff' ? 'suggested fix (ready diff)' : 'suggested fix'
  lines.push(`  ${pc.bold(fixLabel)}`)
  if (analysis.fix.note) {
    lines.push(`    ${pc.yellow(`note: ${analysis.fix.note}`)}`)
  }
  lines.push(renderFixContent(analysis.fix.kind, analysis.fix.content))

  lines.push(statsFooter([analysis.stages.triage, analysis.stages.deep], estimateCost))
  // Projected beside actual, every run: the token model gets audited by reality rather than by
  // argument, and a user watching both learns what an analysis actually costs them (spec §9e).
  if (analysis.cost) {
    lines.push(
      pc.dim(
        `  projected ${money(analysis.cost.projectedUsd)} (upper bound) · actual ${money(analysis.cost.actualUsd)}` +
          ` · ${analysis.cost.actualTokens.input}→${analysis.cost.actualTokens.output} tok vs ${analysis.cost.projectedTokens.input}→${analysis.cost.projectedTokens.output} projected`,
      ),
    )
  }
  return lines.join('\n')
}

/** The number always shows; the word is calibrated, never inflated. */
export function renderConfidence(confidence: number): string {
  const pct = `${Math.round(confidence * 100)}%`
  if (confidence >= 0.9) return pc.green(`${pct} (high)`)
  if (confidence >= 0.7) return pc.green(`${pct} (likely)`)
  if (confidence >= 0.5) return pc.yellow(`${pct} (possible)`)
  return pc.yellow(`${pct} (low — treat as a lead, not a conclusion)`)
}

function renderFixContent(kind: 'diff' | 'prose', content: string): string {
  const indent = '    '
  if (kind !== 'diff') {
    return content
      .split('\n')
      .map((line) => indent + line)
      .join('\n')
  }
  return content
    .split('\n')
    .map((line) => {
      if (line.startsWith('+') && !line.startsWith('+++')) return indent + pc.green(line)
      if (line.startsWith('-') && !line.startsWith('---')) return indent + pc.red(line)
      if (line.startsWith('@@')) return indent + pc.cyan(line)
      return indent + pc.dim(line)
    })
    .join('\n')
}

function statsFooter(
  stages: readonly StageStats[],
  estimateCost: (stage: StageStats) => number | null,
): string {
  const names = ['triage', 'deep']
  const parts = stages.map((stage, i) => {
    const cost = estimateCost(stage)
    return `${names[i]} ${formatTokens(stage.tokens.input)}→${formatTokens(stage.tokens.output)} tok${cost !== null ? '' : ' (cost unknown)'}`
  })
  const total = stages.reduce((sum, s) => {
    const cost = estimateCost(s)
    return cost === null || sum === null ? null : sum + cost
  }, 0 as number | null)
  const first = stages[0]!
  const costText = total !== null ? ` · cost $${total.toFixed(4)}` : ''
  return pc.dim(
    `  ${first.provider} (${stages.map((s) => s.model).filter((v, i, a) => a.indexOf(v) === i).join(', ')}) · prompts v${first.promptVersion} · ${parts.join(' · ')}${costText}`,
  )
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  return `${(n / 1000).toFixed(1)}k`
}
