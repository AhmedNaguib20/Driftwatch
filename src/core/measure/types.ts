import type { Command, MetricId } from '../detect/types.js'

/**
 * Measurement results and — just as load-bearing — the protocol they were collected under.
 *
 * Spec §5.1: asymmetry between two sides of a comparison produces a stable, plausible, fake delta.
 * The defence is to record *how* each side was measured in enough detail that the comparison step
 * can refuse to compute a delta across mismatched protocols. So the protocol here is not
 * documentation; it is an input to a correctness check.
 */

/** How the measured tree came to exist. Both sides of a comparison must match. */
export type WorkspaceKind = 'copy' | 'worktree'

/** How dependencies got into the workspace. */
export type NodeModulesState = 'cloned' | 'copied' | 'fresh-install' | 'absent'

export interface MeasurementProtocol {
  /** Protocol schema version — bumped when fields change meaning. */
  readonly version: 1
  readonly workspace: WorkspaceKind
  /** Always 'cold' in M1: cache dirs are cleared before every measured build (spec §5.1). */
  readonly cacheState: 'cold'
  readonly nodeModules: NodeModulesState
  /** The copy and the worktree both build without repository metadata. */
  readonly gitMetadata: 'absent'
  readonly nodeVersion: string
  readonly platform: string
  readonly arch: string
  readonly buildCommand: string | null
  /** Timed build runs per side; the reported value is their median (§5 mitigation 1). */
  readonly buildSamples: number
  /** Discarded warm-up builds before the measured samples (§5.1 fifth instance). */
  readonly warmupSamples: number
  /**
   * Labels describing the machine class, from DRIFTWATCH_HOST_LABELS (comma-separated) — a
   * generic contract: CI adapters set it (runner OS, image), core never knows who did. Part of
   * the protocol so cross-run comparisons on different runners stay refusable (§5.1).
   */
  readonly hostLabels: readonly string[]
  /** Environment driftwatch added on top of the inherited environment. */
  readonly env: Readonly<Record<string, string>>
}

export interface MeasuredMetric {
  readonly id: MetricId
  readonly status: 'measured'
  readonly value: number
  readonly unit: 'ms' | 'bytes'
  /** Human-readable label, e.g. "build time (cold)". Rendering uses this, never the bare id. */
  readonly label: string
  /** How the number was obtained — the measurement's evidence (CLAUDE.md conventions). */
  readonly collectedBy: string
  /** Number of samples behind the value; the value is their median when samples > 1. */
  readonly samples: number
  /** The raw samples, so consumers (and the AI stage) can see the spread we saw. */
  readonly sampleValues?: readonly number[]
}

export interface SkippedMetric {
  readonly id: MetricId
  readonly status: 'skipped'
  readonly label: string
  /** Why we have no number. Skipped is a first-class outcome, never a silent omission (rule 3). */
  readonly reason: string
}

export type MetricResult = MeasuredMetric | SkippedMetric

/** Everything measured on one side of a comparison. */
export interface SideMeasurement {
  readonly metrics: readonly MetricResult[]
  readonly protocol: MeasurementProtocol
  readonly warnings: readonly string[]
  /** Wall-clock time the whole side took, for progress reporting — not a metric. */
  readonly elapsedMs: number
}

export interface CommandOutcome {
  readonly command: Command
  readonly exitCode: number | null
  readonly durationMs: number
  /** Tail of interleaved stdout+stderr, kept for error reporting. */
  readonly outputTail: string
}
