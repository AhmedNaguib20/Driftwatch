import { execFile } from 'node:child_process'
import { cp, mkdtemp, rm, stat } from 'node:fs/promises'
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
    const pathInRepo = profile.pathInRepo ?? '.'
    const projectDir =
      pathInRepo === '.' ? path.join(root, 'tree') : path.join(root, 'tree', pathInRepo)

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

    const listed = await listFiles(profile, excluded)
    const copied = await copyFiles(profile.projectRoot, projectDir, listed.files)

    const nodeModules =
      options.dependencies === 'install'
        ? 'absent'
        : await cloneDirectory(
            path.join(profile.projectRoot, 'node_modules'),
            path.join(projectDir, 'node_modules'),
          )
    if (nodeModules === 'copied') {
      warnings.push(
        'node_modules was copied file-by-file (copy-on-write clone unavailable on this filesystem) — first run may be slow.',
      )
    }

    warnings.push(...(await gitReadingWarnings(profile)))

    return {
      dir: projectDir,
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
