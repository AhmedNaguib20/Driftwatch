import type { ResultJson } from '../../core/index.js'
import { createGithubClient } from './api-client.js'
import type { GithubClientOptions } from './api-client.js'
import { publishCheck } from './checks.js'
import { upsertComment } from './comments.js'
import { classifyFailure } from './failure-class.js'
import { renderPrerequisiteStanza } from './prerequisites.js'
import { renderCheckSummary, renderCheckTitle, renderComment } from './render-comment.js'

/**
 * The one call the Action entry makes: render, upsert the comment, publish the check. Pure
 * wiring — no rendering logic here. Nothing in this function throws.
 *
 * Failures split two ways (§9f). TRANSIENT ones — GitHub down, rate limited, a dropped socket —
 * stay warnings on a green run, which is what warn-only (§6.2) was written for. CONFIGURATION
 * ones become BLOCKERS: a missing token or an unwritable repository does not self-heal, and a
 * green tick with no comment is indistinguishable from "nothing regressed" to whoever reads the
 * pull request. The caller fails the run on those, carrying the same paste-able block the
 * preflight uses.
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
  /** Fork PRs never see repository secrets — the keyless note says so instead of giving advice. */
  readonly fromFork?: boolean
  readonly fetchImpl?: typeof fetch
  readonly sleep?: (ms: number) => Promise<void>
}

export interface PublishBlocker {
  /** What could not be delivered, in the reader's terms. */
  readonly what: string
  /** The underlying error, kept so the log still carries GitHub's own words. */
  readonly cause: string
  /** The complete workflow block that fixes it. */
  readonly stanza: string
}

export interface PublishOutcome {
  readonly commentUrl: string | null
  readonly checkUrl: string | null
  /** Transient only. Anything here is compatible with a green run. */
  readonly warnings: readonly string[]
  /** Configuration. Non-empty means the run must not be green. */
  readonly blockers: readonly PublishBlocker[]
}

export async function publishResult(
  result: ResultJson,
  ctx: PublishContext,
): Promise<PublishOutcome> {
  const warnings: string[] = []
  const blockers: PublishBlocker[] = []
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
      renderComment(result, {
        runUrl: ctx.runUrl ?? null,
        fixPr: ctx.fixPr ?? null,
        fixPrNote: ctx.fixPrNote ?? null,
        fromFork: ctx.fromFork ?? false,
      }),
    )
    commentUrl = url
    if (healed > 0) warnings.push(`removed ${healed} duplicate driftwatch comment(s)`)
  } catch (error) {
    record(error, 'the pull request comment could not be posted', 'permissions')
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
    record(error, 'the check reporting the verdict could not be published', 'permissions')
  }

  return { commentUrl, checkUrl, warnings, blockers }

  /**
   * One place decides green-or-not, so the two call sites cannot drift apart. Fork PRs are the
   * one configuration failure that is NOT the user's to fix — their tokens are read-only by
   * design — so they stay a warning.
   */
  function record(error: unknown, what: string, id: 'token' | 'permissions'): void {
    const cause = (error as Error).message
    if (ctx.fromFork || classifyFailure(error) === 'transient') {
      warnings.push(`${what}: ${cause}`)
      return
    }
    blockers.push({ what, cause, stanza: renderPrerequisiteStanza([{ id, detail: `${what}.` }]) })
  }
}
