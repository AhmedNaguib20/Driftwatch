import type { GithubClient } from './api-client.js'
import { COMMENT_MARKER } from './render-comment.js'

/**
 * The §6.1 hard requirement: ONE driftwatch comment per PR, updated in place — never a comment
 * per push. Upsert targets the hidden marker; if listing ever finds more than one (a past bug, a
 * race between concurrent runs), the first is updated and the rest deleted — self-healing.
 */

export interface CommentTarget {
  readonly owner: string
  readonly repo: string
  readonly prNumber: number
}

interface IssueComment {
  readonly id: number
  readonly body?: string
  readonly html_url?: string
}

export async function upsertComment(
  client: GithubClient,
  target: CommentTarget,
  body: string,
): Promise<{ url: string | null; healed: number }> {
  const { owner, repo, prNumber } = target
  const existing = await findMarkerComments(client, target)

  if (existing.length === 0) {
    const { json } = await client.request(
      'POST',
      `/repos/${owner}/${repo}/issues/${prNumber}/comments`,
      { body },
    )
    return { url: (json as IssueComment)?.html_url ?? null, healed: 0 }
  }

  const [first, ...extras] = existing
  const { json } = await client.request(
    'PATCH',
    `/repos/${owner}/${repo}/issues/comments/${first!.id}`,
    { body },
  )
  for (const extra of extras) {
    await client.request('DELETE', `/repos/${owner}/${repo}/issues/comments/${extra.id}`)
  }
  return { url: (json as IssueComment)?.html_url ?? null, healed: extras.length }
}

/** Paginated: on a busy PR the marker comment can sit far past page 1. */
async function findMarkerComments(
  client: GithubClient,
  target: CommentTarget,
): Promise<IssueComment[]> {
  const found: IssueComment[] = []
  for (let page = 1; ; page += 1) {
    const { json } = await client.request(
      'GET',
      `/repos/${target.owner}/${target.repo}/issues/${target.prNumber}/comments?per_page=100&page=${page}`,
    )
    const comments = (json as IssueComment[]) ?? []
    found.push(...comments.filter((c) => c.body?.includes(COMMENT_MARKER)))
    if (comments.length < 100) return found
  }
}
