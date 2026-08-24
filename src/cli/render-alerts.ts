import pc from 'picocolors'
import { ALERT_CUMULATIVE_PERCENT, metricLabel } from '../core/index.js'
import type { AlertAssessment, AlertEvent } from '../core/index.js'

/**
 * The alert decision, rendered. Firing alerts get the space; everything else gets one line each,
 * because "we looked and said nothing" is the report's other half — a reader who cannot see the
 * quiet metrics cannot tell silence from blindness.
 */
export function renderAlerts(assessment: AlertAssessment, entryCount: number, stateNote: string): string {
  const lines: string[] = []
  const firing = assessment.events.filter((e): e is Extract<AlertEvent, { kind: 'fire' }> => e.kind === 'fire')

  lines.push(pc.bold(`alerts over ${entryCount} recorded commit(s)`))
  lines.push(pc.dim(stateNote))
  lines.push('')

  const resolved = assessment.events.filter((e): e is Extract<AlertEvent, { kind: 'resolved' }> => e.kind === 'resolved')

  // "nothing to alert" is a statement about silence — it must not sit beside something we said.
  if (firing.length === 0 && resolved.length === 0) {
    lines.push(`  ${pc.green('nothing to alert')} ${pc.dim(`— no metric has drifted past ${ALERT_CUMULATIVE_PERCENT}% within one protocol segment`)}`)
  }

  for (const event of firing) {
    lines.push(`  ${pc.yellow('▲')} ${pc.bold(event.payload.headline)}`)
    for (const line of event.payload.context) lines.push(pc.dim(`      ${line}`))
    if (event.supersedes) {
      lines.push(pc.dim(`      replaces an earlier alert at ${event.supersedes.cumulativePercent}% whose window no longer exists`))
    }
    lines.push('')
  }

  for (const event of resolved) lines.push(`  ${pc.green('✓')} ${event.sentence}`)
  if (resolved.length > 0) lines.push('')

  if (firing.length === 0 && resolved.length === 0) lines.push('')

  const quiet = assessment.events.filter((e) => e.kind === 'quiet' || e.kind === 'holding' || e.kind === 'superseded')
  if (quiet.length > 0) {
    lines.push(pc.dim('  looked at, not alerted:'))
    const width = Math.max(...quiet.map((e) => metricLabel(e.metric).length))
    for (const event of quiet) {
      const detail = event.kind === 'quiet' ? event.detail : event.detail
      const tag = event.kind === 'holding' ? pc.yellow(' (open)') : event.kind === 'superseded' ? pc.dim(' (closed)') : ''
      lines.push(pc.dim(`    ${metricLabel(event.metric).padEnd(width)}  ${detail}`) + tag)
    }
  }

  if (assessment.notLicensed.length > 0) {
    lines.push('')
    // Grouped by the reason itself, so a retired byte class is never filed under "timing class".
    const byReason = new Map<string, string[]>()
    for (const { id, detail } of assessment.notLicensed) {
      byReason.set(detail, [...(byReason.get(detail) ?? []), metricLabel(id)])
    }
    for (const [detail, ids] of byReason) {
      lines.push(pc.dim(`  never alerted — ${ids.join(', ')}: ${detail}.`))
    }
  }

  return lines.join('\n')
}
