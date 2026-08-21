import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { exists, readPackageJson } from './fs-probe.js'
import type { Evidence, PackageManager } from './types.js'

/**
 * Monorepo (workspace) detection — spec §9a's blocking gap.
 *
 * A package inside a workspace cannot be installed on its own: `workspace:*` deps resolve only
 * from the workspace root, and pnpm's node_modules is a symlink farm rooted there. So before
 * anything else we ask: is this project the whole thing, or one package of a larger install?
 *
 * Deliberately ecosystem-general, not Next.js-shaped: pnpm, npm and yarn workspaces are the
 * shapes the JS ecosystem actually has, and each is declared in a file we can read. Nothing here
 * assumes a framework — an "app" is a package that declares a build script.
 */

const WORKSPACE_LOCKFILES: readonly { readonly file: string; readonly manager: PackageManager }[] = [
  { file: 'pnpm-lock.yaml', manager: 'pnpm' },
  { file: 'bun.lock', manager: 'bun' },
  { file: 'bun.lockb', manager: 'bun' },
  { file: 'yarn.lock', manager: 'yarn' },
  { file: 'package-lock.json', manager: 'npm' },
  { file: 'npm-shrinkwrap.json', manager: 'npm' },
]

export interface WorkspacePackage {
  /** Path relative to the workspace root, e.g. "apps/storefront-web". */
  readonly path: string
  readonly name: string | null
  /** True when the package declares a build script — the ones driftwatch can measure. */
  readonly buildable: boolean
}

export interface WorkspaceDetection {
  /** Absolute path of the workspace root, or null when this project stands alone. */
  readonly root: string | null
  /** Which file declared the workspace. */
  readonly declaredBy: string | null
  /** The manager the workspace file itself implies (pnpm-workspace.yaml ⇒ pnpm). */
  readonly impliedManager: PackageManager | null
  /** Root lockfile name, when present — the lockfile rule reads THIS one (§5.1). */
  readonly lockfile: string | null
  /** Every package the workspace globs resolved to. */
  readonly packages: readonly WorkspacePackage[]
  readonly evidence: readonly Evidence[]
  readonly warnings: readonly string[]
}

const NONE: WorkspaceDetection = {
  root: null, declaredBy: null, impliedManager: null, lockfile: null,
  packages: [], evidence: [], warnings: [],
}

/**
 * Walks UP from the project directory looking for a workspace declaration, stopping at the git
 * root (a workspace never spans repositories) or after a bounded climb.
 */
