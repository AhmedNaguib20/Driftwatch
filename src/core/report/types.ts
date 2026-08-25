import type { BuildIdentity } from '../build-identity.js'
import type { AnalysisReport } from './analysis.js'
import type { SofteningCondition } from './context.js'
import type { VerificationReport } from './verification.js'
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

/**
 * 2 since the metric split (spec §9a decision 1): `bundle_size` became `client_bundle_size` +
 * `build_output_size`. A rename REMOVES a field a 1.x consumer reads, and our own rule says an
 * additive-only change is a minor while anything that breaks a consumer bumps the major. The
 * honest bump costs nothing today — no third-party consumer exists — and lying about it would
 * cost exactly when one does.
 */
export const RESULT_SCHEMA_VERSION = 2

/**
 * Minor: additive changes only — new fields, new optional blocks. A 1.0 consumer reading a 1.1
 * result must keep working; anything that would break one bumps the major instead.
 */
export const RESULT_SCHEMA_MINOR = 3

export interface ResultJson {
  readonly schemaVersion: typeof RESULT_SCHEMA_VERSION
  readonly schemaMinorVersion: typeof RESULT_SCHEMA_MINOR
  readonly driftwatchVersion: string
  /**
   * 'compare' (default, PR runs): two sides, deltas, thresholds. 'record' (trend runs): the
   * absolute measurement of one commit — current side only, no base, no deltas, no AI. Two
   * different questions: "did this change regress?" vs "where has main been going?".
   */
  readonly mode: 'compare' | 'record'
  readonly createdAt: string
  /**
   * Which build produced this result — version, entry point (src vs dist), build timestamp.
   * Required, not optional (spec v50): a result that cannot name its own build is how five days
   * were spent reasoning about code that was not running.
   */
  readonly build: BuildIdentity
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
  /** Present when the fix-verification stage ran (M6) — measured evidence about the AI's diff. */
  readonly verification?: VerificationReport
  /**
   * Why attribution was withheld, when it was (verdict 'inconclusive-context'). Empty otherwise —
   * a condition that did not fire is not reported (rule 3 is about attempts, not non-events).
   */
  readonly softening?: readonly SofteningCondition[]
  /** Run-level warnings that belong to no single side (config problems, plan warnings). */
  readonly warnings: readonly string[]
}

/**
 * 'recorded' is record mode's verdict: nothing was compared, so nothing passed or failed.
 * 'inconclusive-context' is a MEASURED comparison whose attribution is not licensed — the base is
 * stale or the dependency trees differ (spec §9a decision 2). The numbers stand; the claim that
 * this change caused them does not.
 */
export type RunVerdict = 'ok' | 'regression' | 'inconclusive' | 'inconclusive-context' | 'recorded'

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
  readonly auto_fix: 'off' | 'propose'
  /** Per-run analysis cost ceiling in USD, or null when unset (the default). Recorded so a
   *  `cost_capped` result can be read back without perf.yml in hand. */
  readonly maxCostPerRunUsd: number | null
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
  /** The remedy when one is knowable, carried through from the side that failed (spec §9a). */
  readonly fix?: string
  /** True when a skipped row is a policy exclusion (never gates the verdict). */
  readonly excluded?: boolean
}
