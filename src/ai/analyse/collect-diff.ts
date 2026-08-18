import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import type { DiffFile } from './types.js'

const exec = promisify(execFile)
const GIT_BUFFER = 256 * 1024 * 1024

/**
 * Collects the diff the analysis will reason about: base SHA → working tree, uncommitted state
 * included — the diff of what was actually measured, not of what was committed.
 *
 * Tracked changes come from `git diff <sha>`; untracked-but-not-ignored files (which the
 * measurement copy included) get a synthesized new-file patch via `git diff --no-index`.
 * Binary files are detected from numstat content ("-\t-"), never from the extension.
 * Output is sorted by (lines changed desc, path asc) — deterministic for identical inputs.
 */
export async function collectDiff(
  gitRoot: string,
  baseSha: string,
  pathInRepo: string,
): Promise<DiffFile[]> {
  const scope = pathInRepo === '.' ? [] : ['--', toPosix(pathInRepo)]

  const files = new Map<string, DiffFile>()

  // Tracked side: one numstat pass for counts + binariness, one patch per file.
  const numstat = await git(gitRoot, ['diff', '--numstat', baseSha, ...scope])
  for (const line of numstat.split('\n')) {
    if (!line.trim()) continue
    const [ins, del, ...rest] = line.split('\t')
    const filePath = rest.join('\t')
    if (!filePath) continue
    const binary = ins === '-' || del === '-'
    const patch = binary
      ? ''
      : await git(gitRoot, ['diff', baseSha, '--', filePath])
    files.set(filePath, {
      path: toPosix(filePath),
      insertions: binary ? 0 : Number(ins),
      deletions: binary ? 0 : Number(del),
      binary,
      untracked: false,
      patch,
    })
  }

  // Untracked side: part of the working tree, part of what was measured.
  const untracked = await git(gitRoot, [
    'ls-files',
    '--others',
    '--exclude-standard',
    ...(pathInRepo === '.' ? [] : [toPosix(pathInRepo)]),
  ])
  for (const filePath of untracked.split('\n')) {
    if (!filePath.trim() || files.has(filePath)) continue
    const entry = await untrackedAsDiff(gitRoot, filePath)
    if (entry) files.set(filePath, entry)
  }

  return [...files.values()].sort(
    (a, b) => b.insertions + b.deletions - (a.insertions + a.deletions) || (a.path < b.path ? -1 : 1),
  )
}

async function untrackedAsDiff(gitRoot: string, filePath: string): Promise<DiffFile | null> {
  // --no-index exits 1 when the files differ — that is the expected outcome, not an error.
  const numstat = await gitAllowExit1(gitRoot, [
    'diff',
    '--no-index',
    '--numstat',
    '/dev/null',
    filePath,
  ])
  const line = numstat.split('\n').find((l) => l.trim())
  if (!line) return null

  const [ins, del] = line.split('\t')
  const binary = ins === '-' || del === '-'
  const patch = binary
    ? ''
    : await gitAllowExit1(gitRoot, ['diff', '--no-index', '/dev/null', filePath])

  return {
    path: toPosix(filePath),
    insertions: binary ? 0 : Number(ins),
    deletions: binary ? 0 : Number(del),
    binary,
    untracked: true,
    patch,
  }
}

async function git(gitRoot: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-C', gitRoot, ...args], { maxBuffer: GIT_BUFFER })
  return stdout
}

async function gitAllowExit1(gitRoot: string, args: string[]): Promise<string> {
  try {
    return await git(gitRoot, args)
  } catch (error) {
    const e = error as { code?: number; stdout?: string }
    if (e.code === 1 && typeof e.stdout === 'string') return e.stdout
    throw error
  }
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/')
}
