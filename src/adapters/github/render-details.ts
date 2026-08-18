import type { ContextManifest, MetricResult, ResultJson } from '../../core/index.js'
import { formatValue } from './format.js'

/** The collapsed heavy-detail blocks (§6.1: heavy detail inside <details>). */

export function renderAllMetrics(result: ResultJson): string {
  const lines: string[] = ['<details>', '<summary>All metrics</summary>', '']
  for (const side of ['base', 'current'] as const) {
    const report = result[side]
    if (!('metrics' in report)) continue
    lines.push(`**${side === 'base' ? 'Base' : 'This PR'}**`)
    for (const metric of report.metrics) {
      lines.push(renderMetricLine(metric))
    }
    lines.push('')
  }
  lines.push('</details>')
  return lines.join('\n')
}

function renderMetricLine(metric: MetricResult): string {
  if (metric.status === 'skipped') {
    return `- ${metric.label}: skipped — ${metric.reason.split('\n')[0]}`
  }
  const samples = metric.sampleValues ? ` (samples: ${metric.sampleValues.join(', ')})` : ''
  return `- ${metric.label}: ${formatValue(metric.value, metric.unit)}${samples} — ${metric.collectedBy}`
}

export function renderHowMeasured(result: ResultJson): string {
  const lines: string[] = ['<details>', '<summary>How this was measured</summary>', '']

  if ('protocol' in result.current) {
    const p = result.current.protocol
    lines.push(
      `Both sides build cold in disposable copies (never your working directory): ` +
        `${p.buildSamples} timed builds after ${p.warmupSamples} discarded warm-up, median reported. ` +
        `Node ${p.nodeVersion} on ${p.platform}/${p.arch}.`,
    )
  }
  lines.push(
    `Deltas under ${result.config.noiseFloorPercent}% are treated as measurement noise and reported as "no change". ` +
      `Threshold for calling a regression: ${result.config.thresholdPercent}%.`,
  )

  const path = result.comparison.measurementPath
  lines.push(
    path === 'confirmed'
      ? 'A cached-baseline comparison crossed the noise floor, so BOTH sides were re-measured fresh in the same run — the numbers above never span a time gap.'
      : path === 'screened'
        ? 'Baseline served from cache; every delta stayed under the noise floor.'
        : 'Both sides were measured fresh in this run.',
  )

  if (!result.comparison.protocolsMatch) {
    lines.push('')
    lines.push('**Protocols differed between the sides — deltas were refused, not computed:**')
    for (const mismatch of result.comparison.protocolMismatches) {
      lines.push(`- ${mismatch}`)
    }
  }

  lines.push('', '</details>')
  return lines.join('\n')
}

/** What was sent to the AI provider — the contextManifest as reader-facing accounting. */
export function renderWhatWasSent(result: ResultJson): string | null {
  const analysis = result.analysis
  if (!analysis || (analysis.outcome !== 'analysed' && analysis.outcome !== 'inconclusive')) {
    return null
  }
  const manifest: ContextManifest =
    analysis.outcome === 'analysed' ? analysis.context.deep : (analysis.context.deep ?? analysis.context.triage)

  const lines: string[] = [
    '<details>',
    '<summary>What was sent to the AI provider</summary>',
    '',
    'Measurement numbers, raw samples, protocols, the evidence trail, a diffstat, and:',
    '',
  ]
  for (const file of manifest.files) {
    const label =
      file.disposition === 'full'
        ? 'full patch'
        : file.disposition === 'truncated'
          ? 'patch (truncated)'
          : file.disposition === 'withheld'
            ? '**content withheld** (secret pattern)'
            : file.disposition === 'binary'
              ? 'not sent (binary)'
              : 'diffstat line only'
    lines.push(`- \`${file.path}\` — ${label}${file.reason && file.disposition !== 'full' ? ` — ${file.reason}` : ''}`)
  }
  lines.push('')
  lines.push(`~${manifest.estimatedTokens} tokens (estimate) of a ${manifest.budgetTokens}-token budget.`)
  lines.push('', '</details>')
  return lines.join('\n')
}
