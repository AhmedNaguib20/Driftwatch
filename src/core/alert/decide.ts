import type { MetricId } from '../detect/types.js'
import { quantumFor } from '../report/compare-metrics.js'
import { isAttributable } from '../trend/movement.js'
import type { MetricTimeline, TimelinePoint } from '../trend/timeline.js'
import {
  ALERT_CUMULATIVE_PERCENT,
  ALERT_MAX_STEP_SHARE,
  ALERT_MIN_NET_SHARE,
  ALERT_MIN_POINTS,
  DEFAULT_PR_THRESHOLD_PERCENT,
} from './thresholds.js'
import { driftWindow } from './window.js'
import type { DriftWindow } from './window.js'

/**
 * `shouldAlert` — the data-only half of the decision (M10 step 1). No state, no GitHub, no I/O:
 * given one metric's timeline, does the history itself justify interrupting somebody?
 *
 * Drift is a TENDENCY claim — weaker than movement's per-commit attribution (spec §10) — so the
 * bar is the strictest in the tool. Every requirement below is a way of asking the same question:
 * is this something the PR flow structurally could not have seen?
 */

export type DeclineReason =
  | 'not-licensed'
  | 'insufficient-points'
  | 'improving'
  | 'under-threshold'
  | 'step-change'
  | 'not-sustained'

export interface AlertCondition {
  readonly id: string
  readonly unit: 'ms' | 'bytes'
  readonly window: DriftWindow | null
  /**
   * Every point of the latest protocol segment — a superset of the window. State needs it to ask
   * the only question resolution can honestly be about: has the drift WE ALERTED ON come back
   * down? That is measured from the original claim's starting point, not from a later re-cut.
   */
  readonly segment: readonly TimelinePoint[]
  readonly qualifies: boolean
  readonly decline: { readonly reason: DeclineReason; readonly detail: string } | null
  /** The PR threshold the window was trimmed against — the number the payload sentence quotes. */
  readonly prThresholdPercent: number
}

export interface AlertOptions {
  /** perf.yml `threshold`, the line a single PR run must cross to become a verdict. */
  readonly prThresholdPercent?: number
}

export function shouldAlert(timeline: MetricTimeline, options: AlertOptions = {}): AlertCondition {
  const prThresholdPercent = options.prThresholdPercent ?? DEFAULT_PR_THRESHOLD_PERCENT
  const segment = timeline.segments.at(-1)
  const decline = (reason: DeclineReason, detail: string, window: DriftWindow | null = null): AlertCondition => ({
    id: timeline.id,
    unit: timeline.unit,
    window,
    segment: segment?.points ?? [],
    qualifies: false,
    decline: { reason, detail },
    prThresholdPercent,
  })

  // The movement licence, applied to alerting (spec §10): deterministic byte classes only. A
  // wall-clock drift over landed history cannot be told from thermals and the runner lottery, and
  // an alert is a stronger act than a chart row — the doctrine tightens, never loosens.
  if (!isAttributable(timeline.id)) {
    return decline('not-licensed', licenceDetail(timeline.unit))
  }

  const window = driftWindow(timeline, prThresholdPercent)
  if (!window) {
    return decline('insufficient-points', 'the latest protocol segment holds fewer than two comparable points')
  }
  if (window.points.length < ALERT_MIN_POINTS) {
    return decline(
      'insufficient-points',
      `${window.points.length} point(s) in the window; ${ALERT_MIN_POINTS} are needed before a run is a tendency`,
      window,
    )
  }

  // Magnitude before direction, deliberately: a −0.004% wobble is FLAT, and calling it an
  // improvement would be a claim about a movement the instrument never resolved (hard rule 3).
  const quantum = quantumFor(timeline.id as MetricId, timeline.unit, (segment?.protocol.hostLabels.length ?? 0) > 0)
  if (Math.abs(window.cumulativePercent) < ALERT_CUMULATIVE_PERCENT || Math.abs(window.cumulativeAbsolute) < quantum) {
    return decline(
      'under-threshold',
      `cumulative ${signed(window.cumulativePercent)}% is under the ${ALERT_CUMULATIVE_PERCENT}% alert line (the trend reports from far lower)`,
      window,
    )
  }

  // Alerts are for worsening. A real downward drift is the tool's good news and belongs on the
  // dashboard, where it costs nobody anything.
  if (window.cumulativeAbsolute < 0) {
    return decline('improving', `drifted ${signed(window.cumulativePercent)}% — a downward drift is an improvement, not an alert`, window)
  }

  // A step change with noise around it is a regression, and the PR flow owns regressions. Note
  // the window has ALREADY excluded any step that crossed the PR threshold on its own — this
  // catches the quieter shape: one step that is most of the movement while staying under it.
  const share = Math.abs(window.largestStep.absolute) / Math.abs(window.cumulativeAbsolute)
  if (share >= ALERT_MAX_STEP_SHARE) {
    return decline(
      'step-change',
      `one commit (${window.largestStep.toSha.slice(0, 12)}) accounts for ${Math.round(share * 100)}% of the movement — that is a step, not a drift`,
      window,
    )
  }

  if (window.netShare < ALERT_MIN_NET_SHARE) {
    return decline(
      'not-sustained',
      `only ${Math.round(window.netShare * 100)}% of the movement went one way (${window.sameDirectionSteps} of ${window.steps.length} steps) — a wobble with a slope, not a tendency`,
      window,
    )
  }

  return {
    id: timeline.id,
    unit: timeline.unit,
    window,
    segment: segment?.points ?? [],
    qualifies: true,
    decline: null,
    prThresholdPercent,
  }
}

/**
 * Why a metric is outside the licence, told truthfully per metric. Timing classes are excluded
 * because their drift is not separable from machine variance; a byte-unit id that is simply not
 * a current class (a retired one, e.g. pre-split `bundle_size`) is a different fact, and saying
 * "timing class" about it would be a small lie in a report about honesty.
 */
function licenceDetail(unit: 'ms' | 'bytes'): string {
  return unit === 'ms'
    ? 'drift in a timing class is not separable from machine variance (spec §10)'
    : 'not one of the current byte classes the alerting licence covers (spec §10)'
}

function signed(percent: number): string {
  return percent > 0 ? `+${percent}` : `${percent}`
}
