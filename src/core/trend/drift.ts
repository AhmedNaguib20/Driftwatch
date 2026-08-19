import type { MetricId } from '../detect/types.js'
import { quantumFor } from '../report/compare-metrics.js'
import { NOISE_FLOOR_PERCENT } from '../detect/config-schema.js'
import type { MetricTimeline, ProtocolBreak, TimelinePoint } from './timeline.js'

/**
 * Drift detection (post-MVP promise #2, basic form): cumulative change from segment start to
 * latest, judged against the metric class's floor + quantum. The whole point: each step under
 * the floor, the SUM well over it — "build time has drifted +11% over 14 commits" when no single
 * commit ever tripped a PR check.
 *
 * Language discipline: trend says "drift", PR runs say "regression" — different epistemics
 * (a drift is an observation over landed history; a regression is a verdict about one change).
 * Direction-aware: downward drift on a cost metric is an improvement and is reported as one.
 */

export type DriftVerdict = 'drifting-up' | 'drifting-down' | 'stable' | 'insufficient-data'

export interface DriftReport {
  readonly id: string
  readonly unit: 'ms' | 'bytes'
  readonly latest: TimelinePoint | null
  /** Points in the LATEST segment — drift is only ever judged within one protocol. */
  readonly segmentPoints: number
  readonly segmentStart: TimelinePoint | null
  /** Null when the verdict is insufficient-data: a number would invite reading a trend into noise. */
  readonly cumulative: { readonly absolute: number; readonly percent: number } | null
  readonly verdict: DriftVerdict
  readonly breaks: readonly ProtocolBreak[]
}

/** Under this many points, a segment is not a trend — two points is a line, not a tendency. */
export const MIN_TREND_POINTS = 3

export function assessDrift(timeline: MetricTimeline): DriftReport {
  const segment = timeline.segments.at(-1) ?? null
  const points = segment?.points ?? []
  const latest = points.at(-1) ?? null
  const start = points[0] ?? null

  const base = {
    id: timeline.id,
    unit: timeline.unit,
    latest,
    segmentPoints: points.length,
    segmentStart: start,
    breaks: timeline.breaks,
  }

  if (points.length < MIN_TREND_POINTS || !latest || !start || start.value === 0) {
    return { ...base, cumulative: null, verdict: 'insufficient-data' }
  }

  const absolute = latest.value - start.value
  const percent = (absolute / start.value) * 100
  // The quantum follows the machine that MEASURED the segment (its recorded hostLabels), never
  // the machine reading the trend — the instrument's resolution travels with the data (spec §5).
  const quantum = quantumFor(
    timeline.id as MetricId,
    timeline.unit,
    (segment?.protocol.hostLabels.length ?? 0) > 0,
  )

  const underFloor = Math.abs(percent) < NOISE_FLOOR_PERCENT
  const underQuantum = quantum > 0 && Math.abs(absolute) < quantum
  if (underFloor || underQuantum) {
    return { ...base, cumulative: null, verdict: 'stable' }
  }

  return {
    ...base,
    cumulative: { absolute, percent: Math.round(percent * 100) / 100 },
    verdict: absolute > 0 ? 'drifting-up' : 'drifting-down',
  }
}
