import type { IndexFile } from '../trend/index-file.js'
import { orderEntries } from '../trend/order.js'
import { buildTimelines } from '../trend/timeline.js'
import { shouldAlert } from './decide.js'
import { applyState, nextState } from './state.js'
import type { AlertEvent, AlertState } from './state.js'

/**
 * The whole decision over stored history: every metric, its condition, its state.
 *
 * Metrics outside the alerting licence are listed rather than dropped — the same rule the
 * movement report follows. "We do not alert on build time" is information; silence about it is
 * a reader wondering whether the tool looked.
 */

export interface AlertAssessment {
  readonly events: readonly AlertEvent[]
  /** Metrics alerting never speaks for — each with the reason it does not (spec §10). */
  readonly notLicensed: readonly { readonly id: string; readonly detail: string }[]
  /** The state to store if these events are acted on. */
  readonly state: AlertState
}

export interface AssessOptions {
  /** Measurement clock, injected: a pure core never reads the time for itself. */
  readonly now: string
  readonly prThresholdPercent?: number
}

export function assessAlerts(index: IndexFile, state: AlertState, options: AssessOptions): AlertAssessment {
  const ordinal = new Map(orderEntries(index.entries).map((e, i) => [e.sha, i]))
  const prior = new Map(state.open.map((r) => [r.metric, r]))

  const events: AlertEvent[] = []
  const notLicensed: { id: string; detail: string }[] = []

  for (const timeline of buildTimelines(index)) {
    const condition = shouldAlert(timeline, { prThresholdPercent: options.prThresholdPercent })
    if (condition.decline?.reason === 'not-licensed') {
      notLicensed.push({ id: timeline.id, detail: condition.decline.detail })
      continue
    }
    const w = condition.window
    const span =
      w && ordinal.has(w.first.sha) && ordinal.has(w.latest.sha)
        ? { commits: ordinal.get(w.latest.sha)! - ordinal.get(w.first.sha)! + 1 }
        : undefined
    events.push(applyState(condition, prior.get(timeline.id) ?? null, { now: options.now, span }))
  }

  // A metric can disappear from the data entirely (renamed, or no longer measured). Its open
  // record cannot be resolved — nothing measured it back down — so it is closed as superseded.
  for (const record of state.open) {
    if (events.some((e) => e.metric === record.metric)) continue
    events.push({
      kind: 'superseded',
      metric: record.metric,
      record,
      cause: 'metric-absent',
      detail: 'the metric is no longer present in the recorded history — closed as superseded, not resolved',
    })
  }

  return { events, notLicensed, state: nextState(state, events) }
}
