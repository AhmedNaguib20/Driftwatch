import type { Command, Evidence, PackageManager } from './types.js'
import { exists, type PackageJson } from './fs-probe.js'
import path from 'node:path'

/**
 * Package manager detection.
 *
 * The lockfile is the strongest signal available and the one we prefer: it is what the install will
 * actually obey, and — per spec §5.1 — it is also the thing that decides whether the baseline needs
 * a fresh install at all. `packageManager` in package.json (corepack) is a good second signal.
 * Absent both, npm is the honest default for a Node project, and we say so in the evidence rather
 * than presenting it as a finding.
 */

interface LockfileSignal {
  readonly file: string
  readonly manager: PackageManager
}

/** Ordered by specificity: a repo with both pnpm and npm lockfiles is a pnpm repo with a stray file. */
const LOCKFILES: readonly LockfileSignal[] = [
  { file: 'pnpm-lock.yaml', manager: 'pnpm' },
  { file: 'bun.lock', manager: 'bun' },
  { file: 'bun.lockb', manager: 'bun' },
  { file: 'yarn.lock', manager: 'yarn' },
  { file: 'package-lock.json', manager: 'npm' },
  { file: 'npm-shrinkwrap.json', manager: 'npm' },
]

export interface PackageManagerDetection {
  readonly manager: PackageManager
  readonly lockfile: string | null
  readonly evidence: readonly Evidence[]
}

export interface WorkspaceContext {
  /** Absolute workspace root, when this project is one package of a larger install. */
  readonly root: string
  readonly declaredBy: string
  readonly impliedManager: PackageManager | null
  readonly lockfile: string | null
  /** Root package.json, read once by the caller. */
  readonly rootPkg: PackageJson | null
}

/**
 * Resolution priority (spec §9a, decided at M8 step 3): `packageManager` field → lockfile kind →
 * workspace-file kind → npm as the honest default. In a workspace the ROOT is the authority: its
 * lockfile is the one the install obeys (§5.1 second instance), and the app directory usually has
 * neither lockfile nor packageManager field.
 *
 * The one place a default is forbidden: a package with `workspace:*` dependencies and no evidence
 * of which manager owns it. npm cannot resolve that protocol at all, so guessing produces a
 * guaranteed failure — the caller turns this into an error carrying its fix, never an attempt.
 */
export async function detectPackageManager(
  projectRoot: string,
  pkg: PackageJson | null,
  workspace?: WorkspaceContext,
): Promise<PackageManagerDetection> {
  const evidence: Evidence[] = []

  if (workspace) {
    const corepackRoot = parseCorepackField(workspace.rootPkg?.packageManager)
    if (corepackRoot) {
      evidence.push({
        fact: `package manager: ${corepackRoot}`,
        source: `${path.basename(workspace.root)}/package.json`,
        detail: `packageManager: "${workspace.rootPkg?.packageManager}" at the workspace root`,
      })
      return { manager: corepackRoot, lockfile: workspace.lockfile, evidence }
    }
    const byLockfile = LOCKFILES.find((l) => l.file === workspace.lockfile)
    if (byLockfile) {
      evidence.push({
        fact: `package manager: ${byLockfile.manager}`,
        source: `${byLockfile.file} (workspace root)`,
        detail: 'the root lockfile is what the install obeys',
      })
      return { manager: byLockfile.manager, lockfile: workspace.lockfile, evidence }
    }
    if (workspace.impliedManager) {
      evidence.push({
        fact: `package manager: ${workspace.impliedManager}`,
        source: workspace.declaredBy,
        detail: 'implied by the workspace declaration — no root lockfile or packageManager field',
      })
      return { manager: workspace.impliedManager, lockfile: null, evidence }
    }
  }

  const found: LockfileSignal[] = []
  for (const signal of LOCKFILES) {
    if (await exists(path.join(projectRoot, signal.file))) found.push(signal)
  }

  const primary = found[0]
  if (primary) {
    evidence.push({
      fact: `package manager: ${primary.manager}`,
      source: primary.file,
      ...(found.length > 1
        ? { detail: `also found ${found.slice(1).map((f) => f.file).join(', ')}` }
        : {}),
    })
    return { manager: primary.manager, lockfile: primary.file, evidence }
  }

  const corepack = parseCorepackField(pkg?.packageManager)
  if (corepack) {
    evidence.push({
      fact: `package manager: ${corepack}`,
      source: 'package.json',
      detail: `packageManager: "${pkg?.packageManager}" — no lockfile present`,
    })
    return { manager: corepack, lockfile: null, evidence }
  }

  evidence.push({
    fact: 'package manager: npm',
    source: 'default',
    detail: 'no lockfile and no packageManager field — assumed, not observed',
  })
  return { manager: 'npm', lockfile: null, evidence }
}

function parseCorepackField(field: string | undefined): PackageManager | null {
  if (!field) return null
  const name = field.split('@')[0]?.trim()
  switch (name) {
    case 'npm':
    case 'pnpm':
    case 'yarn':
    case 'bun':
      return name
    default:
      return null
  }
}

/** True when any dependency uses the `workspace:` protocol — only resolvable inside a workspace. */
export function hasWorkspaceProtocolDeps(pkg: PackageJson | null): boolean {
  const groups = [pkg?.dependencies, pkg?.devDependencies, pkg?.peerDependencies]
  return groups.some((group) =>
    Object.values(group ?? {}).some((v) => typeof v === 'string' && v.startsWith('workspace:')),
  )
}

/** `<pm> run <script>` — spelled the way each manager expects. */
export function runScript(manager: PackageManager, script: string): Command {
  switch (manager) {
    case 'npm':
      return { bin: 'npm', args: ['run', script] }
    case 'pnpm':
      return { bin: 'pnpm', args: ['run', script] }
    case 'yarn':
      // Yarn (both v1 and berry) accepts `yarn run <script>`.
      return { bin: 'yarn', args: ['run', script] }
    case 'bun':
      return { bin: 'bun', args: ['run', script] }
  }
}

/**
 * A reproducible, lockfile-respecting install.
 *
 * Measurement compares two commits, so the install must resolve to exactly what the lockfile says
 * rather than to whatever is newest today — otherwise the two sides are not the same protocol
 * (hard rule 5). Every manager has a frozen-lockfile mode; we always use it.
 */
export function installCommand(manager: PackageManager, hasLockfile: boolean): Command {
  switch (manager) {
    case 'npm':
      return hasLockfile
        ? { bin: 'npm', args: ['ci'] }
        : { bin: 'npm', args: ['install', '--no-audit', '--no-fund'] }
    case 'pnpm':
      return hasLockfile
        ? { bin: 'pnpm', args: ['install', '--frozen-lockfile'] }
        : { bin: 'pnpm', args: ['install'] }
    case 'yarn':
      return hasLockfile
        ? { bin: 'yarn', args: ['install', '--immutable'] }
        : { bin: 'yarn', args: ['install'] }
    case 'bun':
      return hasLockfile
        ? { bin: 'bun', args: ['install', '--frozen-lockfile'] }
        : { bin: 'bun', args: ['install'] }
  }
}
