import type { AlertCondition, DeclineReason } from './decide.js'
import { alertPayload, resolutionSentence } from './payload.js'
import type { AlertPayload, AlertSpan } from './payload.js'
import { ALERT_RESOLVE_PERCENT, ALERT_WORSEN_STEP_PERCENT } from './thresholds.js'

/**
 * Alert state — the difference between a tool people keep and a tool people mute.
 *
 * A scheduled run sees the same drift every time it runs. Firing on each one teaches the reader
 * that the alert carries no information, and the next real one is filtered out with the rest. So
 * an alert fires ONCE per condition and then stays quiet until the situation materially changes:
 *
 *   worsened  — another full threshold step beyond the level last alerted (10 points).
 *   resolved  — retreated to half the alert line or less; said once, then forgotten.
 *   superseded — the ground moved (protocol break, or a new PR-visible step re-cut the window).
 *                NOT resolved: we never claim a recovery we did not measure (hard rule 3).
 *
 * State lives beside the data it describes, on the perf-data branch — the same place, the same
 * consent rule (appending to an existing branch is implicit; creating one is not, spec v43).
 */

export const ALERT_STATE_FILE = 'alerts.json'
export const ALERT_STATE_SCHEMA_VERSION = 1
const TOOL_MARKER = 'driftwatch'

export interface AlertRecord {
  readonly metric: string
  /** When it fired — measurement time, from the caller's clock. */
  readonly firedAt: string
  /** Latest point at the moment of firing. */
  readonly atSha: string
  /** The window's first point: the condition's identity. A different one is a different claim. */
  readonly windowStartSha: string
  readonly cumulativePercent: number
  readonly points: number
  /** The protocol the claim was measured under — so a supersede can name what changed. */
  readonly protocolLabel?: string | null
  /**
   * Where this alert was published, as an opaque handle the publishing surface owns and core
   * never interprets — e.g. `{ kind: 'github-issue', ref: '42' }`. It exists so the next run can
   * find what it already said without searching for it, and so hard rule 1 holds: core stores the
   * string, the adapter gives it meaning.
   */
  readonly surface?: { readonly kind: string; readonly ref: string }
}

export interface AlertState {
  readonly tool: typeof TOOL_MARKER
  readonly schemaVersion: typeof ALERT_STATE_SCHEMA_VERSION
  readonly open: readonly AlertRecord[]
}

export function emptyAlertState(): AlertState {
  return { tool: TOOL_MARKER, schemaVersion: ALERT_STATE_SCHEMA_VERSION, open: [] }
}

/** Null when the content is not driftwatch's — the caller refuses rather than overwriting. */
export function parseAlertState(raw: string): AlertState | null {
  try {
    const parsed = JSON.parse(raw) as AlertState
    if (parsed.tool !== TOOL_MARKER || !Array.isArray(parsed.open)) return null
    return parsed
  } catch {
    return null
  }
}

export type AlertEvent =
  | {
      readonly kind: 'fire'
      readonly reason: 'new' | 'worsened'
      readonly metric: string
      readonly payload: AlertPayload
      readonly record: AlertRecord
      readonly supersedes: AlertRecord | null
      /** What was last said about this condition — present only when reason is 'worsened'. */
      readonly previousPercent?: number
    }
  | { readonly kind: 'holding'; readonly metric: string; readonly record: AlertRecord; readonly cumulativePercent: number; readonly detail: string }
  | { readonly kind: 'resolved'; readonly metric: string; readonly record: AlertRecord; readonly cumulativePercent: number; readonly sentence: string }
  | {
      readonly kind: 'superseded'
      readonly metric: string
      readonly record: AlertRecord
      /** Why the claim can no longer be continued — never a string to be matched on. */
      readonly cause: 'protocol-break' | 'metric-absent'
      /** The identity the data is measured under NOW — the thing that is no longer the same. */
      readonly nowProtocolLabel?: string
      readonly detail: string
    }
  | { readonly kind: 'quiet'; readonly metric: string; readonly reason: DeclineReason; readonly detail: string }

export interface StateOptions {
  readonly now: string
  readonly span?: AlertSpan
}

/**
 * Folds prior state into a data-only condition. Pure: the caller owns the clock and the writing.
 */
