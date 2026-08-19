import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { ResultJson } from '../report/types.js'
import { assessDrift } from './drift.js'
import { renderDashboard } from './dashboard/index.js'
import { appendEntry, emptyIndex, entryFromResult, parseIndex } from './index-file.js'
import { buildTimelines } from './timeline.js'

const exec = promisify(execFile)
const GIT_BUFFER = 64 * 1024 * 1024

/**
 * The perf-data branch writer (spec §6.3): results as JSON in a dedicated orphan branch of the
 * user's own repo — plain Git, portable, no backend. All work happens in a temp worktree; no
 * other branch and no working directory is ever touched (rule 2 discipline applies to the tool's
 * own branch mechanics too).
 *
 *  - perf-data absent → created as an orphan.
 *  - perf-data present WITHOUT our index marker → refuse. It is somebody else's branch.
 *  - Racing appends (two pushes landing together) → fetch-and-reapply once; a second conflict
 *    warns and gives up: a missing trend point is recoverable, a corrupted index is not.
 */

export const PERF_DATA_BRANCH = 'perf-data'

export interface AppendOutcome {
  readonly ok: boolean
  /** 'appended' | 'appended-after-retry' | a refusal/give-up reason. */
  readonly detail: string
}

export async function appendToPerfData(
  gitRoot: string,
  result: ResultJson,
  sha: string,
  branch: string | null,
  push: boolean,
): Promise<AppendOutcome> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const outcome = await tryAppend(gitRoot, result, sha, branch, push)
    if (outcome !== 'push-rejected') {
      return {
        ok: outcome === 'appended',
        detail: outcome === 'appended' && attempt === 2 ? 'appended-after-retry' : outcome,
      }
    }
  }
  return {
    ok: false,
    detail:
      'perf-data push rejected twice (concurrent runs racing) — giving up on this trend point; a missing point is recoverable, a corrupted index is not',
  }
}

type AttemptOutcome = 'appended' | 'push-rejected' | string

async function tryAppend(
  gitRoot: string,
  result: ResultJson,
  sha: string,
  branch: string | null,
  push: boolean,
): Promise<AttemptOutcome> {
  const parent = await mkdtemp(path.join(tmpdir(), 'driftwatch-perfdata-'))
  const tree = path.join(parent, 'tree')

  try {
    const hasRemote = await git(gitRoot, ['remote', 'get-url', 'origin']).then(() => true, () => false)
    if (push && hasRemote) {
      // Tolerate a missing remote branch; a fetch failure for other reasons surfaces on push.
      await git(gitRoot, ['fetch', 'origin', `${PERF_DATA_BRANCH}:refs/remotes/origin/${PERF_DATA_BRANCH}`]).catch(() => {})
    }

    const localRef = await resolvePerfDataRef(gitRoot)

    if (localRef) {
      await git(gitRoot, ['worktree', 'add', '--detach', tree, localRef])
    } else {
      // Orphan: an empty worktree seeded from git's empty tree, so the first commit has no parent
      // history from any other branch.
      await git(gitRoot, ['worktree', 'add', '--detach', tree, await emptyTreeCommit(gitRoot)])
    }

    // Ownership check BEFORE writing anything (refuse, never overwrite).
    const indexPath = path.join(tree, 'index.json')
    const existingRaw = await readFile(indexPath, 'utf8').catch(() => null)
    let index = emptyIndex()
    if (existingRaw !== null) {
      const parsed = parseIndex(existingRaw)
      if (parsed === null) {
        return `a "${PERF_DATA_BRANCH}" branch exists but its index.json is not driftwatch's — refusing to touch it (rename or remove the branch to let driftwatch own it)`
      }
      index = parsed
    } else if (localRef) {
      const files = (await git(gitRoot, ['ls-tree', '-r', '--name-only', localRef])).trim()
      if (files.length > 0) {
        return `a "${PERF_DATA_BRANCH}" branch exists with content that is not driftwatch's — refusing to touch it`
      }
    }

    await mkdir(path.join(tree, 'results'), { recursive: true })
    await writeFile(
      path.join(tree, 'results', `${sha.slice(0, 12)}.json`),
      JSON.stringify(result, null, 2) + '\n',
      'utf8',
    )
    const updated = appendEntry(index, entryFromResult(result, sha, branch))
    await writeFile(indexPath, JSON.stringify(updated, null, 2) + '\n', 'utf8')

    // The dashboard is regenerated on every append: point GitHub Pages at this branch and the
    // trend chart is always current (spec §6.3 — no server, no backend).
    const reports = buildTimelines(updated).map((timeline) => ({ timeline, drift: assessDrift(timeline) }))
    await writeFile(
      path.join(tree, 'index.html'),
      renderDashboard({
        reports,
        index: updated,
        generatedAt: result.createdAt,
        sourceLabel: branch,
      }),
      'utf8',
    )

    await git(tree, ['add', '-A'])
    await git(tree, [
      '-c', 'user.name=driftwatch',
      '-c', 'user.email=driftwatch@local',
      'commit', '-q', '-m', `record ${sha.slice(0, 12)}${branch ? ` (${branch})` : ''}`,
    ])
    const newCommit = (await git(tree, ['rev-parse', 'HEAD'])).trim()
    await git(gitRoot, ['update-ref', `refs/heads/${PERF_DATA_BRANCH}`, newCommit])

    if (push && hasRemote) {
      try {
        await git(gitRoot, ['push', 'origin', `refs/heads/${PERF_DATA_BRANCH}:refs/heads/${PERF_DATA_BRANCH}`])
      } catch {
        // Someone else appended first — reset our local ref to theirs and let the caller retry.
        await git(gitRoot, ['fetch', 'origin', `+${PERF_DATA_BRANCH}:refs/heads/${PERF_DATA_BRANCH}`]).catch(() => {})
        return 'push-rejected'
      }
    }

    return 'appended'
  } catch (error) {
    return `perf-data append failed: ${(error as Error).message}`
  } finally {
    await rm(parent, { recursive: true, force: true })
    await git(gitRoot, ['worktree', 'prune']).catch(() => {})
  }
}

/** Prefers the freshly fetched remote state over a stale local ref. */
async function resolvePerfDataRef(gitRoot: string): Promise<string | null> {
  for (const ref of [`refs/remotes/origin/${PERF_DATA_BRANCH}`, `refs/heads/${PERF_DATA_BRANCH}`]) {
    const ok = await git(gitRoot, ['rev-parse', '--verify', '--quiet', ref]).then(() => true, () => false)
    if (ok) return ref
  }
  return null
}

/** A parentless commit on the canonical empty tree — the orphan branch's seed. */
async function emptyTreeCommit(gitRoot: string): Promise<string> {
  const emptyTree = (await git(gitRoot, ['hash-object', '-t', 'tree', '/dev/null'])).trim()
  const { stdout } = await exec(
    'git',
    ['-C', gitRoot, '-c', 'user.name=driftwatch', '-c', 'user.email=driftwatch@local', 'commit-tree', emptyTree, '-m', 'driftwatch perf-data (orphan seed)'],
    { maxBuffer: GIT_BUFFER },
  )
  return stdout.trim()
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-C', cwd, ...args], { maxBuffer: GIT_BUFFER })
  return stdout
}
