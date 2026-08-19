import type { MetricComparison, ResultJson } from '../../core/index.js'
import { formatPercent, formatValue } from './format.js'
import { renderAnalysisFooterParts, renderAnalysisSection } from './render-analysis.js'
import { renderAllMetrics, renderHowMeasured, renderWhatWasSent } from './render-details.js'

/**
 * result JSON → PR comment markdown. Pure function; the first real consumer of the schema-1.1
 * contract, and it reads NOTHING but the contract. Rendering target: docs/pr-comment-mockup.html.
 * The hidden marker is what upsert targets — one comment per PR, updated in place (§6.1).
 */

export const COMMENT_MARKER = '<!-- driftwatch:comment -->'

export function renderComment(result: ResultJson): string {
  const lines: string[] = [COMMENT_MARKER, '']

  lines.push(...verdictBanner(result))
  lines.push('')
  lines.push(...comparisonTable(result))
  lines.push(...renderAnalysisSection(result))
  lines.push('')
  lines.push(renderAllMetrics(result))
  lines.push('')
  lines.push(renderHowMeasured(result))
  const sent = renderWhatWasSent(result)
  if (sent) {
    lines.push('')
    lines.push(sent)
  }
  lines.push('')
  lines.push('---')
  lines.push(footer(result))

  return lines.join('\n')
}

/** The check run's markdown: verdict + table only — visible even where the comment cannot post. */
export function renderCheckSummary(result: ResultJson): string {
  return [...verdictBanner(result), '', ...comparisonTable(result)].join('\n')
}

/** One line for the check title / commit status description. */
export function renderCheckTitle(result: ResultJson): string {
  switch (result.verdict) {
    case 'regression': {
      const worst = result.comparison.metrics
        .filter((m) => m.verdict === 'regressed' && m.exceedsThreshold)
        .map((m) => `${m.label} ${formatPercent(m.delta!.percent)}`)
        .join(', ')
      return `${worst} (threshold ${result.config.thresholdPercent}%)`
    }
    case 'ok':
      return 'no significant performance change'
    case 'inconclusive':
      return !result.base.available
        ? `inconclusive: ${result.base.reason}`
        : 'inconclusive: a key metric could not be compared'
    case 'recorded':
      return 'trend point recorded (no comparison)'
  }
}

function verdictBanner(result: ResultJson): string[] {
  const baseline = result.base.available
    ? `\`${result.config.base}@${result.base.sha.slice(0, 7)}\``
    : 'unavailable'

  switch (result.verdict) {
    case 'regression': {
      const worst = result.comparison.metrics
        .filter((m) => m.verdict === 'regressed' && m.exceedsThreshold)
        .map((m) => `**${m.label}** is up ${formatPercent(m.delta!.percent)}`)
        .join(', ')
      return [
        `### ⚠️ Performance regression detected`,
        '',
        `${worst} against baseline ${baseline}. Threshold is ${result.config.thresholdPercent}%.`,
      ]
    }
    case 'ok':
      return [
        `### ✅ No significant performance change`,
        '',
        `All measured deltas are under the ${result.config.noiseFloorPercent}% noise floor or below the ${result.config.thresholdPercent}% threshold, against baseline ${baseline}.`,
      ]
    case 'inconclusive': {
      const why = !result.base.available
        ? result.base.reason
        : !result.comparison.protocolsMatch
          ? 'the two sides were measured under different protocols — deltas were refused, not computed'
          : 'a key metric could not be measured'
      return [`### ❔ Measurement inconclusive`, '', `${why}. Baseline: ${baseline}.`]
    }
    case 'recorded':
      return [`### 📈 Trend point recorded`, '', 'Absolute measurement of this commit — no comparison was made.']
  }
}

function comparisonTable(result: ResultJson): string[] {
  const rank = { regressed: 0, improved: 1, no_change: 2, not_comparable: 3, skipped: 4 }
  const rows = [...result.comparison.metrics].sort((a, b) => rank[a.verdict] - rank[b.verdict])

  const lines = ['| Metric | Base | This PR | Change |', '|---|---|---|---|']
  for (const m of rows) {
    lines.push(
      `| ${m.label} | ${formatValue(m.base, m.unit)} | ${formatValue(m.current, m.unit)} | ${changeCell(m)} |`,
    )
  }
  return lines
}

function changeCell(m: MetricComparison): string {
  switch (m.verdict) {
    case 'regressed':
      return `**${formatPercent(m.delta!.percent)}** ⬆️${m.exceedsThreshold ? '' : ' (under threshold)'}`
    case 'improved':
      return `${formatPercent(m.delta!.percent)} ⬇️`
    case 'no_change':
      return 'no change'
    case 'not_comparable':
      return 'not comparable'
    case 'skipped':
      return `skipped — ${compactReason(m.reason ?? 'not collected')}`
  }
}

/** Table cells must escape pipes, and "base: X | current: X" reads twice as long as it is. */
function compactReason(reason: string): string {
  const firstLine = reason.split('\n')[0]!
  const match = /^base: (.*) \| current: (.*)$/.exec(firstLine)
  const text = match && match[1] === match[2] ? match[1]! : firstLine
  return text.replaceAll('|', '\\|')
}

function footer(result: ResultJson): string {
  const parts: string[] = []
  if (result.base.available) {
    parts.push(
      `Baseline \`${result.config.base}@${result.base.sha.slice(0, 7)}\`${result.base.fromCache ? ' (cached)' : ''}`,
    )
  }
  parts.push(`driftwatch v${result.driftwatchVersion}`)
  parts.push(...renderAnalysisFooterParts(result.analysis))
  return `<sub>${parts.join(' · ')}</sub>`
}
