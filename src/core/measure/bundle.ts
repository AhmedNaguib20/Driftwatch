import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { ProjectProfile } from '../detect/types.js'
import { buildOutputFix } from './fixes.js'
import type { MetricResult } from './types.js'
import type { Workspace } from './workspace.js'

/**
 * The two byte metrics (spec §9a decision 1).
 *
 *  - `client_bundle_size` — what ships to browsers. The headline: it is the number a user pays
 *    for on every page load, and the one movement and fix-verification judge.
 *  - `build_output_size` — everything the build emitted, server code included. Informational:
 *    it moves for reasons that never reach a browser.
 *
 * They were one metric until the real-world trial, where "bundle size" read 69 MB across
 * 3,224 files —
 * mostly server chunks — while the client payload was ~9.6 MB. The old label oversold what it
 * measured; splitting it costs a schema break and buys a headline that means what it says.
 */

/** Subdirectories of build output that are cache, not shippable output. */
const OUTPUT_CACHE_SUBDIRS = new Set(['cache'])
const OUTPUT_DIAGNOSTIC_FILES = new Set(['trace'])

export async function collectBundleSizes(
  profile: ProjectProfile,
  workspace: Workspace,
  buildSucceeded: boolean,
): Promise<MetricResult[]> {
  return [
    await weighDirs({
      id: 'client_bundle_size',
      label: 'client bundle size',
      dirs: profile.clientOutputDirs,
      what: 'shipped to browsers',
      profile,
      workspace,
      buildSucceeded,
    }),
    await weighDirs({
      id: 'build_output_size',
      label: 'build output size',
      dirs: profile.buildOutputDirs,
      what: 'all build output, server code included',
      profile,
      workspace,
      buildSucceeded,
    }),
  ]
}

async function weighDirs(input: {
  id: 'client_bundle_size' | 'build_output_size'
  label: string
  dirs: readonly string[]
  what: string
  profile: ProjectProfile
  workspace: Workspace
  buildSucceeded: boolean
}): Promise<MetricResult> {
  const { id, label, dirs, what, profile, workspace, buildSucceeded } = input

  if (!buildSucceeded) {
    return {
      id,
      status: 'skipped',
      label,
      reason: 'no build output to weigh (build did not succeed)',
      fix: buildOutputFix(profile),
    }
  }

  if (dirs.length === 0) {
    return {
      id,
      status: 'skipped',
      label,
      reason: `this framework has no separately weighable ${what} — driftwatch will not guess which files a browser receives`,
      excluded: true,
    }
  }

  let totalBytes = 0
  let fileCount = 0
  const weighed: string[] = []

  for (const dir of dirs) {
    const absolute = path.join(workspace.dir, dir)
    try {
      if (!(await stat(absolute)).isDirectory()) continue
    } catch {
      continue
    }
    const { bytes, files } = await weigh(absolute, true)
    totalBytes += bytes
    fileCount += files
    weighed.push(dir)
  }

  if (weighed.length === 0) {
    return {
      id,
      status: 'skipped',
      label,
      reason: `build succeeded but produced none of the expected output dirs (${dirs.join(', ')})`,
    }
  }

  return {
    id,
    status: 'measured',
    value: totalBytes,
    unit: 'bytes',
    label,
    collectedBy: `sum of file sizes in ${weighed.join(', ')} (${fileCount} files, ${what}), excluding internal caches and diagnostics`,
    samples: 1,
  }
}

/** Recursive size, skipping the build tool's own cache and diagnostic files. */
async function weigh(dir: string, atRoot: boolean): Promise<{ bytes: number; files: number }> {
  let bytes = 0
  let files = 0
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])

  for (const entry of entries) {
    if (atRoot && entry.isDirectory() && OUTPUT_CACHE_SUBDIRS.has(entry.name)) continue
    if (atRoot && OUTPUT_DIAGNOSTIC_FILES.has(entry.name)) continue

    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const inner = await weigh(full, false)
      bytes += inner.bytes
      files += inner.files
      continue
    }
    if (!entry.isFile()) continue
    try {
      bytes += (await stat(full)).size
      files += 1
    } catch {
      // A file that vanished mid-walk is not part of the output we can weigh.
    }
  }
  return { bytes, files }
}
