import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Evidence, ProjectProfile } from '../detect/types.js'
import { exists, readText } from '../detect/fs-probe.js'

const exec = promisify(execFile)

/**
 * The baseline plan: which commit to compare against, and what the lockfile decides.
 *
 * Spec §5.1 second instance — the lockfile is the arbiter of the install protocol:
 *  - identical between the sides → dependencies are not what changed; both sides get the existing
 *    node_modules cloned in and install is not measured.
 *  - different → dependencies ARE part of the change; both sides run a timed frozen install and
 *    the result carries a "dependencies changed" flag for the AI stage.
 * Either way the two sides get dependencies the same way — the rule exists to keep the protocol
 * symmetric, not to save time (that is a side effect).
 */

export type LockfileStatus =
  | 'identical'
  | 'changed'
  | 'added' // lockfile exists now but not at base
  | 'removed' // lockfile existed at base but not now
  | 'missing' // neither side has one
  | 'unreadable'

export interface BaselinePlan {
  readonly available: true
  readonly baseRef: string
  readonly baseSha: string
  readonly lockfileStatus: LockfileStatus
  /**
   * True when the lockfile differs between the sides; null when there is no lockfile to consult —
   * unknown is reported as unknown, never guessed (hard rule 3).
   */
  readonly dependenciesChanged: boolean | null
  /** Dependency strategy applied to BOTH sides. */
  readonly dependencies: 'clone' | 'install'
  readonly warnings: readonly string[]
  readonly evidence: readonly Evidence[]
}

export interface BaselineUnavailable {
  readonly available: false
  readonly reason: string
}

export async function planBaseline(
  profile: ProjectProfile,
  baseRef: string,
): Promise<BaselinePlan | BaselineUnavailable> {
  if (!profile.gitRoot || !profile.pathInRepo) {
    return {
      available: false,
      reason: 'not inside a git repository — there is no base commit to compare against',
    }
  }

  const baseSha = await resolveCommit(profile.gitRoot, baseRef)
  if (baseSha === null) {
    return {
      available: false,
      reason: `base ref "${baseRef}" does not resolve to a commit in this repository`,
    }
  }

  const warnings: string[] = []
  const evidence: Evidence[] = [
    {
      fact: `base: ${baseRef} @ ${baseSha.slice(0, 12)}`,
      source: 'git',
    },
  ]

  const lock = await compareLockfiles(profile, baseSha)
  evidence.push(lock.evidence)
  warnings.push(...lock.warnings)

  const nodeModulesPresent = await exists(path.join(profile.projectRoot, 'node_modules'))

  // Clone is only sound when the lockfile proves both sides want the same tree AND there is a
  // node_modules to clone. Everything else forces the state achievable on both: fresh install.
  const dependencies: 'clone' | 'install' =
    lock.status === 'identical' && nodeModulesPresent ? 'clone' : 'install'

  if (lock.status === 'identical' && !nodeModulesPresent) {
    warnings.push(
      'lockfile is unchanged but node_modules is absent — falling back to a fresh install on both sides.',
    )
  }

  return {
    available: true,
    baseRef,
    baseSha,
    lockfileStatus: lock.status,
    dependenciesChanged:
      lock.status === 'identical'
        ? false
        : lock.status === 'missing' || lock.status === 'unreadable'
          ? null
          : true,
    dependencies,
    warnings,
    evidence,
  }
}

async function resolveCommit(gitRoot: string, ref: string): Promise<string | null> {
  try {
    const { stdout } = await exec('git', [
      '-C',
      gitRoot,
      'rev-parse',
      '--verify',
      '--quiet',
      `${ref}^{commit}`,
    ])
    const sha = stdout.trim()
    return sha.length === 40 ? sha : null
  } catch {
    return null
  }
}

interface LockfileComparison {
  readonly status: LockfileStatus
  readonly evidence: Evidence
  readonly warnings: readonly string[]
}

async function compareLockfiles(
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
