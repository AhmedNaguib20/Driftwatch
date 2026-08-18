import type { AnalysisReport } from './analysis.js'
import type { Evidence, Framework, MetricId, PackageManager } from '../detect/types.js'
import type { LockfileStatus } from '../baseline/lockfile-compare.js'
import type { MetricResult, SideMeasurement } from '../measure/types.js'

/**
 * The result JSON — THE contract between core and every consumer (CLAUDE.md conventions).
 *
 * The GitHub adapter renders it into a PR comment, the AI stage reads it as analysis input, the
 * dashboard charts it over time. None of them see anything core saw except through this shape, so
 * it is versioned from day one and guarded by golden-file tests: changing the shape must be a
 * deliberate act, visible in review.
 */

export const RESULT_SCHEMA_VERSION = 1

/**
 * Minor: additive changes only — new fields, new optional blocks. A 1.0 consumer reading a 1.1
 * result must keep working; anything that would break one bumps the major instead.
 */
export const RESULT_SCHEMA_MINOR = 1

export interface ResultJson {
  readonly schemaVersion: typeof RESULT_SCHEMA_VERSION
  readonly schemaMinorVersion: typeof RESULT_SCHEMA_MINOR
  readonly driftwatchVersion: string
  readonly createdAt: string
  readonly project: ProjectReport
  readonly config: ConfigReport
  readonly base: BaseSideReport | SideUnavailable
  readonly current: CurrentSideReport
  readonly comparison: Comparison
  /** ok | regression | inconclusive — the one-word answer every consumer leads with. */
  readonly verdict: RunVerdict
  /**
   * Present when a consumer ran the analysis stage (the CLI always attaches it, including the
   * disabled/no_key outcomes). Absent only when a caller used core directly without analysis.
   */
  readonly analysis?: AnalysisReport
  /** Run-level warnings that belong to no single side (config problems, plan warnings). */
  readonly warnings: readonly string[]
}

export type RunVerdict = 'ok' | 'regression' | 'inconclusive'

export interface ProjectReport {
  readonly root: string
  readonly gitRoot: string | null
  readonly pathInRepo: string | null
  readonly framework: Framework
  readonly frameworkVersion: string | null
  readonly packageManager: PackageManager
  readonly lockfile: string | null
  readonly routes: readonly string[]
  /** The detection evidence trail — preserved through every transformation (conventions). */
  readonly evidence: readonly Evidence[]
  readonly warnings: readonly string[]
}

export interface ConfigReport {
  /** AI provider/model from perf.yml — recorded so a result names what would analyse it. */
  readonly provider: string
  readonly model: string
  readonly thresholdPercent: number
  readonly noiseFloorPercent: number
  /** The base ref actually used for this run (a --base override wins over perf.yml). */
  readonly base: string
  readonly block_merge: boolean
  readonly sourcePath: string | null
}

/** One measured side, as it appears in the result. */
export interface SideReport extends SideMeasurement {
  readonly metrics: readonly MetricResult[]
}

export interface BaseSideReport extends SideReport {
  readonly available: true
  readonly ref: string
  readonly sha: string
  readonly fromCache: boolean
  /** When the cached entry was originally measured (fromCache only). */
  readonly measuredAt: string | null
}

export interface CurrentSideReport extends SideReport {
  /** The current side is the working tree — uncommitted state included, hence no SHA. */
  readonly workingTree: true
}

export interface SideUnavailable {
  readonly available: false
  readonly reason: string
}

/**
 * How the reported comparison came to be (§5.1 fifth instance):
 *  - 'fresh': both sides measured in this invocation — temporally local by construction.
 *  - 'screened': base from cache, every metric under the floor — safe to report as-is.
 *  - 'confirmed': the cached screening crossed the floor, so both sides were re-measured fresh
 *    in this invocation and THIS result is that re-measurement. No time-spanning delta exists.
 */
export type MeasurementPath = 'fresh' | 'screened' | 'confirmed'

export interface Comparison {
  readonly measurementPath: MeasurementPath
  /** Surfaced here so no consumer digs through sides to learn deps changed (spec §5.1). */
  readonly dependenciesChanged: boolean | null
  readonly lockfileStatus: LockfileStatus | null
  /** §5.1 enforcement: false ⇒ every metric below is not_comparable and no delta exists. */
  readonly protocolsMatch: boolean
  /** Exact fields that differ, as "field: base-value (base) vs current-value (current)". */
  readonly protocolMismatches: readonly string[]
  readonly metrics: readonly MetricComparison[]
}

export type MetricVerdict = 'no_change' | 'regressed' | 'improved' | 'skipped' | 'not_comparable'

export interface MetricComparison {
  readonly id: MetricId
  readonly label: string
  readonly unit: 'ms' | 'bytes' | null
  readonly base: number | null
  readonly current: number | null
  /**
   * Null unless the verdict is regressed or improved: deltas under the noise floor are not
   * reported (hard rule 4), and no delta is ever computed across mismatched protocols (§5.1).
   */
  readonly delta: { readonly absolute: number; readonly percent: number } | null
  readonly verdict: MetricVerdict
  /** True when a regression also crosses the configured threshold (drives the run verdict). */
  readonly exceedsThreshold: boolean
  /** Present for skipped / not_comparable / no_change — why there is no reported delta. */
  readonly reason: string | null
}
