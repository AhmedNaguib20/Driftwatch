import pc from 'picocolors'
import type { AnalysisReport, StageStats } from '../core/index.js'

/**
 * Renders the analysis block. Tone rules: confidence is always the number plus a calibrated
 * word — never "definitely", never a bare adjective. Inconclusive is framed as information, not
 * failure. Downgrade notes are shown: the user should know a diff was held back and why.
 */

export function renderAnalysis(
  analysis: AnalysisReport,
  estimateCost: (stage: StageStats) => number | null,
): string {
  switch (analysis.outcome) {
    case 'disabled':
      return ''
    case 'no_key':
      return [
        '',
        pc.dim('AI analysis: a regression was found, but no API key is set, so driftwatch cannot'),
        pc.dim('explain it. Analysis reads the diff and names the likely cause, with a suggested fix.'),
        pc.dim('To enable:  export DRIFTWATCH_API_KEY=<your DeepSeek or OpenAI key>   (see README, "AI analysis")'),
      ].join('\n')
    case 'skipped':
      return `\n${pc.dim(`AI analysis skipped: ${analysis.reason}`)}`
    case 'inconclusive':
      return [
        '',
        pc.bold('AI analysis: inconclusive — and that is informative'),
        `  ${pc.yellow('the diff does not explain this regression.')} The model's reason, verbatim:`,
        `  ${pc.italic(`"${analysis.stopReason}"`)}`,
        `  ${pc.dim('Likely places to look instead: dependencies, configuration, build environment.')}`,
        statsFooter([analysis.stages.triage], estimateCost),
      ].join('\n')
    case 'analysed':
      return renderAnalysed(analysis, estimateCost)
  }
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
  const costText = total !== null ? ` · est. cost $${total.toFixed(4)}` : ''
  return pc.dim(
    `  ${first.provider} (${stages.map((s) => s.model).filter((v, i, a) => a.indexOf(v) === i).join(', ')}) · prompts v${first.promptVersion} · ${parts.join(' · ')}${costText}`,
  )
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  return `${(n / 1000).toFixed(1)}k`
}
