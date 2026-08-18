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

export async function detectPackageManager(
  projectRoot: string,
  pkg: PackageJson | null,
): Promise<PackageManagerDetection> {
  const evidence: Evidence[] = []

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
