import type { MetricTimeline, TimelinePoint } from '../trend/timeline.js'

/**
 * The drift window: the trailing run of points an alert may talk about.
 *
 * Two trims, both principled:
 *  - Only the LATEST protocol segment. Drift never crosses a break (§5.1) — the same rule the
 *    trend chart draws by.
 *  - Only what follows the last PR-VISIBLE step. If a commit moved the metric past the PR
 *    threshold on its own, the PR flow already had its chance; the alert's subject is what
 *    accumulated since. Without this trim one loud commit would either poison the window forever
 *    or make the alert's own headline sentence false.
 */

export interface DriftStep {
  readonly fromSha: string
  readonly toSha: string
  readonly absolute: number
  readonly percent: number
}

export interface DriftWindow {
  readonly points: readonly TimelinePoint[]
  readonly steps: readonly DriftStep[]
  /** The PR-visible step the window starts after — null when the window is the whole segment. */
  readonly startedAfter: DriftStep | null
  readonly first: TimelinePoint
  readonly latest: TimelinePoint
  readonly cumulativeAbsolute: number
  readonly cumulativePercent: number
  readonly largestStep: DriftStep
  readonly sameDirectionSteps: number
  /** Sum of every step's magnitude — the movement spent to get to the cumulative. */
  readonly grossAbsolute: number
  /** |cumulative| / gross: 1.0 is a staircase, ~0 is a sawtooth. The monotone-ish measure. */
  readonly netShare: number
}

export function driftWindow(timeline: MetricTimeline, prThresholdPercent: number): DriftWindow | null {
  const points = timeline.segments.at(-1)?.points ?? []
  if (points.length < 2) return null

  const all = stepsOf(points)
  // Everything after the last step the PR flow could have caught on its own.
  const lastVisible = all.map((s, i) => ({ s, i })).filter(({ s }) => Math.abs(s.percent) >= prThresholdPercent).at(-1)
  const from = lastVisible ? lastVisible.i + 1 : 0
  const windowPoints = points.slice(from)
  if (windowPoints.length < 2) return null

  const steps = stepsOf(windowPoints)
  const first = windowPoints[0]!
  const latest = windowPoints.at(-1)!
  if (first.value === 0) return null

  const cumulativeAbsolute = latest.value - first.value
  const direction = Math.sign(cumulativeAbsolute)
  const grossAbsolute = steps.reduce((sum, s) => sum + Math.abs(s.absolute), 0)
  return {
    points: windowPoints,
    steps,
    startedAfter: lastVisible?.s ?? null,
    first,
    latest,
    cumulativeAbsolute,
    cumulativePercent: round2((cumulativeAbsolute / first.value) * 100),
    largestStep: steps.reduce((a, b) => (Math.abs(b.percent) > Math.abs(a.percent) ? b : a)),
    sameDirectionSteps: steps.filter((s) => s.absolute !== 0 && Math.sign(s.absolute) === direction).length,
    grossAbsolute,
    netShare: grossAbsolute === 0 ? 0 : Math.abs(cumulativeAbsolute) / grossAbsolute,
  }
}

function stepsOf(points: readonly TimelinePoint[]): DriftStep[] {
  const steps: DriftStep[] = []
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!
    const b = points[i]!
    const absolute = b.value - a.value
    steps.push({
      fromSha: a.sha,
      toSha: b.sha,
      absolute,
      percent: a.value === 0 ? 0 : round2((absolute / a.value) * 100),
    })
  }
  return steps
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
