import type { IndexEntry, IndexFile } from './index-file.js'

/**
 * Per-metric timelines over the perf-data index, segmented on protocol identity — §5.1 for
 * time-series. Within a segment, points were measured under one protocol and are comparable.
 * Across a break, NO line and no delta, ever: a chart that draws one line through a Node upgrade
 * is the cached-base lie, plotted. Every break names exactly which identity fields changed.
 */

export type ProtocolIdentity = IndexEntry['protocol']

export interface TimelinePoint {
  readonly sha: string
  readonly shortSha: string
  readonly timestamp: string
  readonly value: number
  readonly unit: 'ms' | 'bytes'
}

export interface TimelineSegment {
  readonly protocol: ProtocolIdentity
  readonly points: readonly TimelinePoint[]
}

export interface ProtocolBreak {
  /** FULL shas of the last point before / first point after — display code shortens them. */
  readonly beforeSha: string
  readonly afterSha: string
  /** Exactly which identity fields changed, e.g. "browser: chrome/151.0.7922.108 → chrome/151.0.7922.140". */
  readonly changes: readonly string[]
}

export interface MetricTimeline {
  readonly id: string
  readonly unit: 'ms' | 'bytes'
  readonly segments: readonly TimelineSegment[]
  /** breaks[i] separates segments[i] and segments[i+1]. */
  readonly breaks: readonly ProtocolBreak[]
}

const IDENTITY_FIELDS = [
  ['node', (p: ProtocolIdentity) => p.nodeVersion],
  ['platform', (p: ProtocolIdentity) => `${p.platform}/${p.arch}`],
  ['browser', (p: ProtocolIdentity) => p.browser],
  ['hostLabels', (p: ProtocolIdentity) => (p.hostLabels.length > 0 ? [...p.hostLabels].join(',') : '(none)')],
  ['driftwatch', (p: ProtocolIdentity) => p.driftwatchVersion],
] as const

export function identityDiff(a: ProtocolIdentity, b: ProtocolIdentity): string[] {
  const changes: string[] = []
  for (const [name, pick] of IDENTITY_FIELDS) {
    if (pick(a) !== pick(b)) changes.push(`${name}: ${pick(a)} → ${pick(b)}`)
  }
  return changes
}

/**
 * Builds every metric's timeline in index (append = chronological) order. Sparse tolerance: an
 * entry missing a metric simply contributes no point to that metric — including entirely empty
 * entries (a run that measured nothing is honest history, not a chart feature).
 */
export function buildTimelines(index: IndexFile): MetricTimeline[] {
  const byMetric = new Map<string, { unit: 'ms' | 'bytes'; carriers: { entry: IndexEntry; value: number }[] }>()

  for (const entry of index.entries) {
    for (const [id, metric] of Object.entries(entry.metrics)) {
      if (!byMetric.has(id)) byMetric.set(id, { unit: metric.unit, carriers: [] })
      byMetric.get(id)!.carriers.push({ entry, value: metric.value })
    }
  }

  const timelines: MetricTimeline[] = []
  for (const [id, { unit, carriers }] of [...byMetric.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const segments: TimelineSegment[] = []
    const breaks: ProtocolBreak[] = []
    let current: { protocol: ProtocolIdentity; points: TimelinePoint[] } | null = null

    for (const { entry, value } of carriers) {
      const point: TimelinePoint = {
        sha: entry.sha,
        shortSha: entry.shortSha,
        timestamp: entry.timestamp,
        value,
        unit,
      }
      if (current && identityDiff(current.protocol, entry.protocol).length === 0) {
        current.points.push(point)
        continue
      }
      if (current) {
        segments.push({ protocol: current.protocol, points: current.points })
        breaks.push({
          beforeSha: current.points.at(-1)!.sha,
          afterSha: entry.sha,
          changes: identityDiff(current.protocol, entry.protocol),
        })
      }
      current = { protocol: entry.protocol, points: [point] }
    }
    if (current) segments.push({ protocol: current.protocol, points: current.points })

    timelines.push({ id, unit, segments, breaks })
  }
  return timelines
}
