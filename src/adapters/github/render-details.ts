import type { ContextManifest, MetricResult, ResultJson } from '../../core/index.js'
import { formatValue } from './format.js'

/** The collapsed heavy-detail blocks (§6.1: heavy detail inside <details>). */

/**
 * The exhaustive per-side accounting — step-summary territory (email evidence: Gmail expands
 * <details>, and this block alone was ~50 lines). Methodology is described ONCE per metric: the
 * two sides collect identically BY CONSTRUCTION (§5.1 — a real difference refuses the delta), so
 * repeating the sentence per side was pure duplication. Per-side lines carry values + samples.
 */
export function renderAllMetrics(result: ResultJson): string {
  const base = 'metrics' in result.base ? result.base.metrics : []
  const current = 'metrics' in result.current ? result.current.metrics : []
  const ids = [...new Set([...base, ...current].map((m) => m.id))]

  const lines: string[] = ['## All metrics', '']
  for (const id of ids) {
    const b = base.find((m) => m.id === id) ?? null
    const c = current.find((m) => m.id === id) ?? null
    const label = c?.label ?? b?.label ?? id

    const how = dedupedMethodology(b, c)
    lines.push(`**${label}**${how ? ` — ${how}` : ''}`)
    lines.push(sideLine('Base', b))
    lines.push(sideLine('This PR', c))
    lines.push('')
  }
  return lines.join('\n')
}

/** Strips the per-side workspace word; identical otherwise by construction. Differing
 *  methodologies (should be impossible without a refused delta) are both shown, flagged. */
function dedupedMethodology(base: MetricResult | null, current: MetricResult | null): string {
  const normalize = (m: MetricResult | null) =>
    m?.status === 'measured' ? m.collectedBy.replace(/ in a (worktree|copy)/g, '') : null
  const b = normalize(base)
  const c = normalize(current)
  if (b !== null && c !== null && b !== c) return `⚠ sides differ: base "${b}" vs current "${c}"`
  return b ?? c ?? ''
}

function sideLine(name: string, metric: MetricResult | null): string {
  if (!metric) return `- ${name}: not collected`
  if (metric.status === 'skipped') {
    return `- ${name}: skipped — ${metric.reason.split('\n')[0]}`
  }
  const samples = metric.sampleValues ? ` (samples: ${metric.sampleValues.join(', ')})` : ''
  return `- ${name}: ${formatValue(metric.value, metric.unit)}${samples}`
}

/** The comment's slim version: two sentences, refusals if any, and a link out to the full
 *  accounting — which lives in the run's step summary, next to the log where it belongs. */
export function renderHowMeasuredSlim(result: ResultJson, runUrl: string | null): string {
  const lines: string[] = ['<details>', '<summary>How this was measured</summary>', '']
  if ('protocol' in result.current) {
    const p = result.current.protocol
    lines.push(
      `Both sides build cold in disposable copies, ${p.buildSamples} timed builds after ${p.warmupSamples} discarded warm-up, medians reported; deltas under ${result.config.noiseFloorPercent}% (or each class's quantum) are noise.`,
    )
  }
  if (!result.comparison.protocolsMatch) {
    lines.push('')
    lines.push('**Protocols differed between the sides — deltas were refused, not computed:**')
    for (const mismatch of result.comparison.protocolMismatches) {
      lines.push(`- ${mismatch}`)
    }
  }
  lines.push('')
  lines.push(
    runUrl
      ? `Full per-metric accounting (methodology, raw samples per side): [run summary](${runUrl}).`
      : 'Full per-metric accounting is in the CI run summary.',
  )
  lines.push('', '</details>')
  return lines.join('\n')
}

export function renderHowMeasured(result: ResultJson): string {
  const lines: string[] = ['## How this was measured', '']

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
