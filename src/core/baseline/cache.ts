import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { MeasurementProtocol, SideMeasurement } from '../measure/types.js'

/**
 * The baseline cache: measured base-side results under `.perf/cache/`, keyed by
 * `(commit SHA, protocol hash)` — spec §5.1 third instance.
 *
 * SHA alone is not a valid key. A base measured last month on Node 20, compared against a current
 * side on Node 22, is a protocol mismatch wearing a cache hit as a disguise — the temporal version
 * of the same asymmetry §5.1 exists to kill. Any change to the measurement protocol (node,
 * platform, sample count, install state, or driftwatch itself) changes the hash, which silently
 * strands old entries: they are re-measured, never compared against.
 */

export const CACHE_SCHEMA_VERSION = 1

export const DRIFTWATCH_VERSION: string = (
  JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
    version: string
  }
).version

/**
 * The protocol fields that make two measurements comparable across time.
 *
 * `installState` folds cloned/copied into 'preinstalled': which copy mechanism carried
 * node_modules over is an implementation detail — what matters to comparability is whether the
 * build saw a pre-existing dependency tree or a fresh install. Keeping the hash predictable from
 * the plan (before any measurement runs) is what makes cache lookup possible up front.
 *
 * Deliberately absent: `buildCommand` (fixed by the SHA — the tree at that commit determines it)
 * and `workspace` kind (base is always 'worktree'). The full protocol still rides in the cache
 * entry and in the result JSON; the comparison step checks it field by field. The hash decides
 * *reuse*, the full protocol decides *comparability*.
 */
export function protocolHashInput(protocol: MeasurementProtocol): Record<string, unknown> {
  return {
    driftwatchVersion: DRIFTWATCH_VERSION,
    protocolVersion: protocol.version,
    cacheState: protocol.cacheState,
    installState: protocol.nodeModules === 'fresh-install' ? 'fresh-install' : 'preinstalled',
    gitMetadata: protocol.gitMetadata,
    nodeVersion: protocol.nodeVersion,
    platform: protocol.platform,
    arch: protocol.arch,
    buildSamples: protocol.buildSamples,
    warmupSamples: protocol.warmupSamples,
    routeSamples: protocol.routeSamples,
    routeWarmupSamples: protocol.routeWarmupSamples,
    browser: protocol.browser,
    lighthouseProfile: protocol.lighthouseProfile,
    hostLabels: protocol.hostLabels,
    env: protocol.env,
  }
}

export function protocolHash(protocol: MeasurementProtocol): string {
  return createHash('sha256')
    .update(canonicalJson(protocolHashInput(protocol)))
    .digest('hex')
    .slice(0, 12)
}

/** JSON with sorted keys at every level, so the hash never depends on property order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value)
}

export interface CacheEntry {
  readonly schemaVersion: typeof CACHE_SCHEMA_VERSION
  readonly sha: string
  readonly protocolHash: string
  readonly driftwatchVersion: string
  readonly measuredAt: string
  /** The full side, raw sampleValues included — the cache stores what was measured, not a summary. */
  readonly side: SideMeasurement
}

export function cacheDir(gitRoot: string): string {
  return path.join(gitRoot, '.perf', 'cache')
}

export function cachePath(gitRoot: string, sha: string, hash: string): string {
  return path.join(cacheDir(gitRoot), `${sha}-${hash}.json`)
}

export async function readCachedSide(
  gitRoot: string,
  sha: string,
  hash: string,
): Promise<CacheEntry | null> {
  let raw: string
  try {
    raw = await readFile(cachePath(gitRoot, sha, hash), 'utf8')
  } catch {
    return null
  }

  try {
    const entry = JSON.parse(raw) as CacheEntry
    if (entry.schemaVersion !== CACHE_SCHEMA_VERSION) return null
    if (entry.sha !== sha || entry.protocolHash !== hash) return null
    if (!Array.isArray(entry.side?.metrics)) return null
    return entry
  } catch {
    // A corrupt entry is a miss, not an error — it will be overwritten by the re-measurement.
    return null
  }
}

export async function writeCachedSide(
  gitRoot: string,
  sha: string,
  side: SideMeasurement,
): Promise<{ path: string; hash: string }> {
  const hash = protocolHash(side.protocol)
  const dir = cacheDir(gitRoot)
  await mkdir(dir, { recursive: true })

  // `.perf/.gitignore` with `*` keeps the cache out of version control without driftwatch ever
  // editing the user's own .gitignore — writing outside .perf/ is barred by hard rule 2.
  const marker = path.join(gitRoot, '.perf', '.gitignore')
  try {
    await readFile(marker, 'utf8')
  } catch {
    await writeFile(marker, '*\n', 'utf8')
  }

  const entry: CacheEntry = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    sha,
    protocolHash: hash,
    driftwatchVersion: DRIFTWATCH_VERSION,
    measuredAt: new Date().toISOString(),
    side,
  }

  // Atomic write: a crash mid-write must leave either the old entry or none, never a torn file.
  const target = cachePath(gitRoot, sha, hash)
  const tmp = `${target}.tmp-${process.pid}`
  await writeFile(tmp, JSON.stringify(entry, null, 2), 'utf8')
  await rename(tmp, target)

  return { path: target, hash }
}
