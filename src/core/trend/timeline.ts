import type { IndexEntry, IndexFile } from './index-file.js'
import { orderEntries } from './order.js'
import { isFieldRelevant } from './relevance.js'
import type { IdentityField } from './relevance.js'

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
  /** Carried from the entry (M7): consumers must see measurement time ≠ commit time. */
  readonly replayed?: true
  readonly committedAt?: string
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

const IDENTITY_FIELDS: readonly (readonly [IdentityField, (p: ProtocolIdentity) => string])[] = [
  ['node', (p) => p.nodeVersion],
  ['platform', (p) => `${p.platform}/${p.arch}`],
  ['browser', (p) => p.browser],
  ['hostLabels', (p) => (p.hostLabels.length > 0 ? [...p.hostLabels].join(',') : '(none)')],
  ['driftwatch', (p) => p.driftwatchVersion],
]

/**
 * Fields that changed between two protocols — filtered to those that could have CAUSED a change
 * in `metricId` (relevance.ts). Without a metric, every field counts: a caller comparing whole
 * protocols is asking a different question than a caller segmenting one metric's timeline.
 */
export function identityDiff(a: ProtocolIdentity, b: ProtocolIdentity, metricId?: string): string[] {
  const changes: string[] = []
  for (const [name, pick] of IDENTITY_FIELDS) {
    if (pick(a) === pick(b)) continue
    if (metricId !== undefined && !isFieldRelevant(name, metricId)) continue
    changes.push(`${name}: ${pick(a)} → ${pick(b)}`)
  }
  return changes
}

/**
 * Builds every metric's timeline in HISTORY order — commit topology with a date fallback
 * (order.ts; M7 replay appends older commits after newer entries, so append order stopped
 * meaning history order). Sparse tolerance: an entry missing a metric simply contributes no
 * point to that metric — including entirely empty entries (a run that measured nothing is
 * honest history, not a chart feature).
 */
export function buildTimelines(index: IndexFile): MetricTimeline[] {
  const byMetric = new Map<string, { unit: 'ms' | 'bytes'; carriers: { entry: IndexEntry; value: number }[] }>()

  for (const entry of orderEntries(index.entries)) {
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
        ...(entry.replayed ? { replayed: true as const } : {}),
        ...(entry.committedAt ? { committedAt: entry.committedAt } : {}),
      }
      if (current && identityDiff(current.protocol, entry.protocol, id).length === 0) {
        current.points.push(point)
        continue
      }
      if (current) {
        segments.push({ protocol: current.protocol, points: current.points })
        breaks.push({
          beforeSha: current.points.at(-1)!.sha,
          afterSha: entry.sha,
          changes: identityDiff(current.protocol, entry.protocol, id),
        })
      }
      current = { protocol: entry.protocol, points: [point] }
    }
    if (current) segments.push({ protocol: current.protocol, points: current.points })

    timelines.push({ id, unit, segments, breaks })
  }
  return timelines
}
