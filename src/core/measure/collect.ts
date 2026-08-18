import { readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import type { ProjectProfile } from '../detect/types.js'
import { formatCommand, runCommand } from './run-command.js'
import type { MeasurementProtocol, MetricResult } from './types.js'
import type { Workspace } from './workspace.js'

/**
 * The M1 collectors: build time (cold) and bundle size.
 *
 * Both run inside a measurement workspace — never in the user's tree. A failed collection returns a
 * `skipped` metric with the reason (and the build log tail); it never throws, because errors are
 * recorded, not fatal.
 */

export const BUILD_TIMEOUT_MS = 15 * 60 * 1000

/**
 * Timed build runs per side; the reported build time is their median.
 *
 * Measured 2026-08-19 on the fixture: single cold samples spread 2.25% over 5 runs (4.5% over 7) —
 * a lone sample cannot stay inside the 2% floor reliably. §5 mitigation 1 ("multiple runs, take
 * the median") is therefore implemented here, not deferred. Three is the smallest count with a
 * true median; the workspace is copied once and re-chilled before each run.
 */
export const BUILD_SAMPLES = 3

/**
 * Environment added on top of the inherited one, identically on both sides, and recorded in the
 * protocol. Telemetry is disabled because it phones home (rule 6) and adds network jitter to the
 * timed window.
 */
export const MEASUREMENT_ENV: Readonly<Record<string, string>> = {
  NEXT_TELEMETRY_DISABLED: '1',
}

export function buildProtocol(
  profile: ProjectProfile,
  workspace: Workspace,
): MeasurementProtocol {
  return {
    version: 1,
    workspace: workspace.kind,
    cacheState: 'cold',
    nodeModules: workspace.nodeModules,
    gitMetadata: 'absent',
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    buildCommand: profile.commands.build ? formatCommand(profile.commands.build) : null,
    buildSamples: BUILD_SAMPLES,
    env: MEASUREMENT_ENV,
  }
}

export const INSTALL_TIMEOUT_MS = 15 * 60 * 1000

export interface InstallOutcome {
  readonly metric: MetricResult
  readonly succeeded: boolean
}

/**
 * Times a frozen install (lockfile rule, spec §5.1 second instance — only run when dependencies
 * changed between the sides, and then on both).
 *
 * One sample, not a median: repeat installs hit the package manager's machine-wide cache, so
 * sample 2 would measure a different thing than sample 1. Truly cold installs would require
 * clearing that cache, which belongs to the user, not to us. The shared-cache caveat is recorded
 * in `collectedBy` rather than hidden.
 */
export async function collectInstallTime(
  profile: ProjectProfile,
  workspace: Workspace,
  progress: (message: string) => void = () => {},
): Promise<InstallOutcome> {
  const label = 'install time'

  if (!profile.commands.install) {
    return {
      succeeded: false,
      metric: { id: 'install_time', status: 'skipped', label, reason: 'no install command detected' },
    }
  }

  progress(`installing dependencies with \`${formatCommand(profile.commands.install)}\`…`)
  const outcome = await runCommand(profile.commands.install, {
    cwd: workspace.dir,
    env: MEASUREMENT_ENV,
    timeoutMs: INSTALL_TIMEOUT_MS,
  })

  if (outcome.exitCode !== 0) {
    const tail = outcome.outputTail.split('\n').slice(-15).join('\n')
    return {
      succeeded: false,
      metric: {
        id: 'install_time',
        status: 'skipped',
        label,
        reason:
          `install exited with ${outcome.exitCode === null ? 'no code (failed to start or killed)' : `code ${outcome.exitCode}`}` +
          (tail ? `; last output:\n${tail}` : ''),
      },
    }
  }

  return {
    succeeded: true,
    metric: {
      id: 'install_time',
      status: 'measured',
      value: Math.round(outcome.durationMs),
      unit: 'ms',
      label,
      collectedBy: `wall clock around \`${formatCommand(profile.commands.install)}\` in a ${workspace.kind}; single sample, package-manager cache shared with the machine`,
      samples: 1,
    },
  }
}

export interface BuildOutcome {
  readonly metric: MetricResult
  /** True when the build produced output that bundle_size may weigh. */
  readonly succeeded: boolean
}

/** Clears cache dirs (cold protocol, spec §5.1), runs the build BUILD_SAMPLES times, reports the median. */
export async function collectBuildTime(
  profile: ProjectProfile,
  workspace: Workspace,
  progress: (message: string) => void = () => {},
): Promise<BuildOutcome> {
  const label = 'build time (cold)'

  if (!profile.commands.build) {
    return {
      succeeded: false,
      metric: { id: 'build_time', status: 'skipped', label, reason: 'no build command detected' },
    }
  }
  if (workspace.nodeModules === 'absent') {
    return {
      succeeded: false,
      metric: {
        id: 'build_time',
        status: 'skipped',
        label,
        reason: 'dependencies are not installed in the workspace',
      },
    }
  }

  const samples: number[] = []

  for (let i = 1; i <= BUILD_SAMPLES; i += 1) {
    // Re-chill before every sample: clearing makes "cold" a guarantee of this function rather
    // than a property of how the workspace happened to be made.
    for (const dir of [...profile.cacheDirs, ...profile.buildOutputDirs]) {
      await rm(path.join(workspace.dir, dir), { recursive: true, force: true })
    }

    progress(`build sample ${i}/${BUILD_SAMPLES}…`)
    const outcome = await runCommand(profile.commands.build, {
      cwd: workspace.dir,
      env: MEASUREMENT_ENV,
      timeoutMs: BUILD_TIMEOUT_MS,
    })

    if (outcome.exitCode !== 0) {
      const tail = outcome.outputTail.split('\n').slice(-15).join('\n')
      return {
        succeeded: false,
        metric: {
          id: 'build_time',
          status: 'skipped',
          label,
          reason:
            `build sample ${i}/${BUILD_SAMPLES} exited with ${outcome.exitCode === null ? 'no code (failed to start or killed)' : `code ${outcome.exitCode}`}` +
            (tail ? `; last output:\n${tail}` : ''),
        },
      }
    }

    samples.push(Math.round(outcome.durationMs))
  }

  return {
    succeeded: true,
    metric: {
      id: 'build_time',
      status: 'measured',
      value: median(samples),
      unit: 'ms',
      label,
      collectedBy: `median of ${BUILD_SAMPLES} cold builds, wall clock around \`${formatCommand(profile.commands.build)}\` in a ${workspace.kind}`,
      samples: BUILD_SAMPLES,
      sampleValues: samples,
    },
  }
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)
}

/** Subdirectories of build output that are cache, not shippable output. */
const OUTPUT_CACHE_SUBDIRS = new Set(['cache'])

/**
 * Top-level output entries that are diagnostics, not shippable output. `.next/trace` is ~500KB of
 * timing spans whose size varies with the run itself — weighing it makes "bundle size" partly a
 * measure of how the build felt today.
 */
const OUTPUT_DIAGNOSTIC_FILES = new Set(['trace'])

/** Weighs the build output dirs, excluding their internal caches. */
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
