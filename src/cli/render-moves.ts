import pc from 'picocolors'
import { NOT_JUDGED_REASON } from '../core/index.js'
import type { Movement, MovementReport } from '../core/index.js'

/**
 * The movement report, rendered — the wow line. One line per metric that moved; each movement is
 * the sha where history changed, signed. Gapped intervals never pin a single commit: they say
 * "somewhere across". Improvements render too — this is history, not blame.
 */
export function renderMovements(report: MovementReport, entryCount: number): string {
  const lines: string[] =
    report.moved.length === 0
      ? [pc.dim(`no metric moved beyond noise across ${entryCount} recorded commit(s).`)]
      : [pc.bold(`performance moved (${entryCount} recorded commit(s)):`)]

  for (const metric of report.moved) {
    const n = metric.movements.length
    const where = metric.movements.map((m) => renderMovement(m)).join(pc.dim(' · '))
    lines.push(`  ${pc.bold(displayName(metric.id))} moved at ${n} ${n === 1 ? 'commit' : 'commits'}: ${where}`)
  }

  // Never silently: the classes the doctrine declines to attribute are named, with the reason.
  if (report.notJudged.length > 0) {
    lines.push('')
    lines.push(pc.dim(`  ${report.notJudged.map(displayName).join(', ')}: ${NOT_JUDGED_REASON}`))
  }
  return lines.join('\n')
}

function renderMovement(m: Movement): string {
  const signed = `${m.deltaPercent > 0 ? '+' : '−'}${Math.abs(m.deltaPercent).toFixed(1)}%`
  const tinted = m.direction === 'up' ? pc.yellow(signed) : pc.green(signed)
  if (m.gap) {
    const unbuildable = m.gap.unbuildable > 0 ? `, ${m.gap.unbuildable} unbuildable` : ''
    return `${short(m.fromSha)}..${short(m.toSha)} ${tinted} ${pc.dim(`(somewhere across ${m.gap.commits} commit${m.gap.commits === 1 ? '' : 's'}${unbuildable})`)}`
  }
  return `${short(m.toSha)} ${tinted}`
}

const short = (sha: string) => sha.slice(0, 7)

/** Terminal display names — ids stay ids in the JSON and on the dashboard cards. */
export function displayName(id: string): string {
  if (id === 'build_time') return 'build time'
  if (id === 'client_bundle_size') return 'client bundle size'
  if (id === 'build_output_size') return 'build output size'
  if (id === 'install_time') return 'install time'
  const [kind, ...route] = id.split(':')
  const suffix = route.join(':')
  switch (kind) {
    case 'route_latency':
      return `route ${suffix}`
    case 'lcp':
      return `LCP ${suffix}`
    case 'fcp':
      return `FCP ${suffix}`
    case 'tbt':
      return `TBT ${suffix}`
    case 'transfer_size':
      return `transfer size ${suffix}`
    default:
      return id
  }
}
