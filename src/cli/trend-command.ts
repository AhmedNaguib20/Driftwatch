import pc from 'picocolors'
import {
  assessDrift,
  buildTimelines,
  detectProject,
  readPerfDataIndex,
} from '../core/index.js'
import type { DriftReport } from '../core/index.js'
import { formatValue, padVisible, visibleLength } from './format.js'


/**
 * `driftwatch trend` — where has main been going? Reads the perf-data branch (read-only),
 * renders per-metric drift within the latest protocol segment. Trend language is "drift", never
 * "regression". Honest about thin data: under 3 points is not a trend and says so.
 */
export async function trendCommand(flags: {
  json: boolean
  fetch: boolean
  cwd: string
}): Promise<void> {
  const profile = await detectProject({ cwd: flags.cwd })
  if (!profile.gitRoot) {
    console.error(pc.yellow('not inside a git repository — there is no perf-data branch to read'))
    return
  }

  const read = await readPerfDataIndex(profile.gitRoot, { fetch: flags.fetch })
  if ('unavailable' in read) {
    if (flags.json) console.log(JSON.stringify({ unavailable: read.unavailable }))
    else console.log(pc.yellow(read.unavailable))
    return
  }

  const reports = buildTimelines(read.index).map(assessDrift)

  if (flags.json) {
    console.log(JSON.stringify({ ref: read.ref, entries: read.index.entries.length, metrics: reports }, null, 2))
    return
  }

  console.log(renderTrend(reports, read.index.entries.length))
}

export function renderTrend(reports: readonly DriftReport[], entryCount: number): string {
  const lines: string[] = []
  lines.push(pc.bold(`trend over ${entryCount} recorded commit(s)`))
  lines.push('')

  const header = ['metric', 'current', 'segment', 'drift']
  const rows = reports.map((r) => [
    r.id,
    r.latest ? formatValue(r.latest.value, r.unit) : '—',
    `${r.segmentPoints} pt${r.segmentPoints === 1 ? '' : 's'}`,
    driftCell(r),
  ])
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => visibleLength(row[i]!))))
  const render = (cells: string[]) =>
    '  ' + cells.map((c, i) => (i === cells.length - 1 ? c : padVisible(c, widths[i]!))).join('   ')
  lines.push(pc.dim(render(header)))
  for (const row of rows) lines.push(render(row))

  const withBreaks = reports.filter((r) => r.breaks.length > 0)
  if (withBreaks.length > 0) {
    lines.push('')
    lines.push(pc.bold('protocol breaks') + pc.dim(' — no line is drawn across these (§5.1):'))
    const seen = new Set<string>()
    for (const r of withBreaks) {
      for (const b of r.breaks) {
        const key = `${b.beforeSha}→${b.afterSha}:${b.changes.join(';')}`
        if (seen.has(key)) continue
        seen.add(key)
        lines.push(`  ${b.beforeSha.slice(0, 12)} → ${b.afterSha.slice(0, 12)}: ${pc.yellow(b.changes.join(' | '))}`)
      }
    }
  }
  return lines.join('\n')
}

function driftCell(r: DriftReport): string {
  switch (r.verdict) {
    case 'insufficient-data':
      return pc.dim(`insufficient data (${r.segmentPoints} < 3 points)`)
    case 'stable':
      return pc.dim('stable')
    case 'drifting-up':
      return pc.red(`▲ +${r.cumulative!.percent.toFixed(1)}% since ${r.segmentStart!.shortSha.slice(0, 7)} (drift, not a verdict)`)
    case 'drifting-down':
      return pc.green(`▼ ${r.cumulative!.percent.toFixed(1)}% since ${r.segmentStart!.shortSha.slice(0, 7)} (improvement)`)
  }
}
