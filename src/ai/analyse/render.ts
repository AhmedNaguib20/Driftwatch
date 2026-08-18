import type { MetricComparison, ResultJson } from '../../core/index.js'
import type { DiffFile, LockfileSummary } from './types.js'

/**
 * Renders the fixed sections of an analysis context. Everything here is deterministic: stable
 * ordering, no timestamps, repo-relative paths only. Volatile result fields (createdAt, absolute
 * roots) are deliberately not rendered.
 */

export function renderMeasurement(result: ResultJson): string {
  const lines: string[] = []

  lines.push('## Measured verdict')
  lines.push(`verdict: ${result.verdict}`)
  lines.push(`noise floor: ${result.config.noiseFloorPercent}% | threshold: ${result.config.thresholdPercent}%`)
  lines.push(`dependencies changed: ${String(result.comparison.dependenciesChanged)}`)
  lines.push('')

  lines.push('## Metrics')
  for (const m of result.comparison.metrics) {
    lines.push(renderMetric(m))
  }
  lines.push('')

  lines.push('## Raw samples (medians are reported; judge the spread yourself)')
  for (const side of ['base', 'current'] as const) {
    const report = result[side]
    if (!('metrics' in report)) continue
    for (const metric of report.metrics) {
      if (metric.status === 'measured' && metric.sampleValues) {
        lines.push(`${side} ${metric.id}: [${metric.sampleValues.join(', ')}] ${metric.unit}`)
      }
    }
  }
  lines.push('')

  lines.push('## Measurement protocols')
  for (const side of ['base', 'current'] as const) {
    const report = result[side]
    if (!('protocol' in report)) continue
    const p = report.protocol
    lines.push(
      `${side}: ${p.workspace}, cache ${p.cacheState}, deps ${p.nodeModules}, node ${p.nodeVersion} ${p.platform}/${p.arch}, ` +
        `build "${p.buildCommand ?? 'none'}", ${p.buildSamples} samples after ${p.warmupSamples} warm-up`,
    )
  }
  lines.push('')

  lines.push('## Detection evidence (how the tool knows what it knows)')
  for (const item of result.project.evidence) {
    lines.push(`- ${item.fact} [${item.source}]${item.detail ? ` — ${item.detail}` : ''}`)
  }

  return lines.join('\n')
}

function renderMetric(m: MetricComparison): string {
  const base = m.base === null ? '—' : `${m.base} ${m.unit ?? ''}`.trim()
  const current = m.current === null ? '—' : `${m.current} ${m.unit ?? ''}`.trim()
  const delta = m.delta ? ` | delta ${m.delta.absolute > 0 ? '+' : ''}${m.delta.absolute} (${m.delta.percent > 0 ? '+' : ''}${m.delta.percent}%)` : ''
  const reason = m.reason ? ` | ${m.reason.split('\n')[0]}` : ''
  return `- ${m.label}: ${m.verdict} | base ${base} → current ${current}${delta}${reason}`
}

export function renderDiffstat(files: readonly DiffFile[]): string {
  const lines = ['## Diffstat (every changed file, base → working tree)']
  if (files.length === 0) {
    lines.push('(no changed files)')
    return lines.join('\n')
  }
  for (const f of files) {
    const marks = [f.untracked ? 'new' : null, f.binary ? 'binary' : null]
      .filter(Boolean)
      .join(', ')
    lines.push(
      `- ${f.path}: +${f.insertions}/-${f.deletions}${marks ? ` (${marks})` : ''}`,
    )
  }
  return lines.join('\n')
}

export function renderLockfileSummaries(summaries: readonly LockfileSummary[]): string {
  if (summaries.length === 0) return ''
  const lines = ['## Dependency changes (lockfile summary — raw lockfile patches are never sent)']
  for (const s of summaries) {
    if (s.unparsed) {
      lines.push(`- ${s.unparsed}`)
      continue
    }
    lines.push(`- ${s.lockfile}:`)
    for (const c of s.added) lines.push(`  added ${c.name}${c.to ? ` @ ${c.to}` : ''}`)
    for (const c of s.removed) lines.push(`  removed ${c.name}${c.from ? ` (was ${c.from})` : ''}`)
    for (const c of s.bumped) lines.push(`  bumped ${c.name} ${c.from} → ${c.to}`)
    if (s.added.length + s.removed.length + s.bumped.length === 0) {
      lines.push('  (no package-level changes)')
    }
  }
  return lines.join('\n')
}
