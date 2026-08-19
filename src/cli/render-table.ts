import pc from 'picocolors'
import type { MetricComparison, ResultJson } from '../core/index.js'
import { formatPercent, formatValue, padVisible, visibleLength } from './format.js'

/**
 * Terminal rendering of the result JSON. Same content hierarchy as the PR comment (spec §3.2):
 * verdict line first, changed metrics before no-change rows, then everything we could not
 * compare — with reasons, because a silent omission looks like "we didn't look" (rule 3).
 * picocolors no-ops under NO_COLOR and non-TTY on its own.
 */

export function renderResult(result: ResultJson): string {
  const lines: string[] = []

  lines.push(verdictLine(result))
  lines.push('')
  if (result.mode === 'record' && 'metrics' in result.current) {
    lines.push(...recordTable(result))
  } else {
    lines.push(...table(sortForDisplay(result.comparison.metrics)))
  }
  lines.push('')
  lines.push(...footer(result))

  const warnings = [...result.warnings, ...result.project.warnings]
  if (warnings.length > 0) {
    lines.push('')
    for (const w of warnings) lines.push(`${pc.yellow('warning')} ${w}`)
  }

  return lines.join('\n')
}

function verdictLine(result: ResultJson): string {
  const vs = result.base.available
    ? `vs ${result.config.base} @ ${result.base.sha.slice(0, 7)}`
    : ''

  switch (result.verdict) {
    case 'ok':
      return pc.green(`\u2713 no significant performance change ${vs}`.trim())
    case 'regression': {
      const worst = result.comparison.metrics
        .filter((m) => m.verdict === 'regressed' && m.exceedsThreshold)
        .map((m) => `${m.label} ${formatPercent(m.delta!.percent)}`)
        .join(', ')
      return pc.red(
        `\u2717 performance regression ${vs}: ${worst} (threshold ${result.config.thresholdPercent}%)`,
      )
    }
    case 'inconclusive': {
      const why = !result.base.available
        ? result.base.reason
        : result.comparison.protocolMismatches.length > 0
          ? 'the two sides were measured under different protocols'
          : 'a key metric could not be measured'
      return pc.yellow(`? inconclusive ${vs}: ${why}`.trim())
    }
    case 'recorded': {
      const measured = 'metrics' in result.current
        ? result.current.metrics.filter((m) => m.status === 'measured').length
        : 0
      return pc.green(`● recorded ${measured} metrics (trend point — no comparison)`)
    }
  }
}

/** Changed rows first — the reader's question is "what moved", then "what else was checked". */
function sortForDisplay(metrics: readonly MetricComparison[]): MetricComparison[] {
  const rank = { regressed: 0, improved: 1, no_change: 2, not_comparable: 3, skipped: 4 }
  return [...metrics].sort((a, b) => rank[a.verdict] - rank[b.verdict])
}

function recordTable(result: ResultJson): string[] {
  if (!('metrics' in result.current)) return []
  const rows = result.current.metrics.map((m) => [
    m.label,
    m.status === 'measured' ? formatValue(m.value, m.unit) : '—',
    m.status === 'measured' ? '' : pc.dim(`skipped — ${m.reason.split('\n')[0]}`),
  ])
  const width = Math.max(...rows.map((r) => visibleLength(r[0]!)))
  return rows.map((r) => `  ${padVisible(r[0]!, width)}   ${r[1]}${r[2] ? '   ' + r[2] : ''}`)
}

function table(metrics: MetricComparison[]): string[] {
  const header = ['metric', 'base', 'current', 'delta']
  const rows = metrics.map((m) => [
    m.label,
    formatValue(m.base, m.unit),
    formatValue(m.current, m.unit),
    deltaCell(m),
  ])

  const widths = header.map((h, col) =>
    Math.max(h.length, ...rows.map((r) => visibleLength(r[col]!))),
  )

  // The last column is never padded — a long skip reason must not drag whitespace onto every row.
  const render = (cells: string[]) =>
    '  ' +
    cells
      .map((c, i) => (i === cells.length - 1 ? c : padVisible(c, widths[i]!)))
      .join('   ')

  return [pc.dim(render(header)), ...rows.map(render)]
}

function deltaCell(m: MetricComparison): string {
  switch (m.verdict) {
    case 'regressed':
      return pc.red(
        `${formatPercent(m.delta!.percent)} \u25b2${m.exceedsThreshold ? '' : ' (under threshold)'}`,
      )
    case 'improved':
      return pc.green(`${formatPercent(m.delta!.percent)} \u25bc`)
    case 'no_change':
      return pc.dim('no change')
    case 'not_comparable':
      return pc.yellow('not comparable')
    case 'skipped':
      return pc.dim(`skipped \u2014 ${compactSkipReason(m.reason ?? 'not collected')}`)
  }
}

function footer(result: ResultJson): string[] {
  const lines: string[] = []

  if (result.base.available) {
    const how =
      result.comparison.measurementPath === 'screened'
        ? `base from cache (measured ${result.base.measuredAt ?? 'earlier'})`
        : result.comparison.measurementPath === 'confirmed'
          ? 'cached screening crossed the noise floor \u2014 both sides re-measured fresh this run'
          : 'both sides measured fresh this run'
    lines.push(pc.dim(`  ${how}`))
  }

  if (result.comparison.dependenciesChanged === true) {
    lines.push(pc.yellow('  dependencies changed between base and current (lockfile differs)'))
  } else if (result.comparison.dependenciesChanged === null && result.base.available) {
    lines.push(pc.yellow('  dependency changes unknown (no lockfile to compare)'))
  }

  for (const mismatch of result.comparison.protocolMismatches) {
    lines.push(pc.yellow(`  protocol mismatch \u2014 ${mismatch}`))
  }

  return lines
}

function firstLine(text: string): string {
  return text.split('\n')[0] ?? text
}

/** "base: X | current: X" reads twice as long as it is — collapse when both reasons match. */
function compactSkipReason(reason: string): string {
  const match = /^base: (.*) \| current: (.*)$/.exec(firstLine(reason))
  if (match && match[1] === match[2]) return match[1]!
  return firstLine(reason)
}
