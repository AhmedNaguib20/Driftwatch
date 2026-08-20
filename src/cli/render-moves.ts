import pc from 'picocolors'
import type { MetricMovements, Movement } from '../core/index.js'

/**
 * The movement report, rendered — the wow line. One line per metric that moved; each movement is
 * the sha where history changed, signed. Gapped intervals never pin a single commit: they say
 * "somewhere across". Improvements render too — this is history, not blame.
 */
export function renderMovements(reports: readonly MetricMovements[], entryCount: number): string {
  if (reports.length === 0) {
    return pc.dim(`no metric moved beyond noise across ${entryCount} recorded commit(s).`)
  }

  const lines: string[] = [pc.bold(`performance moved (${entryCount} recorded commit(s)):`)]
  for (const report of reports) {
    const n = report.movements.length
    const where = report.movements.map((m) => renderMovement(m)).join(pc.dim(' · '))
    lines.push(`  ${pc.bold(displayName(report.id))} moved at ${n} ${n === 1 ? 'commit' : 'commits'}: ${where}`)
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
  if (id === 'bundle_size') return 'bundle size'
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
