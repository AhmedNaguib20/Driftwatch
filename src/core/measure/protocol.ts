import type { ProjectProfile } from '../detect/types.js'
import { formatCommand } from './run-command.js'
import type { MeasurementProtocol } from './types.js'
import type { Workspace } from './workspace.js'

/**
 * The measurement protocol record — how a side was collected, in enough detail that the
 * comparison step can refuse to compute a delta across mismatched protocols (spec §5.1).
 */

export const BUILD_TIMEOUT_MS = 15 * 60 * 1000
export const INSTALL_TIMEOUT_MS = 15 * 60 * 1000

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
 * Discarded builds before the measured samples (§5.1 fifth instance). The first build after a
 * fresh node_modules clone reads through a cold OS page cache and runs ~25% slow; when that
 * warm-up bled into sample 2, the median SELECTED the contaminated sample. Paying one throwaway
 * build (~9s/side) makes the measured samples all steady-state.
 */
export const WARMUP_SAMPLES = 1

/**
 * Environment added on top of the inherited one, identically on both sides, and recorded in the
 * protocol. Telemetry is disabled because it phones home (rule 6) and adds network jitter to the
 * timed window.
 */
export const MEASUREMENT_ENV: Readonly<Record<string, string>> = {
  NEXT_TELEMETRY_DISABLED: '1',
}

/** Comma-separated, trimmed, sorted — label order must never change a protocol hash. */
export function hostLabelsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env['DRIFTWATCH_HOST_LABELS'] ?? '')
    .split(',')
    .map((label) => label.trim())
    .filter((label) => label.length > 0)
    .sort()
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
    warmupSamples: WARMUP_SAMPLES,
    hostLabels: hostLabelsFromEnv(),
    env: MEASUREMENT_ENV,
  }
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)
}
