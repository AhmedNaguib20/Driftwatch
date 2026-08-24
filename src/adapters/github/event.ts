import { readFile } from 'node:fs/promises'

/**
 * Parses the Actions event context. The action is meaningful only on pull_request events —
 * anything else is a clean no-op, not an error (people put `on: push` in workflows all the time;
 * scolding them with a red X for it helps nobody).
 */

export type ActionEvent =
  | {
      readonly kind: 'pull-request'
      readonly owner: string
      readonly repo: string
      readonly prNumber: number
      readonly baseSha: string
      readonly baseRef: string
      readonly headSha: string
      /** The PR branch's name — the base for a proposed fix PR. */
      readonly headRef: string
      /** True when the head lives in a fork: we cannot push branches there. */
      readonly fromFork: boolean
    }
  | {
      /** Push to the DEFAULT branch → record mode: measure the landed commit, append the trend. */
      readonly kind: 'record-push'
      readonly owner: string
      readonly repo: string
      readonly sha: string
      readonly branch: string
    }
  | {
      /** A scheduled (or manually dispatched) drift-alert run: reads history, measures nothing. */
      readonly kind: 'scheduled-alerts'
      readonly owner: string
      readonly repo: string
    }
  | { readonly kind: 'not-a-pr'; readonly reason: string }

interface EventPayload {
  pull_request?: {
    number?: number
    base?: { sha?: string; ref?: string }
    head?: { sha?: string; ref?: string; repo?: { full_name?: string } }
  }
  repository?: { default_branch?: string }
  after?: string
  ref?: string
}

export async function parseActionEvent(
  env: NodeJS.ProcessEnv,
  readFileImpl: (path: string) => Promise<string> = (p) => readFile(p, 'utf8'),
): Promise<ActionEvent> {
  const eventName = env.GITHUB_EVENT_NAME ?? '(unset)'
  const scheduled = eventName === 'schedule' || eventName === 'workflow_dispatch'
  if (
    eventName !== 'pull_request' &&
    eventName !== 'pull_request_target' &&
    eventName !== 'push' &&
    !scheduled
  ) {
    return {
      kind: 'not-a-pr',
      reason: `driftwatch runs on pull_request, push and schedule events; this is "${eventName}" — nothing to do`,
    }
  }

  const repository = env.GITHUB_REPOSITORY
  const [owner, repo] = repository?.split('/') ?? []
  if (!owner || !repo) {
    return { kind: 'not-a-pr', reason: 'GITHUB_REPOSITORY is not set or malformed' }
  }

  // Drift alerting needs no event payload at all: its whole input is the recorded history on the
  // perf-data branch. Parsing one would only invent a way to fail.
  if (scheduled) return { kind: 'scheduled-alerts', owner, repo }

  const eventPath = env.GITHUB_EVENT_PATH
  if (!eventPath) {
    return { kind: 'not-a-pr', reason: 'GITHUB_EVENT_PATH is not set — not running under Actions?' }
  }

  let payload: EventPayload
  try {
    payload = JSON.parse(await readFileImpl(eventPath)) as EventPayload
  } catch (error) {
    return { kind: 'not-a-pr', reason: `could not read the event payload: ${(error as Error).message}` }
  }

  if (eventName === 'push') {
    const defaultBranch = payload.repository?.default_branch
    const pushedBranch = payload.ref?.replace(/^refs\/heads\//, '')
    if (!defaultBranch || !pushedBranch || pushedBranch !== defaultBranch) {
      return {
        kind: 'not-a-pr',
        reason: `record mode runs only on pushes to the default branch (this push: "${pushedBranch ?? '?'}", default: "${defaultBranch ?? '?'}")`,
      }
    }
    if (typeof payload.after !== 'string' || /^0+$/.test(payload.after)) {
      return { kind: 'not-a-pr', reason: 'push payload has no usable head sha' }
    }
    return { kind: 'record-push', owner, repo, sha: payload.after, branch: pushedBranch }
  }

  const pr = payload.pull_request
  if (
    typeof pr?.number !== 'number' ||
    typeof pr.base?.sha !== 'string' ||
    typeof pr.base.ref !== 'string' ||
    typeof pr.head?.sha !== 'string' ||
    typeof pr.head.ref !== 'string'
  ) {
    return { kind: 'not-a-pr', reason: 'the event payload has no complete pull_request block' }
  }

  return {
    kind: 'pull-request',
    owner,
    repo,
    prNumber: pr.number,
    baseSha: pr.base.sha,
    baseRef: pr.base.ref,
    headSha: pr.head.sha,
    headRef: pr.head.ref,
    fromFork: (pr.head.repo?.full_name ?? repository) !== repository,
  }
}
