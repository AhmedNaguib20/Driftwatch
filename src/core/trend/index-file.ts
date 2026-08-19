import type { ResultJson } from '../report/types.js'

/**
 * The perf-data index: one append-only array with enough per-commit data to draw a chart without
 * fetching every result file. The `tool` marker is the ownership check — a perf-data branch
 * without it is somebody else's branch and is never touched.
 */

export const INDEX_TOOL_MARKER = 'driftwatch'
export const INDEX_SCHEMA_VERSION = 1

export interface IndexEntry {
  readonly sha: string
  readonly shortSha: string
  readonly timestamp: string
  readonly branch: string | null
  /** Key metric medians only — the chart's data; full results live in results/<short-sha>.json. */
  readonly metrics: Readonly<Record<string, { readonly value: number; readonly unit: 'ms' | 'bytes' }>>
  /** Protocol hash-relevant identity: consumers refuse cross-protocol trend segments (§5.1). */
  readonly protocol: {
    readonly nodeVersion: string
    readonly platform: string
    readonly arch: string
    readonly browser: string
    readonly hostLabels: readonly string[]
    readonly driftwatchVersion: string
  }
}

export interface IndexFile {
  readonly tool: typeof INDEX_TOOL_MARKER
  readonly schemaVersion: typeof INDEX_SCHEMA_VERSION
  readonly entries: readonly IndexEntry[]
}

export function emptyIndex(): IndexFile {
  return { tool: INDEX_TOOL_MARKER, schemaVersion: INDEX_SCHEMA_VERSION, entries: [] }
}

/** Null when the content is not a driftwatch index — the caller must refuse, never overwrite. */
export function parseIndex(raw: string): IndexFile | null {
  try {
    const parsed = JSON.parse(raw) as IndexFile
    if (parsed.tool !== INDEX_TOOL_MARKER || !Array.isArray(parsed.entries)) return null
    return parsed
  } catch {
    return null
  }
}

export function entryFromResult(result: ResultJson, sha: string, branch: string | null): IndexEntry {
  const metrics: Record<string, { value: number; unit: 'ms' | 'bytes' }> = {}
  if ('metrics' in result.current) {
    for (const metric of result.current.metrics) {
      if (metric.status === 'measured') {
        metrics[metric.id] = { value: metric.value, unit: metric.unit }
      }
    }
  }
  const protocol = 'protocol' in result.current ? result.current.protocol : null
  return {
    sha,
    shortSha: sha.slice(0, 12),
    timestamp: result.createdAt,
    branch,
    metrics,
    protocol: {
      nodeVersion: protocol?.nodeVersion ?? 'unknown',
      platform: protocol?.platform ?? 'unknown',
      arch: protocol?.arch ?? 'unknown',
      browser: protocol?.browser ?? 'none',
      hostLabels: protocol?.hostLabels ?? [],
      driftwatchVersion: result.driftwatchVersion,
    },
  }
}

/** Append-only: an existing entry for the sha is replaced (re-runs of the same commit), order kept. */
export function appendEntry(index: IndexFile, entry: IndexEntry): IndexFile {
  const without = index.entries.filter((e) => e.sha !== entry.sha)
  return { ...index, entries: [...without, entry] }
}
