import {
  ALERT_CUMULATIVE_PERCENT,
  ALERT_MIN_POINTS,
  ALERT_RESOLVE_PERCENT,
  ALERT_WORSEN_STEP_PERCENT,
  buildStamp,
} from '../../core/index.js'
import type { AlertEvent, AlertPayload, BuildIdentity } from '../../core/index.js'
import { formatValue } from './format.js'

/**
 * The drift alert as a GitHub issue — the product surface for M10.
 *
 * An issue, not a comment, because drift is a claim about the default branch: there is no pull
 * request to attach it to, and the thing being reported outlives any one push. One issue per open
 * condition, maintained in place through four transitions:
 *
 *   opened      the condition crossed the alert line for the first time
 *   widened     another full threshold step beyond what was last said (comment + title update)
 *   resolved    measured back down from the point the alert was raised (comment + close)
 *   superseded  the claim can no longer be continued (comment + close) — NOT resolved
 *
 * The fourth is the one worth getting right. "Superseded" means the ground moved: the starting
 * point the drift was measured from is no longer in a comparable segment, so there is no
 * measurement showing recovery AND none showing persistence. Reporting that as "resolved" would
 * be a recovery we never measured (hard rule 3); reporting it as still-open would be a claim we
 * can no longer support. It is retired on provenance, and the issue says exactly that.
 */

const MARKER_PREFIX = 'driftwatch:alert'

export function alertIssueMarker(metric: string): string {
  return `<!-- ${MARKER_PREFIX}:${metric} -->`
}

export function renderAlertIssue(
  payload: AlertPayload,
  build?: BuildIdentity,
): { readonly title: string; readonly body: string } {
  return {
    title: alertIssueTitle(payload),
    body: [
      alertIssueMarker(payload.metric),
      '',
      `**${payload.headline}**`,
      '',
      'That last clause is why this issue exists: every step was small enough that no pull request',
      'reported it, so nothing in the PR flow could have caught this.',
      '',
      ...factsTable(payload),
      '',
      ...whatThisIs(),
      '',
      '**How this issue maintains itself.**',
      `- widens by another ${ALERT_WORSEN_STEP_PERCENT} points → a comment here, and the title updates`,
      `- retreats to ${ALERT_RESOLVE_PERCENT}% or less → closed, with the measured retreat`,
      '- the protocol segment breaks → closed as **superseded**, which is not the same as resolved',
      '',
      footer(build),
    ].join('\n'),
  }
}

/** The title carries the current claim: it is what a reader sees in a list of issues. */
export function alertIssueTitle(payload: AlertPayload): string {
  return `${payload.label} has drifted ${signed(round1(payload.cumulativePercent))}% over ${payload.points} commits`
}

export function renderWidenedComment(
  payload: AlertPayload,
  previousPercent: number,
  build?: BuildIdentity,
): string {
  return [
    '### Drift widened',
    '',
    `**${payload.headline}**`,
    '',
    `It has moved another ${round1(payload.cumulativePercent - previousPercent)} points since this issue was raised —`,
    `one full alert step, which is the only thing that makes driftwatch speak twice about the same condition.`,
    '',
    ...factsTable(payload),
    '',
    footer(build),
  ].join('\n')
}

export function renderResolvedComment(
  event: Extract<AlertEvent, { kind: 'resolved' }>,
  build?: BuildIdentity,
): string {
  return [
    '### Resolved — measured back down',
    '',
    event.sentence,
    '',
    `Measured from the same starting point this issue opened on (\`${short(event.record.windowStartSha)}\`), under the`,
    'same protocol — the retreat is a measurement, not an assumption. Closing.',
    '',
    footer(build),
  ].join('\n')
}

export function renderSupersededComment(
  event: Extract<AlertEvent, { kind: 'superseded' }>,
  build?: BuildIdentity,
): string {
  const ground =
    event.cause === 'protocol-break'
      ? [
          `This issue reported drift measured from \`${short(event.record.windowStartSha)}\`. That starting point is no`,
          'longer inside a comparable protocol segment, so the run it belonged to cannot be extended and',
          'cannot be compared against.',
          '',
          ...(event.record.protocolLabel && event.nowProtocolLabel
            ? [
                `| | |`,
                `| --- | --- |`,
                `| Measured under | ${escapeCell(event.record.protocolLabel)} |`,
                `| Now measured under | ${escapeCell(event.nowProtocolLabel)} |`,
              ]
            : []),
        ]
      : [
          'This metric is no longer present in the recorded history, so there is nothing left to measure',
          'the original claim against.',
        ]

  return [
    '### Closed as superseded — not resolved',
    '',
    ...ground,
    '',
    `There is therefore **no measurement showing the drift came back down, and none showing it persists**.`,
    'Driftwatch does not report a recovery it did not measure, so this claim is retired on provenance',
    'rather than on evidence — which is a weaker thing than resolution, and is being called by its own',
    'name for that reason.',
    '',
    `If the drift is still there, it will be reported again as a new alert once ${ALERT_MIN_POINTS} points have`,
    'accumulated under the current protocol.',
    '',
    footer(build),
  ].join('\n')
}

function factsTable(payload: AlertPayload): string[] {
  const rows: [string, string][] = [
    ['Cumulative', `${signed(payload.cumulativePercent)}% (${formatSignedValue(payload.cumulativeAbsolute, payload.unit)})`],
    ['Window', `\`${short(payload.from.sha)}\` → \`${short(payload.to.sha)}\`, ${payload.points} measured points`],
    [
      'Largest single step',
      `${signed(payload.largestStepPercent)}% — the PR threshold is ${payload.prThresholdPercent}%`,
    ],
    ['Movement kept', `${Math.round(payload.netShare * 100)}% of all movement went one way`],
  ]
  if (payload.protocolLabel) rows.push(['Protocol', payload.protocolLabel])

  return ['| | |', '| --- | --- |', ...rows.map(([k, v]) => `| ${k} | ${escapeCell(v)} |`)]
}

function whatThisIs(): string[] {
  return [
    '**What this is.** Drift is a *tendency* over landed history — it names no commit. Driftwatch',
    'attributes a change to a commit only where the measurement licenses it; a drift spread across',
    'many small steps has no single author, and this issue does not invent one.',
  ]
}

/** Build identity on every output (spec v50) — injectable so goldens pin text, not a timestamp. */
function footer(build?: BuildIdentity): string {
  const stamp = build ? buildStamp(build) : buildStamp()
  return `<sub>${stamp} · alert line ${ALERT_CUMULATIVE_PERCENT}% cumulative within one protocol segment</sub>`
}

function formatSignedValue(absolute: number, unit: 'ms' | 'bytes'): string {
  return `${absolute > 0 ? '+' : '−'}${formatValue(Math.abs(absolute), unit)}`
}

const short = (sha: string) => sha.slice(0, 10)
const round1 = (n: number) => Math.round(n * 10) / 10
const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`)

/** Pipes would split a table cell; protocol labels and reasons are free text. */
const escapeCell = (text: string) => text.replaceAll('|', '\\|')
