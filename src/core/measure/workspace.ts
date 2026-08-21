import { execFile } from 'node:child_process'
import { cp, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { ProjectProfile } from '../detect/types.js'
import { copyFiles, listFiles } from './copy-tree.js'
import { gitReadingWarnings } from './git-warnings.js'
import type { NodeModulesState, WorkspaceKind } from './types.js'

const exec = promisify(execFile)

/**
 * The measurement workspace for the *current* side: a filtered copy of the working tree.
 *
 * Hard rule 2 is absolute — the working directory is never modified, so a cold build cannot happen
 * there. Instead the tree is copied to a temp dir and measured there, exactly as the baseline is
 * measured in a worktree. Symmetry becomes structural rather than disciplinary (spec §5.1): both
 * sides are temp copies with no build cache and no `.git`, by construction.
 */

export interface Workspace {
  /** Absolute path of the directory to measure (the project inside the temp dir). */
  readonly dir: string
  /**
   * Where dependencies install. In a monorepo this is the copied WORKSPACE ROOT, not the app:
   * `workspace:*` deps resolve only from there, and pnpm's node_modules is a symlink farm rooted
   * there (spec §9a). Equal to `dir` for a standalone project.
   */
  readonly installDir: string
  readonly kind: WorkspaceKind
  readonly nodeModules: NodeModulesState
  /** How the file list was produced — evidence for the copy's fidelity. */
  readonly copiedBy: string
  readonly fileCount: number
  readonly warnings: readonly string[]
  /** Removes the temp dir. Never touches anything outside it. */
  cleanup(): Promise<void>
}

export interface WorkspaceOptions {
  /**
   * How the workspace gets dependencies. 'clone' (default) copies the existing node_modules in;
   * 'install' leaves it absent so a timed, frozen install runs during measurement — the lockfile
   * rule (spec §5.1) picks per comparison, identically for both sides.
   */
  readonly dependencies?: 'clone' | 'install'
}

/**
 * Both sides' project directories must have byte-identical path LENGTHS, so the copy mirrors the
 * worktree's layout: `<tmp>/driftwatch-curr-XXXXXX/tree/<pathInRepo>` against the baseline's
 * `<tmp>/driftwatch-base-XXXXXX/tree/<pathInRepo>` — same-length prefixes, same suffix.
 *
 * Why: Next.js bakes absolute paths into build output (`.nft.json` dependency traces, ~70KB in the
 * fixture), so output byte size varies with path length. Different-length temp paths were measured
 * costing a systematic 1.3% bundle-size gap on identical code — a §5.1 asymmetry: perfectly
 * repeatable and completely fake (spec §5.1 fourth instance).
 */
export async function createWorkingTreeWorkspace(
  profile: ProjectProfile,
  options: WorkspaceOptions = {},
): Promise<Workspace> {
  const root = await mkdtemp(path.join(tmpdir(), 'driftwatch-curr-'))
  const warnings: string[] = []

  try {
    // The copy always begins at the workspace root when there is one — only the app builds, but
    // the whole workspace must be present for the install to resolve (spec §9a).
    const copySource = profile.workspaceRoot ?? profile.projectRoot
    const sourceRelativeToRepo = profile.gitRoot ? path.relative(profile.gitRoot, copySource) || '.' : '.'
    const appInCopy = profile.workspaceRoot ? (profile.pathInWorkspace ?? '.') : '.'

    const pathInRepo = sourceRelativeToRepo
    const copyRoot = pathInRepo === '.' ? path.join(root, 'tree') : path.join(root, 'tree', pathInRepo)
    const projectDir = appInCopy === '.' ? copyRoot : path.join(copyRoot, appInCopy)

    // Containment — defense in depth for hard rule 2 (a symlinked tmpdir once produced a
    // pathInRepo that escaped the temp tree). Refusing to run beats measuring the wrong dir.
    const escape = path.relative(path.join(root, 'tree'), path.resolve(projectDir))
    if (escape.startsWith('..') || path.isAbsolute(escape)) {
      throw new Error(
        `refusing to create workspace: project path "${pathInRepo}" resolves outside the temp dir`,
      )
    }

    const excluded = new Set(
      [...profile.buildOutputDirs, ...profile.cacheDirs, 'node_modules', '.git'].map((p) =>
        path.normalize(p),
      ),
    )

    const listed = await listFiles(profile, excluded, copySource)
    const copied = await copyFiles(copySource, copyRoot, listed.files)

    const nodeModules =
      options.dependencies === 'install'
        ? 'absent'
        : await cloneNodeModulesForest(copySource, copyRoot)
    if (nodeModules === 'copied') {
      warnings.push(
        'node_modules was copied file-by-file (copy-on-write clone unavailable on this filesystem) — first run may be slow.',
      )
    }

    warnings.push(...(await gitReadingWarnings(profile)))

    return {
      dir: projectDir,
      installDir: copyRoot,
      kind: 'copy',
      nodeModules,
      copiedBy: listed.method,
      fileCount: copied,
      warnings,
      cleanup: () => rm(root, { recursive: true, force: true }),
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

/**
 * Provides dependencies to a workspace without letting the build write back into the real tree.
 *
 * A symlink would be fast but poisonous: builds write into `node_modules/.cache`, which through a
 * link would mutate the user's directory (rule 2). On APFS, `cp -c` clones copy-on-write — near
 * instant and fully isolated. Elsewhere we pay for a real copy and say so. Shared by the
 * working-tree copy and the baseline worktree, so both sides get dependencies the same way.
 */
export async function cloneDirectory(
  source: string,
  target: string,
): Promise<NodeModulesState> {
  try {
    if (!(await stat(source)).isDirectory()) return 'absent'
  } catch {
    return 'absent'
  }

  if (process.platform === 'darwin') {
    try {
      await exec('cp', ['-Rc', source, target], { maxBuffer: 1024 * 1024 })
      return 'cloned'
    } catch {
      // clonefile unavailable (non-APFS volume) — fall through to a plain copy.
    }
  }

  await cp(source, target, { recursive: true, verbatimSymlinks: true })
  return 'copied'
}

/**
 * Clones every `node_modules` under a workspace, not just the app's.
 *
 * A pnpm workspace stores real packages once under `<root>/node_modules/.pnpm` and links to them
 * from each package's own `node_modules` with RELATIVE symlinks. Copy the whole forest verbatim
 * and those links keep resolving inside the copy; copy only the app's and every link dangles —
 * which is exactly how the jinni trial failed. On APFS each clone is copy-on-write, so the cost
 * is bounded even for a large monorepo.
 *
 * Shared by both sides (working-tree copy and base worktree) so dependencies arrive identically —
 * protocol symmetry by construction, not by discipline (§5.1).
 */
export async function cloneNodeModulesForest(
  source: string,
  target: string,
): Promise<NodeModulesState> {
  let outcome: NodeModulesState = 'absent'
  for (const dir of await packageDirs(source)) {
    const state = await cloneDirectory(path.join(source, dir, 'node_modules'), path.join(target, dir, 'node_modules'))
    if (state === 'absent') continue
    // A single file-by-file copy anywhere in the forest makes the whole clone a 'copied' one.
    outcome = outcome === 'copied' || state === 'copied' ? 'copied' : 'cloned'
  }
  return outcome
}

/** The root plus every directory two levels down — where workspaces actually put packages. */
async function packageDirs(root: string): Promise<string[]> {
  const dirs = ['.']
  const skip = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.turbo'])
  const top = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of top) {
    if (!entry.isDirectory() || skip.has(entry.name) || entry.name.startsWith('.')) continue
    dirs.push(entry.name)
    const inner = await readdir(path.join(root, entry.name), { withFileTypes: true }).catch(() => [])
    for (const child of inner) {
      if (!child.isDirectory() || skip.has(child.name) || child.name.startsWith('.')) continue
      dirs.push(path.join(entry.name, child.name))
    }
  }
  return dirs
}