export async function detectWorkspaceRoot(
  projectRoot: string,
  gitRoot: string | null,
): Promise<WorkspaceDetection> {
  const ceiling = gitRoot ?? path.parse(projectRoot).root
  let dir = projectRoot

  for (let depth = 0; depth < 12; depth += 1) {
    const found = await declarationAt(dir)
    if (found && (dir !== projectRoot || found.declaredBy === 'pnpm-workspace.yaml' || found.globs.length > 0)) {
      // A project that declares workspaces AND is the project we were asked to measure is a
      // workspace root being measured directly — still a workspace, just already at the top.
      return await describe(dir, found)
    }
    if (dir === ceiling) break
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return NONE
}

interface Declaration {
  readonly declaredBy: string
  readonly globs: readonly string[]
  readonly impliedManager: PackageManager | null
}

async function declarationAt(dir: string): Promise<Declaration | null> {
  const pnpmFile = path.join(dir, 'pnpm-workspace.yaml')
  if (await exists(pnpmFile)) {
    return {
      declaredBy: 'pnpm-workspace.yaml',
      globs: parsePnpmWorkspace(await readFile(pnpmFile, 'utf8').catch(() => '')),
      impliedManager: 'pnpm',
    }
  }
  const pkg = await readPackageJson(dir)
  const globs = workspaceGlobs(pkg)
  if (globs.length > 0) {
    return { declaredBy: 'package.json (workspaces)', globs, impliedManager: null }
  }
  return null
}

async function describe(root: string, declaration: Declaration): Promise<WorkspaceDetection> {
  const evidence: Evidence[] = []
  const warnings: string[] = []

  let lockfile: string | null = null
  let lockManager: PackageManager | null = null
  for (const candidate of WORKSPACE_LOCKFILES) {
    if (await exists(path.join(root, candidate.file))) {
      lockfile = candidate.file
      lockManager = candidate.manager
      break
    }
  }

  const packages = await resolvePackages(root, declaration.globs, warnings)
  evidence.push({
    fact: `workspace root: ${root}`,
    source: declaration.declaredBy,
    detail: `${packages.length} package(s) declared${lockfile ? `; lockfile ${lockfile}` : '; no root lockfile'}`,
  })

  return {
    root,
    declaredBy: declaration.declaredBy,
    impliedManager: declaration.impliedManager ?? lockManager,
    lockfile,
    packages,
    evidence,
    warnings,
  }
}

/**
 * Expands the declared globs. Supports the shapes workspaces actually use — `apps/*`, a literal
 * path, and `packages/**` treated as one level. Anything more exotic is reported rather than
 * silently half-resolved.
 */
async function resolvePackages(
  root: string,
  globs: readonly string[],
  warnings: string[],
): Promise<WorkspacePackage[]> {
  const found: WorkspacePackage[] = []
  const seen = new Set<string>()

  for (const glob of globs) {
    if (glob.startsWith('!')) continue // negations: rare, and dropping them only over-reports
    const normalized = glob.replaceAll('\\', '/').replace(/\/\*\*$/, '/*')
    if (normalized.includes('*')) {
      const [prefix, rest] = normalized.split('/*', 2)
      if (rest && rest.length > 0) {
        warnings.push(`workspace glob "${glob}" is more nested than driftwatch expands; packages under it were not listed.`)
        continue
      }
      const parent = path.join(root, prefix ?? '')
      const entries = await readdir(parent, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        await add(path.posix.join(prefix ?? '', entry.name))
      }
    } else {
      await add(normalized)
    }
  }
  return found.sort((a, b) => (a.path < b.path ? -1 : 1))

  async function add(relative: string): Promise<void> {
    if (seen.has(relative)) return
    const pkg = await readPackageJson(path.join(root, relative))
    if (!pkg) return
    seen.add(relative)
    found.push({
      path: relative,
      name: typeof pkg.name === 'string' ? pkg.name : null,
      buildable: typeof pkg.scripts?.build === 'string' && pkg.scripts.build.length > 0,
    })
  }
}

/** `workspaces` is either an array of globs or `{ packages: [...] }` (yarn's older shape). */
function workspaceGlobs(pkg: { workspaces?: unknown } | null): string[] {
  const field = pkg?.workspaces
  if (Array.isArray(field)) return field.filter((g): g is string => typeof g === 'string')
  if (field && typeof field === 'object' && Array.isArray((field as { packages?: unknown }).packages)) {
    return ((field as { packages: unknown[] }).packages).filter((g): g is string => typeof g === 'string')
  }
  return []
}

/**
 * pnpm-workspace.yaml is a tiny, fixed shape (a `packages:` list of strings) — parsed directly so
 * detection stays dependency-free and cannot fail on unrelated YAML we do not need.
 */
export function parsePnpmWorkspace(text: string): string[] {
  const globs: string[] = []
  let inPackages = false
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trimEnd()
    if (/^packages:\s*$/.test(line)) {
      inPackages = true
      continue
    }
    if (inPackages) {
      const item = /^\s*-\s*['"]?([^'"]+?)['"]?\s*$/.exec(line)
      if (item?.[1]) {
        globs.push(item[1])
        continue
      }
      if (line.trim().length > 0 && !line.startsWith(' ')) inPackages = false
    }
  }
  return globs
}
