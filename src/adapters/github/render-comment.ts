import type { MetricComparison, ResultJson } from '../../core/index.js'
import { formatPercent, formatValue } from './format.js'
import { renderAnalysisFooterParts, renderAnalysisSection } from './render-analysis.js'
import { renderHowMeasuredSlim, renderWhatWasSent } from './render-details.js'

/**
 * result JSON → PR comment markdown. Pure function; the first real consumer of the schema-1.1
 * contract, and it reads NOTHING but the contract. Rendering target: docs/pr-comment-mockup.html.
 * The hidden marker is what upsert targets — one comment per PR, updated in place (§6.1).
 */

export const COMMENT_MARKER = '<!-- driftwatch:comment -->'

export interface CommentOptions {
  /** Link target for the full measurement accounting (the run's step summary). */
  readonly runUrl?: string | null
}

/**
 * The PR comment: verdict + table + AI + SLIM details. Email evidence drove the shape: Gmail
 * renders <details> expanded, so the exhaustive per-side accounting lives in the run's step
 * summary (renderSummary — same renderer family, mode-aware) and the comment links to it.
 */
export function renderComment(result: ResultJson, options: CommentOptions = {}): string {
  const lines: string[] = [COMMENT_MARKER, '']

  lines.push(...verdictBanner(result))
  lines.push('')
  lines.push(...comparisonTable(result))
  lines.push(...renderAnalysisSection(result))
  lines.push('')
  lines.push(renderHowMeasuredSlim(result, options.runUrl ?? null))
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

export function comparisonTable(result: ResultJson): string[] {
  const rank = { regressed: 0, improved: 1, no_change: 2, not_comparable: 3, skipped: 4 }
  const rows = [...result.comparison.metrics].sort((a, b) => rank[a.verdict] - rank[b.verdict])

  // Identical-reason POLICY skips collapse to one row each — five SSG exclusions are one fact,
  // not five table rows (email evidence: they blew up the table width). Full list in a details
  // block below the table.
  const grouped = new Map<string, MetricComparison[]>()
  const singles: MetricComparison[] = []
  for (const m of rows) {
    if (m.verdict === 'skipped' && m.excluded) {
      const key = compactReason(m.reason ?? 'not collected')
      if (!grouped.has(key)) grouped.set(key, [])
      grouped.get(key)!.push(m)
    } else {
      singles.push(m)
    }
  }

  const lines = ['| Metric | Base | This PR | Change |', '|---|---|---|---|']
  for (const m of singles) {
    lines.push(
      `| ${m.label} | ${formatValue(m.base, m.unit)} | ${formatValue(m.current, m.unit)} | ${changeCell(m)} |`,
    )
  }
  const groupedRows: { reason: string; members: MetricComparison[] }[] = []
  for (const [reason, members] of grouped) {
    if (members.length === 1) {
      const m = members[0]!
      lines.push(
        `| ${m.label} | ${formatValue(m.base, m.unit)} | ${formatValue(m.current, m.unit)} | ${changeCell(m)} |`,
      )
    } else {
      lines.push(`| ${members.length} rows excluded by policy | — | — | ${shortPolicyReason(reason)} |`)
      groupedRows.push({ reason, members })
    }
  }

  if (groupedRows.length > 0) {
    lines.push('')
    lines.push('<details>')
    lines.push('<summary>Excluded rows</summary>')
    lines.push('')
    for (const g of groupedRows) {
      lines.push(`- ${g.members.map((m) => m.label).join(', ')} — ${g.reason}`)
    }
    lines.push('')
    lines.push('</details>')
  }
  return lines
}

/** The grouped row's cell keeps the first clause; the details block carries the whole reason. */
function shortPolicyReason(reason: string): string {
  return reason.split(' — ')[0]!.split(';')[0]!
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
