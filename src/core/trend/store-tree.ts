import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { emptyIndex, parseIndex } from './index-file.js'
import type { IndexFile } from './index-file.js'

const exec = promisify(execFile)
const GIT_BUFFER = 64 * 1024 * 1024

export const PERF_DATA_BRANCH = 'perf-data'

/**
 * The perf-data worktree plumbing shared by the single-append writer (store.ts) and the replay
 * batch writer (store-batch.ts). All work happens in a temp worktree; no other branch and no
 * working directory is ever touched (rule 2 applies to the tool's own branch mechanics too).
 */

export interface PerfDataTree {
  readonly tree: string
  readonly index: IndexFile
  readonly hasRemote: boolean
  cleanup(): Promise<void>
}

export type OpenOutcome = PerfDataTree | { readonly refusal: string }

export async function openPerfDataTree(gitRoot: string, fetchRemote: boolean): Promise<OpenOutcome> {
  const parent = await mkdtemp(path.join(tmpdir(), 'driftwatch-perfdata-'))
  const tree = path.join(parent, 'tree')
  const cleanup = async () => {
    await rm(parent, { recursive: true, force: true })
    await git(gitRoot, ['worktree', 'prune']).catch(() => {})
  }

  try {
    const hasRemote = await git(gitRoot, ['remote', 'get-url', 'origin']).then(() => true, () => false)
    if (fetchRemote && hasRemote) {
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
    const existingRaw = await readFile(path.join(tree, 'index.json'), 'utf8').catch(() => null)
    let index = emptyIndex()
    if (existingRaw !== null) {
      const parsed = parseIndex(existingRaw)
      if (parsed === null) {
        await cleanup()
        return {
          refusal: `a "${PERF_DATA_BRANCH}" branch exists but its index.json is not driftwatch's — refusing to touch it (rename or remove the branch to let driftwatch own it)`,
        }
      }
      index = parsed
    } else if (localRef) {
      const files = (await git(gitRoot, ['ls-tree', '-r', '--name-only', localRef])).trim()
      if (files.length > 0) {
        await cleanup()
        return { refusal: `a "${PERF_DATA_BRANCH}" branch exists with content that is not driftwatch's — refusing to touch it` }
      }
    }

    return { tree, index, hasRemote, cleanup }
  } catch (error) {
    await cleanup()
    throw error
  }
}

/** Commits the tree's staged state and advances the branch ref; pushes when asked. */
export async function commitPerfDataTree(
  gitRoot: string,
  tree: string,
  message: string,
  push: boolean,
  hasRemote: boolean,
): Promise<'committed' | 'push-rejected'> {
  await git(tree, ['add', '-A'])
  await git(tree, [
    '-c', 'user.name=driftwatch',
    '-c', 'user.email=driftwatch@local',
    'commit', '-q', '-m', message,
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
  return 'committed'
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

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-C', cwd, ...args], { maxBuffer: GIT_BUFFER })
  return stdout
}
