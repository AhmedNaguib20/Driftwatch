import type { AlertEvent, AlertRecord } from '../../core/index.js'
import type { GithubClient } from './api-client.js'
import {
  alertIssueMarker,
  alertIssueTitle,
  renderAlertIssue,
  renderResolvedComment,
  renderSupersededComment,
  renderWidenedComment,
} from './render-alert-issue.js'

/**
 * The issue mechanics behind the four transitions. Rendering lives next door; this file only
 * knows which calls to make and how to survive an issue that is no longer there.
 *
 * Finding the issue again is done by the handle stored in alert state, not by searching: the
 * previous run wrote down what it published, so the next one asks for that exact issue. Search
 * would be indexing-lagged (a just-opened issue can be invisible for seconds) and listing would
 * be paginated past the marker on a busy repo — both produce duplicates, which is the one failure
 * a self-updating surface must not have. If the handle 404s, the issue was deleted and a fresh
 * one is opened; the marker in the body stays as a human-readable trace of what it is.
 */

export const SURFACE_KIND = 'github-issue'

export interface AlertIssueTarget {
  readonly owner: string
  readonly repo: string
}

export interface DeliveredEvent {
  readonly event: AlertEvent
  /** The record to persist — carrying the surface handle for anything still open. */
  readonly record: AlertRecord | null
  readonly url: string | null
  readonly action: 'opened' | 'widened' | 'resolved' | 'superseded'
}

interface IssueResponse {
  readonly number?: number
  readonly html_url?: string
}

export async function deliverAlertEvent(
  client: GithubClient,
  target: AlertIssueTarget,
  event: AlertEvent,
): Promise<DeliveredEvent | null> {
  if (event.kind === 'fire') return deliverFire(client, target, event)
  if (event.kind === 'resolved') return closeIssue(client, target, event, renderResolvedComment(event), 'resolved')
  if (event.kind === 'superseded') {
    return closeIssue(client, target, event, renderSupersededComment(event), 'superseded')
  }
  // holding / quiet: the whole point is that nothing is said.
  return null
}

async function deliverFire(
  client: GithubClient,
  target: AlertIssueTarget,
  event: Extract<AlertEvent, { kind: 'fire' }>,
): Promise<DeliveredEvent> {
  const existing = event.record.surface?.kind === SURFACE_KIND ? Number(event.record.surface.ref) : null

  if (event.reason === 'worsened' && existing !== null) {
    const alive = await comment(
      client,
      target,
      existing,
      renderWidenedComment(event.payload, event.previousPercent ?? event.record.cumulativePercent),
    )
    if (alive) {
      // The title carries the current number: an issue list must not show a stale claim.
      await client
        .request('PATCH', `/repos/${target.owner}/${target.repo}/issues/${existing}`, {
          title: alertIssueTitle(event.payload),
        })
        .catch(() => undefined)
      return {
        event,
        record: withSurface(event.record, String(existing)),
        url: issueUrl(target, existing),
        action: 'widened',
      }
    }
  }

  const { title, body } = renderAlertIssue(event.payload)
  const { json } = await client.request('POST', `/repos/${target.owner}/${target.repo}/issues`, { title, body })
  const opened = json as IssueResponse
  return {
    event,
    record: withSurface(event.record, String(opened.number ?? '')),
    url: opened.html_url ?? null,
    action: 'opened',
  }
}

async function closeIssue(
  client: GithubClient,
  target: AlertIssueTarget,
  event: Extract<AlertEvent, { kind: 'resolved' | 'superseded' }>,
  body: string,
  action: 'resolved' | 'superseded',
): Promise<DeliveredEvent | null> {
  const number = event.record.surface?.kind === SURFACE_KIND ? Number(event.record.surface.ref) : null
  // Nothing was ever published for this condition (alerting ran without a token, or the open was
  // rejected). There is no issue to close, and inventing one to close would be theatre.
  if (number === null || Number.isNaN(number)) return { event, record: null, url: null, action }

  const alive = await comment(client, target, number, body)
  if (!alive) return { event, record: null, url: null, action }
  await client.request('PATCH', `/repos/${target.owner}/${target.repo}/issues/${number}`, { state: 'closed' })
  return { event, record: null, url: issueUrl(target, number), action }
}

/** False when the issue is gone (404) — deleted by a human, which is not our error to raise. */
async function comment(
  client: GithubClient,
  target: AlertIssueTarget,
  number: number,
  body: string,
): Promise<boolean> {
  try {
    await client.request('POST', `/repos/${target.owner}/${target.repo}/issues/${number}/comments`, { body })
    return true
  } catch (error) {
    if ((error as { status?: number }).status === 404) return false
    throw error
  }
}

function withSurface(record: AlertRecord, ref: string): AlertRecord {
  return ref === '' ? record : { ...record, surface: { kind: SURFACE_KIND, ref } }
}

function issueUrl(target: AlertIssueTarget, number: number): string {
  return `https://github.com/${target.owner}/${target.repo}/issues/${number}`
}

export { alertIssueMarker }
