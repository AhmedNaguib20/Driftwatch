import type { MetricId } from '../detect/types.js'
import { NOISE_FLOOR_PERCENT } from '../detect/config-schema.js'
import type { IndexFile } from './index-file.js'
import { orderEntries } from './order.js'
import { quantumFor } from '../report/compare-metrics.js'
import { buildTimelines } from './timeline.js'

/**
 * The movement report (M7 step 2): where did a metric actually move? Judged between CONSECUTIVE
 * measured points within one segment, with the same floor+quanta machinery as every other
 * comparison — the quantum follows the segment's recorded host class. Improvements count too:
 * the report is history, not blame. Never judged across a protocol break, and when unmeasured
 * commits sit inside an interval the report says so instead of pinning the movement on one sha.
 *
 * Deliberate asymmetry with drift (spec §10): drift is a segment-level TENDENCY — a weak claim,
 * so it keeps the wall-clock classes with its hedged language. Movement is per-commit
 * ATTRIBUTION — the strongest claim the tool makes — so it is licensed to byte classes only.
 */

export interface Movement {
  readonly fromSha: string
  readonly toSha: string
  readonly before: number
  readonly after: number
  readonly deltaAbsolute: number
  readonly deltaPercent: number
  readonly direction: 'up' | 'down'
  /**
   * Non-null when entries sit between the two measured points (this metric unmeasured there):
   * the movement happened SOMEWHERE across the interval — commits counts them, unbuildable how
   * many of those were replay skips.
   */
  readonly gap: { readonly commits: number; readonly unbuildable: number } | null
}

export interface MetricMovements {
  readonly id: string
  readonly unit: 'ms' | 'bytes'
  readonly movements: readonly Movement[]
}

export interface MovementReport {
  readonly moved: readonly MetricMovements[]
  /** Metric ids present in the data but ineligible for attribution (spec §10 doctrine). */
  readonly notJudged: readonly string[]
}

export const NOT_JUDGED_REASON =
  'not judged — cross-time-gap timing (§5.1 fifth instance / runner lottery)'

/**
 * Attribution licence (spec §10, decided at the M7 live proof): only DETERMINISTIC byte classes
 * may name a commit. Wall-clock classes drift across the time gaps a movement spans — locally by
 * thermals/sustained load, on CI by the runner lottery — so pinning them on a commit would be a
 * claim the instrument cannot support. They stay in the data and on the dashboard, labeled.
 */
export function isAttributable(id: string): boolean {
  return id === 'client_bundle_size' || id === 'build_output_size' || id.startsWith('transfer_size:')
}

/** Only metrics that moved appear; a fully quiet history returns []. */
export function findMovements(index: IndexFile): MetricMovements[] {
  const ordered = orderEntries(index.entries)
  const ordinal = new Map(ordered.map((e, i) => [e.sha, i]))
  const unbuildable = new Set(ordered.filter((e) => e.skipped).map((e) => e.sha))

  const out: MetricMovements[] = []
  for (const timeline of buildTimelines(index)) {
    if (!isAttributable(timeline.id)) continue
    const movements: Movement[] = []
    for (const segment of timeline.segments) {
      const ci = segment.protocol.hostLabels.length > 0
      const quantum = quantumFor(timeline.id as MetricId, timeline.unit, ci)
      for (let i = 1; i < segment.points.length; i += 1) {
        const a = segment.points[i - 1]!
        const b = segment.points[i]!
        if (a.value === 0) continue
        const deltaAbsolute = b.value - a.value
        const deltaPercent = (deltaAbsolute / a.value) * 100
        const significant =
          Math.abs(deltaPercent) >= NOISE_FLOOR_PERCENT &&
          (quantum === 0 || Math.abs(deltaAbsolute) >= quantum)
        if (!significant) continue

        const between = (ordinal.get(b.sha) ?? 0) - (ordinal.get(a.sha) ?? 0) - 1
        movements.push({
          fromSha: a.sha,
          toSha: b.sha,
          before: a.value,
          after: b.value,
          deltaAbsolute,
          deltaPercent: Math.round(deltaPercent * 10) / 10,
          direction: deltaAbsolute > 0 ? 'up' : 'down',
          gap:
            between > 0
              ? {
                  commits: between,
                  unbuildable: ordered
                    .slice(ordinal.get(a.sha)! + 1, ordinal.get(b.sha)!)
                    .filter((e) => unbuildable.has(e.sha)).length,
                }
              : null,
        })
      }
    }
    if (movements.length > 0) out.push({ id: timeline.id, unit: timeline.unit, movements })
  }
  return out
}

/** The full report: what moved, plus what the doctrine declines to judge (never silently). */
export function movementReport(index: IndexFile): MovementReport {
  const notJudged = buildTimelines(index)
    .map((t) => t.id)
    .filter((id) => !isAttributable(id))
  return { moved: findMovements(index), notJudged }
}
