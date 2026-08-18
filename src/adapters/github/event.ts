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
    }
  | { readonly kind: 'not-a-pr'; readonly reason: string }

interface PullRequestPayload {
  pull_request?: {
    number?: number
    base?: { sha?: string; ref?: string }
    head?: { sha?: string }
  }
}

export async function parseActionEvent(
  env: NodeJS.ProcessEnv,
  readFileImpl: (path: string) => Promise<string> = (p) => readFile(p, 'utf8'),
): Promise<ActionEvent> {
  const eventName = env.GITHUB_EVENT_NAME ?? '(unset)'
  if (eventName !== 'pull_request' && eventName !== 'pull_request_target') {
    return {
      kind: 'not-a-pr',
      reason: `driftwatch runs on pull_request events; this is "${eventName}" — nothing to do`,
    }
  }

  const repository = env.GITHUB_REPOSITORY
  const [owner, repo] = repository?.split('/') ?? []
  if (!owner || !repo) {
    return { kind: 'not-a-pr', reason: 'GITHUB_REPOSITORY is not set or malformed' }
  }

  const eventPath = env.GITHUB_EVENT_PATH
  if (!eventPath) {
    return { kind: 'not-a-pr', reason: 'GITHUB_EVENT_PATH is not set — not running under Actions?' }
  }

  let payload: PullRequestPayload
  try {
    payload = JSON.parse(await readFileImpl(eventPath)) as PullRequestPayload
  } catch (error) {
    return { kind: 'not-a-pr', reason: `could not read the event payload: ${(error as Error).message}` }
  }

  const pr = payload.pull_request
  if (
    typeof pr?.number !== 'number' ||
    typeof pr.base?.sha !== 'string' ||
    typeof pr.base.ref !== 'string' ||
    typeof pr.head?.sha !== 'string'
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
  }
}