export function applyState(
  condition: AlertCondition,
  prior: AlertRecord | null,
  options: StateOptions,
): AlertEvent {
  const metric = condition.id
  const w = condition.window

  if (condition.qualifies && w) {
    const sameCondition = prior !== null && prior.windowStartSha === w.first.sha
    const record: AlertRecord = {
      metric,
      firedAt: options.now,
      atSha: w.latest.sha,
      windowStartSha: w.first.sha,
      cumulativePercent: w.cumulativePercent,
      points: w.points.length,
      protocolLabel: condition.protocolLabel,
      // A widened alert is the SAME published thing, said again — it keeps its surface handle.
      ...(prior?.surface && prior.windowStartSha === w.first.sha ? { surface: prior.surface } : {}),
    }

    if (!sameCondition) {
      // Either the first alert for this metric, or the old one's window no longer exists. Both
      // are new claims — and the superseded record is reported, never silently dropped.
      return {
        kind: 'fire',
        reason: 'new',
        metric,
        payload: alertPayload(condition, { span: options.span }),
        record,
        supersedes: prior,
      }
    }

    if (w.cumulativePercent >= prior.cumulativePercent + ALERT_WORSEN_STEP_PERCENT) {
      return {
        kind: 'fire',
        reason: 'worsened',
        metric,
        payload: alertPayload(condition, { span: options.span, previouslyAlertedPercent: prior.cumulativePercent }),
        record,
        supersedes: null,
        previousPercent: prior.cumulativePercent,
      }
    }

    return {
      kind: 'holding',
      metric,
      record: prior,
      cumulativePercent: w.cumulativePercent,
      detail: `alerted at ${prior.cumulativePercent}% on ${prior.firedAt.slice(0, 10)}; now ${w.cumulativePercent}% — quiet until ${round2(prior.cumulativePercent + ALERT_WORSEN_STEP_PERCENT)}% or a retreat under ${ALERT_RESOLVE_PERCENT}%`,
    }
  }

  if (!prior) {
    return { kind: 'quiet', metric, reason: condition.decline!.reason, detail: condition.decline!.detail }
  }

  // An open alert exists and the condition no longer qualifies. Resolution is a claim about the
  // ORIGINAL alert, so it is measured from that alert's own starting point — still present in the
  // segment — not from a window that a later commit re-cut. Without this, a single large recovery
  // step would trim the window past the claim and the alert would close as "superseded" while the
  // metric visibly came back down: technically defensible, and useless to the reader.
  const claimStart = condition.segment.find((p) => p.sha === prior.windowStartSha)
  const latest = condition.segment.at(-1)
  if (claimStart && latest && claimStart.value !== 0) {
    const sinceClaim = round2(((latest.value - claimStart.value) / claimStart.value) * 100)
    if (sinceClaim <= ALERT_RESOLVE_PERCENT) {
      return {
        kind: 'resolved',
        metric,
        record: prior,
        cumulativePercent: sinceClaim,
        sentence: resolutionSentence(metric, sinceClaim, prior.cumulativePercent, prior.firedAt),
      }
    }
    return {
      kind: 'holding',
      metric,
      record: prior,
      cumulativePercent: sinceClaim,
      detail: `now ${sinceClaim}% above where the alert was raised — under the alert line but over the ${ALERT_RESOLVE_PERCENT}% resolution line, so it stays open and stays quiet`,
    }
  }

  return {
    kind: 'superseded',
    metric,
    record: prior,
    cause: 'protocol-break',
    ...(condition.protocolLabel ? { nowProtocolLabel: condition.protocolLabel } : {}),
    detail: 'the point it was measured from is no longer in the comparable segment (a protocol break) — the drift was never measured back down, so it is closed as superseded, not resolved',
  }
}

/** The state to store after these events. Records are only ever closed by an event that says so. */
export function nextState(state: AlertState, events: readonly AlertEvent[]): AlertState {
  const open = new Map(state.open.map((r) => [r.metric, r]))
  for (const event of events) {
    if (event.kind === 'fire') open.set(event.metric, event.record)
    else if (event.kind === 'resolved' || event.kind === 'superseded') open.delete(event.metric)
  }
  return { ...state, open: [...open.values()].sort((a, b) => (a.metric < b.metric ? -1 : 1)) }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
