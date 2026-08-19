import type { ResultJson } from '../../core/index.js'
import type { GithubClient } from './api-client.js'
import { fixBranchName, pushFixBranch } from './fix-branch.js'
import { FIX_PR_MARKER, renderFixPrBody, renderFixPrTitle } from './render-fix-pr.js'
import { formatValue } from './format.js'

/**
 * The verified-fix PR (M6): opens INTO the original PR's branch, so merging it updates their PR.
 * Gates are absolute: auto_fix must be 'propose' and the verification outcome restored/partial —
 * nothing else EVER opens a PR; everything else stays in the comment. Upsert semantics like the
 * comment: re-runs force-update the branch and edit the same PR; a stored diff that stopped
 * applying closes our PR with one line saying why — self-healing, never stale.
 */

export interface FixPrContext {
  readonly owner: string
  readonly repo: string
  readonly prNumber: number
  readonly headRef: string
  readonly headSha: string
  readonly fromFork: boolean
  readonly gitRoot: string
}

export type FixPrOutcome =
  | { readonly kind: 'opened' | 'updated'; readonly number: number; readonly url: string; readonly summary: string }
  | { readonly kind: 'closed-stale'; readonly number: number }
  | { readonly kind: 'skipped'; readonly reason: string; readonly commentLine: string | null }

export async function proposeFixPr(
  client: GithubClient,
  ctx: FixPrContext,
  result: ResultJson,
): Promise<FixPrOutcome> {
  const verification = result.verification
  const skip = (reason: string, commentLine: string | null = null): FixPrOutcome => ({
    kind: 'skipped',
    reason,
    commentLine,
  })

  if (result.config.auto_fix !== 'propose') return skip('auto_fix is off')
  if (!verification) return skip('no verification block')

  const existing = await findExistingFixPr(client, ctx)

  if (verification.outcome === 'not-applicable' && existing) {
    // Self-healing: a new push made the stored diff stale — close rather than mislead.
    await client.request('POST', `/repos/${ctx.owner}/${ctx.repo}/issues/${existing.number}/comments`, {
      body: 'Closing: a new push to the PR made this verified fix no longer apply cleanly. A fresh fix will be proposed if the next run verifies one.',
    })
    await client.request('PATCH', `/repos/${ctx.owner}/${ctx.repo}/pulls/${existing.number}`, { state: 'closed' })
    return { kind: 'closed-stale', number: existing.number }
  }

  if (verification.outcome !== 'restored' && verification.outcome !== 'partial') {
    return skip(`verification outcome is ${verification.outcome} — only restored/partial may open a PR`)
  }
  if (!verification.diff) return skip('verification carries no diff')

  if (ctx.fromFork) {
    return skip(
      'PR head lives in a fork — driftwatch cannot push branches there',
      'a verified fix exists, but fix branches cannot be pushed to fork PRs — the diff is in the analysis above',
    )
  }

  const pushed = await pushFixBranch({
    gitRoot: ctx.gitRoot,
    headSha: ctx.headSha,
    prNumber: ctx.prNumber,
    diff: verification.diff,
    message: `${renderFixPrTitle(result, verification)}\n\nMeasured by driftwatch before proposing — see the PR body for the numbers.`,
  })
  if (!pushed.ok) return skip(pushed.reason)

  const title = renderFixPrTitle(result, verification)
  const body = renderFixPrBody(result, verification)
  const summary = summaryLine(verification)

  if (existing) {
    const { json } = await client.request('PATCH', `/repos/${ctx.owner}/${ctx.repo}/pulls/${existing.number}`, {
      title,
      body,
    })
    return { kind: 'updated', number: existing.number, url: (json as { html_url?: string })?.html_url ?? existing.url, summary }
  }

  const { json } = await client.request('POST', `/repos/${ctx.owner}/${ctx.repo}/pulls`, {
    title,
    body,
    head: fixBranchName(ctx.prNumber),
    base: ctx.headRef,
    maintainer_can_modify: true,
  })
  const created = json as { number?: number; html_url?: string }
  return { kind: 'opened', number: created.number ?? 0, url: created.html_url ?? '', summary }
}

function summaryLine(verification: NonNullable<ResultJson['verification']>): string {
  // Summarize with a row that recovered — never an indistinguishable or unrecovered one.
  const m =
    verification.metrics.find((x) => x.verdict === 'restored' || x.verdict === 'partial') ??
    verification.metrics[0]
  if (!m) return 'measured'
  return `${m.label} ${formatValue(m.current, m.unit ?? 'bytes')}→${formatValue(m.fixed, m.unit ?? 'bytes')}, measured`
}

async function findExistingFixPr(
  client: GithubClient,
  ctx: FixPrContext,
): Promise<{ number: number; url: string } | null> {
  const { json } = await client.request(
    'GET',
    `/repos/${ctx.owner}/${ctx.repo}/pulls?state=open&head=${ctx.owner}:${fixBranchName(ctx.prNumber)}&per_page=10`,
  )
  const prs = (json as { number: number; html_url?: string; body?: string }[]) ?? []
  const ours = prs.find((pr) => pr.body?.includes(FIX_PR_MARKER))
  return ours ? { number: ours.number, url: ours.html_url ?? '' } : null
}
