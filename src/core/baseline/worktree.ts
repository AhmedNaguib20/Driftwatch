import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { NodeModulesState } from '../measure/types.js'
import { cloneDirectory } from '../measure/workspace.js'
import type { Workspace } from '../measure/workspace.js'

const exec = promisify(execFile)

/**
 * The base-side workspace: the base commit checked out into a `git worktree` in a temp dir.
 *
 * Hard rule 2: this is the ONLY way the base is ever built — never `git stash`, never a checkout
 * of the user's branch. The worktree's `.git` link file is removed after checkout so the base
 * side, like the working-tree copy, builds without repository metadata (protocol field
 * `gitMetadata: 'absent'` — same on both sides by construction).
 */

// Same length as the current side's 'driftwatch-curr-' prefix — see createWorkingTreeWorkspace:
// project paths must match in byte length or path-embedding build output weighs differently.
const WORKTREE_PREFIX = 'driftwatch-base-'
const OWNER_FILE = 'owner.json'

export interface BaseWorkspaceOptions {
  readonly gitRoot: string
  /** Project location inside the repo ('.' when at the root). */
  readonly pathInRepo: string
  readonly sha: string
  readonly dependencies: 'clone' | 'install'
  /** Absolute path of the user's node_modules, for the 'clone' strategy. */
  readonly sourceNodeModules: string | null
}

export async function createBaseWorkspace(options: BaseWorkspaceOptions): Promise<Workspace> {
  const parent = await mkdtemp(path.join(tmpdir(), WORKTREE_PREFIX))
  const tree = path.join(parent, 'tree')

  try {
    // Ownership marker lives next to (not inside) the worktree, so the sweeper can tell a
    // crashed run's leftovers from a run that is still alive.
    await writeFile(
      path.join(parent, OWNER_FILE),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
      'utf8',
    )

    await exec('git', ['-C', options.gitRoot, 'worktree', 'add', '--detach', tree, options.sha], {
      maxBuffer: 16 * 1024 * 1024,
    })

    // Drop the .git link: both sides build without repository metadata (spec §5.1).
    await rm(path.join(tree, '.git'), { force: true })

    const projectDir =
      options.pathInRepo === '.' ? tree : path.join(tree, options.pathInRepo)

    // Containment assertion — defense in depth for hard rule 2. If pathInRepo is ever wrong
    // (symlinked tmpdirs bit us once), refusing to run beats measuring — or installing into —
    // a directory outside the worktree.
    const escape = path.relative(tree, path.resolve(projectDir))
    if (escape.startsWith('..') || path.isAbsolute(escape)) {
      throw new Error(
        `refusing to use base workspace: project path "${options.pathInRepo}" resolves outside the worktree (${projectDir})`,
      )
    }

    let nodeModules: NodeModulesState = 'absent'
    if (options.dependencies === 'clone' && options.sourceNodeModules) {
      nodeModules = await cloneDirectory(
        options.sourceNodeModules,
        path.join(projectDir, 'node_modules'),
      )
    }

    const fileCount = await countTrackedFiles(options.gitRoot, options.sha, options.pathInRepo)

    const cleanup = async () => {
      await rm(parent, { recursive: true, force: true })
      // The .git link is already gone, so `worktree remove` would refuse; prune reaps the
      // now-dangling registration instead.
      await exec('git', ['-C', options.gitRoot, 'worktree', 'prune']).catch(() => {})
    }

    return {
      dir: projectDir,
      kind: 'worktree',
      nodeModules,
      copiedBy: `git worktree add --detach @ ${options.sha.slice(0, 12)}`,
      fileCount,
      warnings: [],
      cleanup,
    }
  } catch (error) {
    await rm(parent, { recursive: true, force: true })
    await exec('git', ['-C', options.gitRoot, 'worktree', 'prune']).catch(() => {})
    throw error
  }
}

async function countTrackedFiles(
  gitRoot: string,
  sha: string,
  pathInRepo: string,
): Promise<number> {
  try {
    const args = ['-C', gitRoot, 'ls-tree', '-r', '--name-only', sha]
    if (pathInRepo !== '.') args.push('--', pathInRepo)
    const { stdout } = await exec('git', args, { maxBuffer: 64 * 1024 * 1024 })
    return stdout.split('\n').filter((l) => l.length > 0).length
  } catch {
    return 0
  }
}

/**
 * Reaps worktrees left behind by crashed driftwatch runs.
 *
 * A leaked worktree registration blocks future git operations, and `git worktree prune` alone
 * won't reap one whose directory still exists. So: find registrations under our temp prefix,
 * check the owner marker's pid, and remove anything whose owner is gone. A live pid (including
 * ours) is left alone — a concurrent run's measurement must not be deleted from under it.
 */
export async function sweepStaleWorktrees(gitRoot: string): Promise<string[]> {
  let stdout: string
  try {
    ;({ stdout } = await exec('git', ['-C', gitRoot, 'worktree', 'list', '--porcelain'], {
      maxBuffer: 16 * 1024 * 1024,
    }))
  } catch {
    return []
  }

  const removed: string[] = []

  for (const line of stdout.split('\n')) {
    if (!line.startsWith('worktree ')) continue
    const wtPath = line.slice('worktree '.length).trim()
    const parent = path.dirname(wtPath)
    if (!path.basename(parent).startsWith(WORKTREE_PREFIX)) continue

    if (await ownerIsAlive(parent)) continue

    await rm(parent, { recursive: true, force: true })
    removed.push(wtPath)
  }

  await exec('git', ['-C', gitRoot, 'worktree', 'prune']).catch(() => {})
  return removed
}

async function ownerIsAlive(parent: string): Promise<boolean> {
  try {
    const raw = await readFile(path.join(parent, OWNER_FILE), 'utf8')
    const { pid } = JSON.parse(raw) as { pid?: number }
    if (typeof pid !== 'number') return false
    if (pid === process.pid) return true
    process.kill(pid, 0) // throws ESRCH if the process is gone
    return true
  } catch (error) {
    // EPERM means the pid exists but belongs to someone else — treat as alive (conservative).
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
