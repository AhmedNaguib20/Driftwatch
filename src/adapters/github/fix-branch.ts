import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/**
 * The fix branch: driftwatch/fix-pr<N>, based on the PR HEAD, one commit containing EXACTLY the
 * verified diff — the bytes that were measured, no reformatting (a fix we had to bend is not the
 * fix that was verified). Built in a temp worktree, force-pushed (re-runs update in place). The
 * user's own branches are never touched.
 */

export function fixBranchName(prNumber: number): string {
  return `driftwatch/fix-pr${prNumber}`
}

export async function pushFixBranch(options: {
  readonly gitRoot: string
  readonly headSha: string
  readonly prNumber: number
  readonly diff: string
  readonly message: string
}): Promise<{ ok: true; branch: string } | { ok: false; reason: string }> {
  const branch = fixBranchName(options.prNumber)
  const parent = await mkdtemp(path.join(tmpdir(), 'driftwatch-fix-'))
  const tree = path.join(parent, 'tree')

  try {
    await exec('git', ['-C', options.gitRoot, 'worktree', 'add', '--detach', tree, options.headSha])

    const patch = path.join(parent, 'fix.diff')
    await writeFile(patch, options.diff.endsWith('\n') ? options.diff : options.diff + '\n', 'utf8')
    try {
      await exec('git', ['-C', tree, 'apply', '--recount', '--check', patch])
    } catch (error) {
      const e = error as { stderr?: string }
      return { ok: false, reason: `the verified diff no longer applies to ${options.headSha.slice(0, 12)}: ${(e.stderr ?? '').trim().split('\n')[0]}` }
    }
    await exec('git', ['-C', tree, 'apply', '--recount', patch])
    await exec('git', ['-C', tree, 'add', '-A'])
    await exec('git', [
      '-C', tree,
      '-c', 'user.name=driftwatch',
      '-c', 'user.email=driftwatch@local',
      'commit', '-q', '-m', options.message,
    ])

    await exec('git', ['-C', tree, 'push', '--force', 'origin', `HEAD:refs/heads/${branch}`])
    return { ok: true, branch }
  } catch (error) {
    return { ok: false, reason: `could not push the fix branch: ${(error as Error).message}` }
  } finally {
    await rm(parent, { recursive: true, force: true })
    await exec('git', ['-C', options.gitRoot, 'worktree', 'prune']).catch(() => {})
  }
}
