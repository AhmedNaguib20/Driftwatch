import type { DiffFile, LockfileChange, LockfileSummary } from './types.js'

/**
 * Lockfile diffs never travel as raw patch — a package-lock diff is thousands of lines of hashes
 * that would drown the budget while saying only "packages changed". Summarize to added/removed/
 * bumped with versions. Formats without a summarizer degrade honestly to a one-line note.
 */

const LOCKFILE_NAMES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
])

export function isLockfilePath(repoPath: string): boolean {
  const base = repoPath.split('/').at(-1) ?? repoPath
  return LOCKFILE_NAMES.has(base)
}

const MAX_LISTED = 40

export function summarizeLockfile(
  file: DiffFile,
  baseContent: string | null,
  currentContent: string | null,
): LockfileSummary {
  const base = file.path.split('/').at(-1) ?? file.path

  if (base === 'package-lock.json' || base === 'npm-shrinkwrap.json') {
    const before = parseNpmPackages(baseContent)
    const after = parseNpmPackages(currentContent)
    if (before !== null && after !== null) return diffPackageMaps(file.path, before, after)
  }

  return {
    lockfile: file.path,
    added: [],
    removed: [],
    bumped: [],
    unparsed: `${file.path} changed (+${file.insertions}/-${file.deletions} lines) — no summarizer for this format, raw patch withheld by policy`,
  }
}

function parseNpmPackages(content: string | null): Map<string, string> | null {
  if (content === null) return new Map()
  try {
    const parsed = JSON.parse(content) as {
      packages?: Record<string, { version?: string }>
    }
    const out = new Map<string, string>()
    for (const [key, value] of Object.entries(parsed.packages ?? {})) {
      if (key === '' || !value?.version) continue
      out.set(key.replace(/^node_modules\//, ''), value.version)
    }
    return out
  } catch {
    return null
  }
}

function diffPackageMaps(
  lockfile: string,
  before: Map<string, string>,
  after: Map<string, string>,
): LockfileSummary {
  const added: LockfileChange[] = []
  const removed: LockfileChange[] = []
  const bumped: LockfileChange[] = []

  const names = [...new Set([...before.keys(), ...after.keys()])].sort()
  for (const name of names) {
    const from = before.get(name) ?? null
    const to = after.get(name) ?? null
    if (from === to) continue
    if (from === null) added.push({ name, from, to })
    else if (to === null) removed.push({ name, from, to })
    else bumped.push({ name, from, to })
  }

  return { lockfile, added: cap(added), removed: cap(removed), bumped: cap(bumped), unparsed: null }
}

function cap(changes: LockfileChange[]): LockfileChange[] {
  if (changes.length <= MAX_LISTED) return changes
  return [
    ...changes.slice(0, MAX_LISTED),
    { name: `… and ${changes.length - MAX_LISTED} more`, from: null, to: null },
  ]
}
