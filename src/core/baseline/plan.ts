import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Evidence, ProjectProfile } from '../detect/types.js'
import { exists } from '../detect/fs-probe.js'
import { compareLockfiles } from './lockfile-compare.js'
import type { LockfileStatus } from './lockfile-compare.js'

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
  /** How far the branch has moved past the base — verdict-softening input (spec §9a). */
  readonly commitsAhead: number | null
  readonly baseAgeDays: number | null
  /** The branch this work most likely integrates into, when it is not the base itself. */
  readonly likelyIntegrationTarget: string | null
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
  /** Display name when baseRef is a bare SHA (CI passes the PR base SHA + the branch name). */
  baseLabel?: string,
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
    { fact: `base: ${baseRef} @ ${baseSha.slice(0, 12)}`, source: 'git' },
  ]

  const lock = await compareLockfiles(profile, baseSha)
  evidence.push(lock.evidence)
  warnings.push(...lock.warnings)

  // In a workspace the dependencies that matter live at the root (the store the app links into).
  const nodeModulesPresent = await exists(
    path.join(profile.workspaceRoot ?? profile.projectRoot, 'node_modules'),
  )

  // Clone is only sound when the lockfile proves both sides want the same tree AND there is a
  // node_modules to clone. Everything else forces the state achievable on both: fresh install.
  const dependencies: 'clone' | 'install' =
    lock.status === 'identical' && nodeModulesPresent ? 'clone' : 'install'

  if (lock.status === 'identical' && !nodeModulesPresent) {
    warnings.push(
      'lockfile is unchanged but node_modules is absent — falling back to a fresh install on both sides.',
    )
  }

  const staleness = await measureStaleness(profile.gitRoot!, baseSha, baseRef)

  return {
    available: true,
    baseRef: baseLabel ?? baseRef,
    baseSha,
    ...staleness,
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

/**
 * How far the current branch has run past its base, and where it probably should have compared.
 * Read-only git; every field is null when git cannot answer rather than guessed (rule 3).
 */
async function measureStaleness(
  gitRoot: string,
  baseSha: string,
  baseRef: string,
): Promise<{ commitsAhead: number | null; baseAgeDays: number | null; likelyIntegrationTarget: string | null }> {
  const count = await git(gitRoot, ['rev-list', '--count', `${baseSha}..HEAD`])
  const commitsAhead = count === null ? null : Number.parseInt(count.trim(), 10)

  const committed = await git(gitRoot, ['show', '-s', '--format=%cI', baseSha])
  const baseAgeDays =
    committed === null
      ? null
      : Math.max(0, Math.round((Date.now() - new Date(committed.trim()).getTime()) / 86_400_000))

  return {
    commitsAhead: Number.isFinite(commitsAhead) ? commitsAhead : null,
    baseAgeDays: Number.isFinite(baseAgeDays as number) ? baseAgeDays : null,
    likelyIntegrationTarget: await findIntegrationTarget(gitRoot, baseRef, commitsAhead ?? 0),
  }
}

/**
 * A branch that is closer to this HEAD than the configured base is the likelier integration
 * target — teams that merge into `staging` or `develop` leave `main` behind, which is exactly the
 * jinni case. Only named when it is genuinely closer, never as a guess.
 */
async function findIntegrationTarget(
  gitRoot: string,
  baseRef: string,
  baseDistance: number,
): Promise<string | null> {
  if (baseDistance === 0) return null
  const candidates = ['staging', 'develop', 'development', 'main', 'master']
  let best: { ref: string; distance: number } | null = null

  for (const candidate of candidates) {
    if (candidate === baseRef) continue
    for (const ref of [`refs/remotes/origin/${candidate}`, `refs/heads/${candidate}`]) {
      const sha = await git(gitRoot, ['rev-parse', '--verify', '--quiet', ref])
      if (sha === null) continue
      const merged = await git(gitRoot, ['merge-base', sha.trim(), 'HEAD'])
      if (merged === null) break
      const ahead = await git(gitRoot, ['rev-list', '--count', `${merged.trim()}..HEAD`])
      if (ahead === null) break
      const distance = Number.parseInt(ahead.trim(), 10)
      if (Number.isFinite(distance) && distance < baseDistance && (best === null || distance < best.distance)) {
        best = { ref: candidate, distance }
      }
      break
    }
  }
  return best?.ref ?? null
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await exec('git', ['-C', cwd, ...args])
    return stdout
  } catch {
    return null
  }
}
