import { execFile } from 'node:child_process'
import { cp, mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { ProjectProfile } from '../detect/types.js'

const exec = promisify(execFile)

/**
 * Produces the file list for a working-tree copy and performs the copy.
 *
 * `git ls-files --cached --others --exclude-standard` yields tracked files plus untracked files
 * that are not ignored — i.e. uncommitted state is represented faithfully, which `git archive`
 * (HEAD only) would not do. Files deleted from disk but still in the index are dropped at copy
 * time. Outside a git repo we fall back to a directory walk with the same exclusions.
 */

export interface FileListing {
  readonly files: readonly string[]
  readonly method: string
}

export async function listFiles(
  profile: ProjectProfile,
  excluded: ReadonlySet<string>,
  /** Where the listing starts — the workspace root in a monorepo, else the project (spec §9a). */
  sourceDir: string = profile.projectRoot,
): Promise<FileListing> {
  if (profile.gitRoot) {
    const { stdout } = await exec(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { cwd: sourceDir, maxBuffer: 64 * 1024 * 1024 },
    )
    const files = stdout
      .split('\0')
      .filter((f) => f.length > 0)
      .filter((f) => !isExcluded(f, excluded))
    return { files, method: 'git ls-files --cached --others --exclude-standard' }
  }

  const files: string[] = []
  await walk(sourceDir, '', excluded, files)
  return { files, method: 'directory walk (not a git repository)' }
}

export function isExcluded(relPath: string, excluded: ReadonlySet<string>): boolean {
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
  const entries = await readdir(path.join(base, rel), { withFileTypes: true })
  for (const entry of entries) {
    const entryRel = rel === '' ? entry.name : path.join(rel, entry.name)
    if (isExcluded(entryRel, excluded)) continue
    if (entry.isDirectory()) await walk(base, entryRel, excluded, out)
    else if (entry.isFile()) out.push(entryRel)
  }
}

const COPY_CONCURRENCY = 32

export async function copyFiles(
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
