import { readdir, stat } from 'node:fs/promises'
import { buildOutputFix } from './fixes.js'
import path from 'node:path'
import type { ProjectProfile } from '../detect/types.js'
import type { MetricResult } from './types.js'
import type { Workspace } from './workspace.js'

/** Subdirectories of build output that are cache, not shippable output. */
const OUTPUT_CACHE_SUBDIRS = new Set(['cache'])

/**
 * Top-level output entries that are diagnostics, not shippable output. `.next/trace` is ~500KB of
 * timing spans whose size varies with the run itself — weighing it makes "bundle size" partly a
 * measure of how the build felt today.
 */
const OUTPUT_DIAGNOSTIC_FILES = new Set(['trace'])

/** Weighs the build output dirs, excluding their internal caches and diagnostics. */
export async function collectBundleSize(
  profile: ProjectProfile,
  workspace: Workspace,
  buildSucceeded: boolean,
): Promise<MetricResult> {
  const label = 'bundle size'

  if (!buildSucceeded) {
    return {
      id: 'bundle_size',
      status: 'skipped',
      label,
      reason: 'no build output to weigh (build did not succeed)',
      fix: buildOutputFix(profile),
    }
  }

  let totalBytes = 0
  let fileCount = 0
  const weighed: string[] = []

  for (const dir of profile.buildOutputDirs) {
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
      id: 'bundle_size',
      status: 'skipped',
      label,
      reason: `build succeeded but produced none of the expected output dirs (${profile.buildOutputDirs.join(', ')})`,
    }
  }

  return {
    id: 'bundle_size',
    status: 'measured',
    value: totalBytes,
    unit: 'bytes',
    label,
    collectedBy: `sum of file sizes in ${weighed.join(', ')} (${fileCount} files), excluding internal caches and diagnostics`,
    samples: 1,
  }
}

async function weigh(dir: string, isRoot: boolean): Promise<{ bytes: number; files: number }> {
  let bytes = 0
  let files = 0

  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (isRoot && OUTPUT_CACHE_SUBDIRS.has(entry.name)) continue
      const nested = await weigh(path.join(dir, entry.name), false)
      bytes += nested.bytes
      files += nested.files
    } else if (entry.isFile()) {
      if (isRoot && OUTPUT_DIAGNOSTIC_FILES.has(entry.name)) continue
      bytes += (await stat(path.join(dir, entry.name))).size
      files += 1
    }
  }

  return { bytes, files }
}
