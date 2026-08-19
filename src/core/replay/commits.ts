import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const GIT_BUFFER = 64 * 1024 * 1024

/**
 * Which commits does a replay measure? The default branch's mainline, FIRST-PARENT only (spec
 * §10): the merge-commit mainline is the project's real history — walking every feature-branch
 * commit doubles cost for no meaning.
 */

export interface ReplayCommit {
  readonly sha: string
  readonly shortSha: string
  /** Author date, ISO — commit time, distinct from measurement time. */
  readonly committedAt: string
  /** First parent (full sha), null for a root commit. */
  readonly parentSha: string | null
  readonly subject: string
}

export interface ReplayRange {
  readonly last?: number
  readonly since?: string
}

export interface ReplayPlan {
  /** Oldest-first, so measurement (and any interrupt) walks history forward. */
  readonly commits: readonly ReplayCommit[]
  /** Human name of the mainline the commits came from (e.g. "main"). */
  readonly branch: string
}

export async function resolveReplayCommits(gitRoot: string, range: ReplayRange): Promise<ReplayPlan> {
  const tip = await defaultBranchTip(gitRoot)
  const args = ['log', '--first-parent', '--format=%H%x09%aI%x09%P%x09%s']
  if (range.since) {
    await exec('git', ['-C', gitRoot, 'rev-parse', '--verify', '--quiet', `${range.since}^{commit}`]).catch(() => {
      throw new Error(`--since ref "${range.since}" does not resolve to a commit`)
    })
    args.push(`${range.since}..${tip}`)
  } else {
    args.push('-n', String(range.last ?? 10), tip)
  }

  const { stdout } = await exec('git', ['-C', gitRoot, ...args], { maxBuffer: GIT_BUFFER })
  const commits = stdout
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line): ReplayCommit => {
      const [sha, committedAt, parents, ...subject] = line.split('\t')
      return {
        sha: sha!,
        shortSha: sha!.slice(0, 12),
        committedAt: committedAt!,
        parentSha: parents?.split(' ')[0] || null,
        subject: subject.join('\t'),
      }
    })
  commits.reverse() // git log is newest-first; replay walks oldest-first
  return { commits, branch: tip.split('/').at(-1) || 'HEAD' }
}

/**
 * The default branch: origin/HEAD when the clone knows it, else main/master locally, else the
 * current HEAD — replay measures the mainline, wherever this repo keeps it.
 */
export async function defaultBranchTip(gitRoot: string): Promise<string> {
  const originHead = await exec('git', ['-C', gitRoot, 'symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])
    .then(({ stdout }) => stdout.trim())
    .catch(() => null)
  if (originHead) return originHead

  for (const ref of ['refs/heads/main', 'refs/heads/master']) {
    const ok = await exec('git', ['-C', gitRoot, 'rev-parse', '--verify', '--quiet', ref]).then(() => true, () => false)
    if (ok) return ref
  }
  return 'HEAD'
}
