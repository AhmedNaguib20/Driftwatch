import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { ProjectProfile } from '../detect/types.js'
import { exists, readText } from '../detect/fs-probe.js'
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

export async function createWorkingTreeWorkspace(profile: ProjectProfile): Promise<Workspace> {
  const root = await mkdtemp(path.join(tmpdir(), 'driftwatch-current-'))
  const warnings: string[] = []

  try {
    const excluded = new Set(
      [...profile.buildOutputDirs, ...profile.cacheDirs, 'node_modules', '.git'].map((p) =>
        path.normalize(p),
      ),
    )

    const listed = await listFiles(profile, excluded)
    const copied = await copyFiles(profile.projectRoot, root, listed.files)

    const nodeModules = await provideNodeModules(profile.projectRoot, root)
    if (nodeModules === 'copied') {
      warnings.push(
        'node_modules was copied file-by-file (copy-on-write clone unavailable on this filesystem) — first run may be slow.',
      )
    }

    warnings.push(...(await gitReadingWarnings(profile)))

    return {
      dir: root,
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

interface FileListing {
  readonly files: readonly string[]
  readonly method: string
}

/**
 * Lists the files the copy must contain: the working tree as the user sees it.
 *
 * `git ls-files --cached --others --exclude-standard` yields tracked files plus untracked files
 * that are not ignored — i.e. uncommitted state is represented faithfully, which `git archive`
 * (HEAD only) would not do. Files deleted from disk but still in the index are dropped at copy
 * time. Outside a git repo we fall back to a directory walk with the same exclusions.
 */
async function listFiles(
  profile: ProjectProfile,
  excluded: ReadonlySet<string>,
): Promise<FileListing> {
  if (profile.gitRoot) {
    const { stdout } = await exec(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { cwd: profile.projectRoot, maxBuffer: 64 * 1024 * 1024 },
    )
    const files = stdout
      .split('\0')
      .filter((f) => f.length > 0)
      .filter((f) => !isExcluded(f, excluded))
    return { files, method: 'git ls-files --cached --others --exclude-standard' }
  }

  const files: string[] = []
  await walk(profile.projectRoot, '', excluded, files)
  return { files, method: 'directory walk (not a git repository)' }
}

function isExcluded(relPath: string, excluded: ReadonlySet<string>): boolean {
  const normalized = path.normalize(relPath)
  for (const prefix of excluded) {
    if (normalized === prefix || normalized.startsWith(prefix + path.sep)) return true
  }
  return false
}

async function walk(
  base: string,
  rel: string,
  excluded: ReadonlySet<string>,
  out: string[],
): Promise<void> {
  const { readdir } = await import('node:fs/promises')
  const entries = await readdir(path.join(base, rel), { withFileTypes: true })
  for (const entry of entries) {
    const entryRel = rel === '' ? entry.name : path.join(rel, entry.name)
    if (isExcluded(entryRel, excluded)) continue
    if (entry.isDirectory()) await walk(base, entryRel, excluded, out)
    else if (entry.isFile()) out.push(entryRel)
  }
}

const COPY_CONCURRENCY = 32

async function copyFiles(
  from: string,
  to: string,
  files: readonly string[],
): Promise<number> {
  let copied = 0
  const queue = [...files]

  async function worker(): Promise<void> {
    for (;;) {
      const file = queue.shift()
      if (file === undefined) return
      const source = path.join(from, file)
      const target = path.join(to, file)
      try {
        await mkdir(path.dirname(target), { recursive: true })
        await cp(source, target)
        copied += 1
      } catch (error) {
        // In the index but gone from disk = deleted-but-uncommitted. That IS the working tree
        // state, so absence from the copy is correct; anything else must not pass silently.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }

  await Promise.all(Array.from({ length: COPY_CONCURRENCY }, worker))
  return copied
}

/**
 * Provides dependencies to the workspace without letting the build write back into the real tree.
 *
 * A symlink would be fast but poisonous: builds write into `node_modules/.cache`, which through a
 * link would mutate the user's directory (rule 2). On APFS, `cp -c` clones copy-on-write — near
 * instant and fully isolated. Elsewhere we pay for a real copy and say so.
 */
async function provideNodeModules(
  projectRoot: string,
  workspaceRoot: string,
): Promise<NodeModulesState> {
  const source = path.join(projectRoot, 'node_modules')
  const target = path.join(workspaceRoot, 'node_modules')

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
 * The workspace has no `.git` (deliberately, on both sides — protocol field `gitMetadata`).
 * Tooling that stamps versions from git will behave differently there, and per spec §5.1 that must
 * be surfaced, not silently swallowed. Detection is heuristic: we warn on the obvious signals.
 */
async function gitReadingWarnings(profile: ProjectProfile): Promise<string[]> {
  const suspects: string[] = []

  const pkgRaw = await readText(path.join(profile.projectRoot, 'package.json'))
  if (pkgRaw) {
    try {
      const scripts = (JSON.parse(pkgRaw) as { scripts?: Record<string, string> }).scripts ?? {}
      const build = scripts['build'] ?? ''
      if (/\bgit\b/.test(build)) suspects.push(`scripts.build runs git ("${build}")`)
    } catch {
      /* unreadable package.json was already warned about in detection */
    }
  }

  for (const config of ['next.config.js', 'next.config.mjs', 'next.config.cjs', 'next.config.ts']) {
    const file = path.join(profile.projectRoot, config)
    if (!(await exists(file))) continue
    const source = (await readText(file)) ?? ''
    if (/\bgit\b|\.git\b|GITHUB_SHA|GIT_COMMIT/.test(source)) {
      suspects.push(`${config} references git`)
    }
  }

  if (suspects.length === 0) return []
  return [
    `The build may read git metadata (${suspects.join('; ')}), but measurement workspaces have no .git — ` +
      'version stamping and release detection will see a non-repository. Both sides are measured the same way, ' +
      'so the comparison holds, but the built output may differ from a real build.',
  ]
}
