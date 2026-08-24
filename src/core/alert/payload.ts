import { formatValue } from '../trend/dashboard/format.js'
import type { AlertCondition } from './decide.js'
import { ALERT_CUMULATIVE_PERCENT, ALERT_RESOLVE_PERCENT } from './thresholds.js'

/**
 * The alert sentence.
 *
 * This is the feature. Everything else in M10 exists to make one sentence true and worth reading:
 *
 *     client bundle size drifted +11.3% over 14 commits (2.20 MB → 2.45 MB)
 *     — no single commit crossed the 5% threshold (largest +1.4%).
 *
 * Three obligations it carries:
 *  1. It names what the PR flow MISSED — that clause is the reason the alert exists, and it is
 *     structurally true: the window excludes any step that crossed the threshold on its own.
 *  2. It is a tendency claim, so it never names a culprit commit. "drifted", never "caused by".
 *  3. It counts only what was measured. Unmeasured commits inside the window are said out loud
 *     rather than folded into the count (the movement report's gap rule, applied to prose).
 *
 * It lives in core because every surface — terminal, issue body, PR comment — must say exactly
 * the same thing. A sentence that varies by renderer is three claims, not one.
 */

export interface AlertSpan {
  /** Entries between the window's first and last point, measured or not (from the index order). */
  readonly commits: number
}

export interface AlertPayload {
  readonly metric: string
  readonly label: string
  /** The sentence. */
  readonly headline: string
  /** Supporting lines a renderer may show under it; never required to understand the headline. */
  readonly context: readonly string[]
  readonly cumulativePercent: number
  readonly points: number
  readonly largestStepPercent: number
  readonly prThresholdPercent: number
  readonly from: { readonly sha: string; readonly value: number }
  readonly to: { readonly sha: string; readonly value: number }
  readonly cumulativeAbsolute: number
  readonly unit: 'ms' | 'bytes'
  /** Share of all movement that went one way, 0-1 — the monotone-ish measure. */
  readonly netShare: number
  /** The one protocol the whole window was measured under, for surfaces that show their work. */
  readonly protocolLabel: string | null
}

export function alertPayload(
  condition: AlertCondition,
  options: { readonly span?: AlertSpan; readonly previouslyAlertedPercent?: number } = {},
): AlertPayload {
  const w = condition.window!
  const label = metricLabel(condition.id)
  const over = spanPhrase(w.points.length, options.span)
  const values = `${formatValue(w.first.value, condition.unit)} → ${formatValue(w.latest.value, condition.unit)}`
  const missed = `no single commit crossed the ${condition.prThresholdPercent}% threshold (largest ${signed(w.largestStep.percent)}%)`

  const headline =
    options.previouslyAlertedPercent === undefined
      ? `${label} drifted ${signed(w.cumulativePercent)}% over ${over} (${values}) — ${missed}.`
      : `${label} drift widened to ${signed(w.cumulativePercent)}% over ${over} (${values}) — last alerted at ${signed(options.previouslyAlertedPercent)}%, and still ${missed}.`

  const context: string[] = []
  if (w.startedAfter) {
    context.push(
      `Measured since ${w.startedAfter.toSha.slice(0, 12)} — the last commit that moved this metric past ${condition.prThresholdPercent}% on its own, which the PR run reported at the time.`,
    )
  }
  context.push(
    `${w.sameDirectionSteps} of ${w.steps.length} steps moved the same way, and ${Math.round(w.netShare * 100)}% of all movement went one way. ` +
      'Drift is a tendency over landed history — it names no commit.',
  )

  return {
    metric: condition.id,
    label,
    headline,
    context,
    cumulativePercent: w.cumulativePercent,
    points: w.points.length,
    largestStepPercent: w.largestStep.percent,
    prThresholdPercent: condition.prThresholdPercent,
    from: { sha: w.first.sha, value: w.first.value },
    to: { sha: w.latest.sha, value: w.latest.value },
    cumulativeAbsolute: w.cumulativeAbsolute,
    unit: condition.unit,
    netShare: Math.round(w.netShare * 100) / 100,
    protocolLabel: condition.protocolLabel,
  }
}

/** The counterpart sentence: an alert that has been earned back. */
export function resolutionSentence(
  id: string,
  nowPercent: number,
  alertedPercent: number,
  alertedAt: string,
): string {
  return (
    `${metricLabel(id)} drift has retreated to ${signed(nowPercent)}%, from the ${signed(alertedPercent)}% alerted on ${alertedAt.slice(0, 10)} — ` +
    `at or under ${ALERT_RESOLVE_PERCENT}%, half the ${ALERT_CUMULATIVE_PERCENT}% alert line, the condition is considered resolved.`
  )
}

/**
 * The one place a metric id becomes words.
 *
 * The perf-data index stores values, not labels — labels are made at measure time and not carried
 * — so every consumer of stored history re-derives them, and they must all derive the SAME words:
 * a reader should not have to learn two names for one metric. The terminal movement report reads
 * these too.
 */
export function metricLabel(id: string): string {
  if (id === 'build_time') return 'build time'
  if (id === 'install_time') return 'install time'
  if (id === 'client_bundle_size') return 'client bundle size'
  if (id === 'build_output_size') return 'build output size'
  if (id === 'bundle_size') return 'bundle size'
  const [kind, ...rest] = id.split(':')
  const route = rest.join(':')
  switch (kind) {
    case 'route_latency':
      return `route ${route}`
    case 'lcp':
      return `LCP ${route}`
    case 'fcp':
      return `FCP ${route}`
    case 'tbt':
      return `TBT ${route}`
    case 'transfer_size':
      return `transfer size ${route}`
    default:
      return id
  }
}

function spanPhrase(points: number, span?: AlertSpan): string {
  if (span && span.commits > points) return `${points} measured points spanning ${span.commits} commits`
  return `${points} commits`
}

function signed(percent: number): string {
  return percent > 0 ? `+${percent}` : `${percent}`
}
