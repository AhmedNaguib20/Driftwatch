import pc from 'picocolors'
import { summariseReason } from '../core/index.js'
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
    lines.push(...table(sortForDisplay(result.comparison.metrics), nothingMeasured(result)))
  }
  lines.push('')
  lines.push(...footer(result))
  lines.push(...fixStanzas(result))

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
    m.status === 'measured' ? '' : pc.dim(`skipped — ${summariseReason(m.reason).text}`),
  ])
  const width = Math.max(...rows.map((r) => visibleLength(r[0]!)))
  return rows.map((r) => `  ${padVisible(r[0]!, width)}   ${r[1]}${r[2] ? '   ' + r[2] : ''}`)
}

function table(metrics: MetricComparison[], neverRan: boolean): string[] {
  const header = ['metric', 'base', 'current', 'delta']
  // Never-ran must not look like ran-and-quiet: a column of em-dashes reads as "we looked and
  // found nothing" when in fact nothing was measured at all (spec §9a).
  const cell = (v: number | null, unit: MetricComparison['unit']) =>
    v === null && neverRan ? pc.dim('not measured') : formatValue(v, unit)
  const rows = metrics.map((m) => [
    m.label,
    cell(m.base, m.unit),
    cell(m.current, m.unit),
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
    case 'skipped': {
      const { text, truncated } = summariseReason(m.reason ?? 'not collected')
      return pc.dim(`skipped \u2014 ${text}${truncated ? ' (full error: --json)' : ''}`)
    }
  }
}

function footer(result: ResultJson): string[] {
  const lines: string[] = []

  // "both sides measured fresh this run" under a table where nothing was measured is the
  // sentence the trial caught (spec §9a) — the provenance line assumes measurement happened.
  if (result.base.available && !nothingMeasured(result)) {
    const how =
      result.comparison.measurementPath === 'screened'
        ? `base from cache (measured ${result.base.measuredAt ?? 'earlier'})`
        : result.comparison.measurementPath === 'confirmed'
          ? 'cached screening crossed the noise floor \u2014 both sides re-measured fresh this run'
          : 'both sides measured fresh this run'
    lines.push(pc.dim(`  ${how}`))
  }
  if (nothingMeasured(result)) {
    lines.push(pc.yellow('  nothing was measured this run \u2014 every metric above is unavailable, not unchanged'))
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

/** True when this run produced no number at all — every row skipped or uncomparable. */
export function nothingMeasured(result: ResultJson): boolean {
  const rows = result.comparison.metrics
  return rows.length > 0 && rows.every((m) => m.base === null && m.current === null)
}

/**
 * Every failure carries its own fix (spec §9a). Deduplicated — one stanza per distinct remedy,
 * naming the metrics it unblocks, in the M3/M6 style: the exact command, never advice.
 */
function fixStanzas(result: ResultJson): string[] {
  const byFix = new Map<string, string[]>()
  for (const m of result.comparison.metrics) {
    if (!m.fix || m.excluded) continue
    if (!byFix.has(m.fix)) byFix.set(m.fix, [])
    byFix.get(m.fix)!.push(m.label)
  }
  if (byFix.size === 0) return []

  const lines: string[] = ['']
  for (const [fix, labels] of byFix) {
    const shown = labels.length > 3 ? `${labels.slice(0, 3).join(', ')} +${labels.length - 3} more` : labels.join(', ')
    lines.push(pc.bold(`to measure ${shown}:`))
    for (const line of fix.split('\n')) lines.push(line ? `  ${line}` : '')
    lines.push('')
  }
  return lines.slice(0, -1)
}
