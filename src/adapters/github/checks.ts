import type { GithubClient } from './api-client.js'
import { GithubError } from './api-client.js'
import type { RunVerdict } from '../../core/index.js'

/**
 * The CI check (§6.2): success for ok, NEUTRAL for a regression while block_merge is false —
 * warn-only is the default because a newly installed tool that blocks merges gets uninstalled,
 * not fixed. failure only when the team opted into block_merge. Inconclusive is neutral with the
 * reason up front.
 */

export interface CheckTarget {
  readonly owner: string
  readonly repo: string
  readonly headSha: string
}

export interface CheckContent {
  readonly verdict: RunVerdict
  readonly blockMerge: boolean
  readonly title: string
  /** Markdown; checks render it, so the verdict + table stay visible even without a comment. */
  readonly summary: string
}

export function conclusionFor(verdict: RunVerdict, blockMerge: boolean): 'success' | 'neutral' | 'failure' {
  if (verdict === 'ok') return 'success'
  if (verdict === 'regression') return blockMerge ? 'failure' : 'neutral'
  return 'neutral' // inconclusive — we cannot honestly pass or fail what we could not compare
}

export async function publishCheck(
  client: GithubClient,
  target: CheckTarget,
  content: CheckContent,
): Promise<{ url: string | null; via: 'check-run' | 'commit-status' }> {
  const conclusion = conclusionFor(content.verdict, content.blockMerge)

  try {
    const { json } = await client.request('POST', `/repos/${target.owner}/${target.repo}/check-runs`, {
      name: 'driftwatch',
      head_sha: target.headSha,
      status: 'completed',
      conclusion,
      output: { title: content.title, summary: content.summary.slice(0, 65_000) },
    })
    return { url: (json as { html_url?: string })?.html_url ?? null, via: 'check-run' }
  } catch (error) {
    // checks:write unavailable (fine-grained token, fork) → commit status fallback.
    if (!(error instanceof GithubError && error.kind === 'auth')) throw error
  }

  // Commit statuses have no "neutral": a warn-only regression maps to success with the truth in
  // the description — the comment carries the full story; failure stays reserved for block_merge.
  const state = conclusion === 'failure' ? 'failure' : 'success'
  const description =
    content.verdict === 'regression' && !content.blockMerge
      ? `⚠ ${content.title} (warn-only)`
      : content.title
  const { json } = await client.request(
    'POST',
    `/repos/${target.owner}/${target.repo}/statuses/${target.headSha}`,
    { state, context: 'driftwatch', description: description.slice(0, 140) },
  )
  return { url: (json as { url?: string })?.url ?? null, via: 'commit-status' }
}
