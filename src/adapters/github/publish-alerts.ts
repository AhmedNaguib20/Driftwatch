import { ALERT_CUMULATIVE_PERCENT, nextState } from '../../core/index.js'
import type { AlertAssessment, AlertState } from '../../core/index.js'
import { createGithubClient } from './api-client.js'
import type { GithubClientOptions } from './api-client.js'
import { deliverAlertEvent } from './alert-issues.js'
import type { DeliveredEvent } from './alert-issues.js'

/**
 * The one call the scheduled Action makes. Nothing here throws: a broken publish must never fail
 * the user's CI (§6.2), and a drift alert is the least urgent thing in the repository.
 *
 * Two rules shape the return value:
 *
 *  1. **State records what was SAID.** Only delivered events reach the persisted state. If the
 *     issue could not be opened, nothing is written down, and the next scheduled run says it
 *     again — the alternative is a suppressed condition nobody was ever told about.
 *  2. **Silence is a result, and it is reported.** The quiet path makes zero API calls and
 *     returns a line saying what was looked at and why nothing was said. A tool that is silent
 *     without saying why is indistinguishable from a tool that is broken.
 */

export interface AlertPublishContext {
  readonly owner: string
  readonly repo: string
  /** Absent ⇒ nothing is published; the decision is still reported and nothing is recorded. */
  readonly token?: string
  readonly fetchImpl?: typeof fetch
  readonly sleep?: (ms: number) => Promise<void>
}

export interface AlertPublishOutcome {
  readonly delivered: readonly DeliveredEvent[]
  readonly warnings: readonly string[]
  /** True when nothing was created, commented or closed — the normal state. */
  readonly quiet: boolean
  /** One line, always printed: what was looked at, and what was said about it. */
  readonly log: string
  /** The state to persist. Identical to the prior state when nothing was delivered. */
  readonly state: AlertState
}

export async function publishAlerts(
  assessment: AlertAssessment,
  prior: AlertState,
  ctx: AlertPublishContext,
): Promise<AlertPublishOutcome> {
  const warnings: string[] = []
  const speaking = assessment.events.filter(
    (e) => e.kind === 'fire' || e.kind === 'resolved' || e.kind === 'superseded',
  )

  if (speaking.length === 0) {
    return { delivered: [], warnings, quiet: true, log: quietLine(assessment, prior), state: prior }
  }

  if (!ctx.token) {
    return {
      delivered: [],
      warnings: ['GITHUB_TOKEN is not set — the alert decision was made but nothing was published'],
      quiet: true,
      log: `driftwatch alerts: ${speaking.length} thing(s) to say and no token to say them with — nothing published, nothing recorded`,
      state: prior,
    }
  }

  const options: GithubClientOptions = {
    token: ctx.token,
    ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
    ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
  }
  const client = createGithubClient(options)
  const target = { owner: ctx.owner, repo: ctx.repo }

  const delivered: DeliveredEvent[] = []
  for (const event of speaking) {
    try {
      const outcome = await deliverAlertEvent(client, target, event)
      if (outcome) delivered.push(outcome)
    } catch (error) {
      // Per event: one metric's issue failing must not silence the others.
      warnings.push(`${event.metric}: ${(error as Error).message.split('\n')[0]}`)
    }
  }

  const state = nextState(
    prior,
    delivered.map((d) => (d.event.kind === 'fire' && d.record ? { ...d.event, record: d.record } : d.event)),
  )

  return {
    delivered,
    warnings,
    quiet: delivered.length === 0,
    log: delivered.length === 0
      ? `driftwatch alerts: nothing could be published (${warnings.length} failure(s)) — nothing recorded, so the next run will try again`
      : `driftwatch alerts: ${delivered.map((d) => `${d.event.metric} ${d.action}`).join(', ')}`,
    state,
  }
}

/** Silence, itemised: what was assessed, what was open, and what is never assessed at all. */
function quietLine(assessment: AlertAssessment, prior: AlertState): string {
  const assessed = assessment.events.length
  const holding = assessment.events.filter((e) => e.kind === 'holding').length
  const parts = [
    `${assessed} metric(s) assessed, none past the ${ALERT_CUMULATIVE_PERCENT}% line`,
    `${prior.open.length} open condition(s)${holding > 0 ? `, ${holding} held quiet` : ''}`,
    `${assessment.notLicensed.length} never alerted (licence)`,
  ]
  return `driftwatch alerts: quiet — nothing created, nothing commented (${parts.join('; ')})`
}
