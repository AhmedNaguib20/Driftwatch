/**
 * Context assembly types. Assembly is PURE: `collectDiff` does the IO once, everything after is
 * a deterministic function of its inputs — same inputs, byte-identical context. That is what
 * makes contexts testable against golden files and cacheable later.
 */

export interface DiffFile {
  /** Repo-relative path with forward slashes — never absolute (paths leak usernames). */
  readonly path: string
  readonly insertions: number
  readonly deletions: number
  /** Detected from diff content (git numstat "-"), never from the extension. */
  readonly binary: boolean
  /** Present in the working tree but not at base. */
  readonly untracked: boolean
  /** Unified diff text; empty for binary files. */
  readonly patch: string
}

export interface LockfileChange {
  readonly name: string
  readonly from: string | null
  readonly to: string | null
}

export interface LockfileSummary {
  readonly lockfile: string
  readonly added: readonly LockfileChange[]
  readonly removed: readonly LockfileChange[]
  readonly bumped: readonly LockfileChange[]
  /** Honest fallback when the format has no summarizer yet. */
  readonly unparsed: string | null
}

/** Why a file's patch content is or is not in the context. */
export type FileDisposition = 'full' | 'truncated' | 'diffstat-only' | 'withheld' | 'binary'

export interface ManifestEntry {
  readonly path: string
  readonly disposition: FileDisposition
  readonly insertions: number
  readonly deletions: number
  readonly reason: string | null
}

/**
 * Exactly what was sent — per file. This lands in the result JSON: "docs state exactly what is
 * sent" (spec §7.1) is honoured per-run by the tool itself, not by prose.
 */
export interface ContextManifest {
  readonly files: readonly ManifestEntry[]
  readonly lockfiles: readonly string[]
  readonly estimatedTokens: number
  readonly budgetTokens: number
  readonly truncated: boolean
}

export interface AssembledContext {
  readonly text: string
  readonly manifest: ContextManifest
}
