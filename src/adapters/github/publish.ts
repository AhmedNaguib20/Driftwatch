import type { ResultJson } from '../../core/index.js'
import { createGithubClient } from './api-client.js'
import type { GithubClientOptions } from './api-client.js'
import { publishCheck } from './checks.js'
import { upsertComment } from './comments.js'
import { renderCheckSummary, renderCheckTitle, renderComment } from './render-comment.js'

/**
 * The one call the Action entry makes: render, upsert the comment, publish the check. Pure
 * wiring — no rendering logic here. Nothing in this function throws: every failure becomes a
 * warning, because a broken publish must never fail the user's CI run (warn-only, §6.2).
 */

export interface PublishContext {
  readonly owner: string
  readonly repo: string
  readonly prNumber: number
  readonly headSha: string
  readonly blockMerge: boolean
  readonly token: string
  /** Link target for the comment's "full accounting" pointer (the run's summary page). */
  readonly runUrl?: string | null
  readonly fixPr?: { readonly number: number; readonly url: string; readonly summary: string } | null
  readonly fixPrNote?: string | null
  readonly fetchImpl?: typeof fetch
  readonly sleep?: (ms: number) => Promise<void>
}

export interface PublishOutcome {
  readonly commentUrl: string | null
  readonly checkUrl: string | null
  readonly warnings: readonly string[]
}

export async function publishResult(
  result: ResultJson,
  ctx: PublishContext,
): Promise<PublishOutcome> {
  const warnings: string[] = []
  const clientOptions: GithubClientOptions = {
    token: ctx.token,
    fetchImpl: ctx.fetchImpl,
    sleep: ctx.sleep,
  }
  const client = createGithubClient(clientOptions)

  let commentUrl: string | null = null
  try {
    const { url, healed } = await upsertComment(
      client,
      { owner: ctx.owner, repo: ctx.repo, prNumber: ctx.prNumber },
      renderComment(result, { runUrl: ctx.runUrl ?? null, fixPr: ctx.fixPr ?? null, fixPrNote: ctx.fixPrNote ?? null }),
    )
    commentUrl = url
    if (healed > 0) warnings.push(`removed ${healed} duplicate driftwatch comment(s)`)
  } catch (error) {
    // Fork-PR tokens often cannot write comments — the check still carries the verdict + table.
    warnings.push(`could not post the PR comment: ${(error as Error).message}`)
  }

  let checkUrl: string | null = null
  try {
    const { url, via } = await publishCheck(
      client,
      { owner: ctx.owner, repo: ctx.repo, headSha: ctx.headSha },
      {
        verdict: result.verdict,
        blockMerge: ctx.blockMerge,
        title: renderCheckTitle(result),
        summary: renderCheckSummary(result),
      },
    )
    checkUrl = url
    if (via === 'commit-status') {
      warnings.push('checks:write unavailable — published a commit status instead')
    }
  } catch (error) {
    warnings.push(`could not publish the check: ${(error as Error).message}`)
  }

  return { commentUrl, checkUrl, warnings }
}
