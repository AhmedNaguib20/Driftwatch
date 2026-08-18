import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Evidence, ProjectProfile } from '../detect/types.js'
import { readText } from '../detect/fs-probe.js'

const exec = promisify(execFile)

/**
 * Compares the lockfile between the working tree and the base commit — the arbiter of the install
 * protocol (spec §5.1 second instance).
 */

export type LockfileStatus =
  | 'identical'
  | 'changed'
  | 'added' // lockfile exists now but not at base
  | 'removed' // lockfile existed at base but not now
  | 'missing' // neither side has one
  | 'unreadable'

export interface LockfileComparison {
  readonly status: LockfileStatus
  readonly evidence: Evidence
  readonly warnings: readonly string[]
}

export async function compareLockfiles(
  profile: ProjectProfile,
  baseSha: string,
): Promise<LockfileComparison> {
  const lockfile = profile.lockfile

  if (!lockfile) {
    return {
      status: 'missing',
      evidence: {
        fact: 'lockfile: none on either side',
        source: 'detection',
        detail: 'dependency comparison is not possible',
      },
      warnings: [
        'No lockfile — installs are not pinned, so the two sides may not resolve identical dependency trees. Fresh install on both sides; treat install/build deltas with caution.',
      ],
    }
  }

  const current = await readText(path.join(profile.projectRoot, lockfile))
  if (current === null) {
    return {
      status: 'unreadable',
      evidence: {
        fact: `lockfile: ${lockfile} unreadable in the working tree`,
        source: lockfile,
      },
      warnings: [
        `${lockfile} exists but could not be read — dependency comparison skipped; fresh install on both sides.`,
      ],
    }
  }

  const base = await gitShow(profile.gitRoot!, baseSha, toRepoPath(profile.pathInRepo!, lockfile))
  if (base === null) {
    return {
      status: 'added',
      evidence: {
        fact: `lockfile: ${lockfile} exists now but not at base`,
        source: lockfile,
        detail: 'dependencies are part of the change',
      },
      warnings: [],
    }
  }

  if (base === current) {
    return {
      status: 'identical',
      evidence: {
        fact: `lockfile: ${lockfile} identical to base`,
        source: lockfile,
        detail: 'dependencies unchanged — install skipped, node_modules cloned to both sides',
      },
      warnings: [],
    }
  }

  return {
    status: 'changed',
    evidence: {
      fact: `lockfile: ${lockfile} differs from base`,
      source: lockfile,
      detail: 'dependencies are part of the change — timed frozen install on both sides',
    },
    warnings: [],
  }
}

/** git show wants forward slashes and no leading './'. */
function toRepoPath(pathInRepo: string, file: string): string {
  if (pathInRepo === '.') return file
  return `${pathInRepo.split(path.sep).join('/')}/${file}`
}

async function gitShow(gitRoot: string, sha: string, repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await exec('git', ['-C', gitRoot, 'show', `${sha}:${repoPath}`], {
      maxBuffer: 256 * 1024 * 1024,
    })
    return stdout
  } catch {
    return null
  }
}
