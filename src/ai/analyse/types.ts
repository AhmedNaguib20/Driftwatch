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

// Manifest shapes are contract types owned by core/report/analysis.ts — the result JSON is the
// contract, so its owner defines them; this module produces values of those types.
import type { ContextManifest } from '../../core/index.js'

export type { ContextManifest, FileDisposition, ManifestEntry } from '../../core/index.js'

export interface AssembledContext {
  readonly text: string
  readonly manifest: ContextManifest
}
