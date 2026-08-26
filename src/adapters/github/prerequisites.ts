import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { GithubError, createGithubClient } from './api-client.js'
import type { GithubClient } from './api-client.js'
import { PUBLISHED_ACTION } from './workflow-template.js'

/**
 * Everything driftwatch needs from a workflow, checked ONCE, before any measurement (spec §9f).
 *
 * The Marketplace listing hands a visitor two lines — `- name:` and `- uses:` — with no
 * `fetch-depth`, no `env:` and no `permissions:`. So a visitor is GUARANTEED to be missing all
 * three, and they used to discover them one at a time: the first after 16 seconds, the second
 * after a 3.5-minute measurement, the third after another. Four round trips to a posted comment.
 *
 * Everything here is knowable in about a second, so it is all asked at once and answered in one
 * paste-able block. `driftwatch init --github` writes these answers itself, which is exactly why
 * none of this surfaced until someone walked the Marketplace path.
 *
 * Honesty rule: what cannot be CHECKED is not REPORTED as missing. With no token the permission
 * probe cannot run, so permissions appear in the block as a requirement, never in the findings
 * as a fault.
 */

const exec = promisify(execFile)

export type PrerequisiteId = 'base' | 'token' | 'permissions'

export interface MissingPrerequisite {
  readonly id: PrerequisiteId
  readonly detail: string
}

export interface PrerequisiteReport {
  readonly ok: boolean
  readonly missing: readonly MissingPrerequisite[]
  /** Complete and paste-able; empty when nothing is missing. */
  readonly stanza: string
}

export interface PrerequisiteInput {
  readonly cwd: string
  readonly baseSha: string
  readonly token: string | null
  readonly owner: string
  readonly repo: string
  readonly prNumber: number
  readonly fetchImpl?: typeof fetch
  /** Injected by tests; production builds one from the token. */
  readonly client?: GithubClient
}

export async function checkPrerequisites(input: PrerequisiteInput): Promise<PrerequisiteReport> {
  const missing: MissingPrerequisite[] = []

  if (!(await baseIsReachable(input.cwd, input.baseSha))) {
    missing.push({
      id: 'base',
      detail: `The PR base commit ${input.baseSha.slice(0, 12)} is not in this checkout — actions/checkout fetches one commit by default, and driftwatch measures the base too.`,
    })
  }

  if (!input.token) {
    missing.push({
      id: 'token',
      detail:
        'GITHUB_TOKEN is not set, so the measurement could not be posted to the pull request.',
    })
  } else {
    const client = input.client ?? createGithubClient({ token: input.token, fetchImpl: input.fetchImpl })
    const probe = await probePermissions(client, input)
    if (probe === 'denied') {
      missing.push({
        id: 'permissions',
        detail:
          "The token cannot read this pull request's comments, so it cannot post one either — this repository's default workflow permissions are read-only.",
      })
    }
    // 'unknown' (network, rate limit) is deliberately not a finding: a prerequisite that could
    // not be checked is not a prerequisite that failed.
  }

  return {
    ok: missing.length === 0,
    missing,
    stanza: missing.length === 0 ? '' : renderPrerequisiteStanza(missing),
  }
}

async function baseIsReachable(cwd: string, baseSha: string): Promise<boolean> {
  try {
    await exec('git', ['-C', cwd, 'cat-file', '-e', `${baseSha}^{commit}`])
    return true
  } catch {
    return false
  }
}

/**
 * The probe is the exact call that fails first in practice: listing the PR's comments. It is a
 * GET, so it changes nothing, and a read-only token is refused by it.
 *
 * It cannot prove WRITE access — GitHub offers no side-effect-free way to ask. A write that is
 * refused later is classified as configuration and fails the run with this same block, so the
 * gap is covered rather than guessed at.
 */
async function probePermissions(
  client: GithubClient,
  input: PrerequisiteInput,
): Promise<'granted' | 'denied' | 'unknown'> {
  try {
    await client.request(
      'GET',
      `/repos/${input.owner}/${input.repo}/issues/${input.prNumber}/comments?per_page=1`,
    )
    return 'granted'
  } catch (error) {
    if (error instanceof GithubError && error.kind === 'auth') return 'denied'
    return 'unknown'
  }
}

/**
 * One block that fixes everything at once. It shows the whole job rather than the missing lines:
 * a reader comparing three fragments against their own file makes mistakes, and a reader
 * replacing one block does not.
 */
export function renderPrerequisiteStanza(missing: readonly MissingPrerequisite[]): string {
  const ids = new Set(missing.map((m) => m.id))
  const count = missing.length
  const lines: string[] = [
    count === 1
      ? 'driftwatch cannot run yet — one prerequisite is missing:'
      : `driftwatch cannot run yet — ${count} prerequisites are missing:`,
    '',
  ]
  missing.forEach((m, i) => lines.push(`  ${i + 1}. ${m.detail}`))
  lines.push(
    '',
    count === 1
      ? 'This workflow fixes it. Replace your driftwatch job with it:'
      : 'This one workflow fixes all of them. Replace your driftwatch job with it:',
    '',
    '    permissions:',
    // `contents: read` is not optional and not decorative. Naming a `permissions:` block at all
    // sets every scope NOT listed in it to none — so a block that lists only what driftwatch
    // writes silently revokes the read access actions/checkout needs, and the job dies with
    // "Repository not found" before driftwatch is ever reached. The first version of this block
    // did exactly that, and the visitor gate caught it on the paste.
    '      contents: read         # actions/checkout — a permissions block sets everything it',
    '                             # does not name to none, so this must be listed. Record mode',
    '                             # (pushing trend points to perf-data) needs write instead.',
    '      pull-requests: write   # the self-updating comment on the pull request',
    '      checks: write          # the check run carrying the verdict',
    '      statuses: write        # the commit-status fallback, used when checks are unavailable',
    '',
    '    jobs:',
    '      driftwatch:',
    '        runs-on: ubuntu-latest',
    '        steps:',
    '          - uses: actions/checkout@v4',
    '            with:',
    '              fetch-depth: 0',
    '',
    '          - name: Driftwatch Performance',
    `            uses: ${PUBLISHED_ACTION}`,
    '            env:',
    '              GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}',
    '',
  )

  // Only the notes that apply, so the block stays short enough to be read.
  if (ids.has('token') || ids.has('permissions')) {
    lines.push(
      'GITHUB_TOKEN is provided by Actions — nothing needs creating. `permissions:` may sit at the',
      'top of the file, covering every job, or inside the driftwatch job as shown.',
    )
  }
  if (!ids.has('permissions') && ids.has('token')) {
    lines.push(
      'Permissions could not be checked without a token, so the block above includes the ones',
      'driftwatch needs to post.',
    )
  }
  if (ids.has('base')) {
    lines.push(
      '`fetch-depth: 0` is what lets driftwatch check the base commit out into a temporary worktree',
      'and measure both sides under one protocol. A shallow clone has nothing to compare against.',
    )
  }
  return lines.join('\n')
}
