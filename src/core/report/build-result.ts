import type { BaselinePlan, BaselineUnavailable } from '../baseline/plan.js'
import type { BaseSideResult } from '../baseline/baseline.js'
import { DRIFTWATCH_VERSION } from '../baseline/cache.js'
import { buildIdentity } from '../build-identity.js'
import type { BuildIdentity } from '../build-identity.js'
import type { ResolvedConfig } from '../detect/config-schema.js'
import type { ProjectProfile } from '../detect/types.js'
import type { SideMeasurement } from '../measure/types.js'
import { softeningConditions } from './context.js'
import { compareMetrics } from './compare-metrics.js'
import { protocolMismatches } from './protocol-match.js'
import type { AnalysisReport } from './analysis.js'
import type { VerificationReport } from './verification.js'
import type { Comparison, MeasurementPath, MetricComparison, ResultJson, RunVerdict } from './types.js'
import { RESULT_SCHEMA_MINOR, RESULT_SCHEMA_VERSION } from './types.js'

/** Assembles the result JSON from the run's parts. Pure — clock injected for golden tests. */
export interface BuildResultInput {
  readonly profile: ProjectProfile
  readonly config: ResolvedConfig
  readonly plan: BaselinePlan | BaselineUnavailable
  /** Null when the plan was unavailable. */
  readonly base: BaseSideResult | null
  readonly current: SideMeasurement
  /** Defaults to 'fresh' — see MeasurementPath. */
  readonly measurementPath?: MeasurementPath
  readonly now?: () => Date
  /** Injected so golden files stay byte-stable; defaults to the running build (spec v50). */
  readonly build?: BuildIdentity
}

export function buildResult(input: BuildResultInput): ResultJson {
  const { profile, config, plan, base, current } = input
  const now = input.now ?? (() => new Date())
  const build = input.build ?? buildIdentity()

  const comparison = buildComparison(input)

  // Attribution licence (spec §9a decision 2). A measurement failure is already the weaker
  // verdict, so 'inconclusive' is never softened into 'inconclusive-context' — it stays.
  const measuredVerdict = runVerdict(comparison, config)
  const softening = plan.available
    ? softeningConditions({
        plan,
        commitsAhead: plan.commitsAhead,
        baseAgeDays: plan.baseAgeDays,
        likelyIntegrationTarget: plan.likelyIntegrationTarget,
      })
    : []

  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    schemaMinorVersion: RESULT_SCHEMA_MINOR,
    driftwatchVersion: DRIFTWATCH_VERSION,
    build,
    mode: 'compare',
    createdAt: now().toISOString(),
    project: {
      root: profile.projectRoot,
      gitRoot: profile.gitRoot,
      pathInRepo: profile.pathInRepo,
      framework: profile.framework,
      frameworkVersion: profile.frameworkVersion,
      packageManager: profile.packageManager,
      lockfile: profile.lockfile,
      routes: profile.routes,
      evidence: [...profile.evidence, ...(plan.available ? plan.evidence : [])],
      warnings: profile.warnings,
    },
    config: {
      provider: config.provider,
      model: config.model,
      thresholdPercent: config.thresholdPercent,
      noiseFloorPercent: config.noiseFloorPercent,
      // The ref actually compared against — a --base override must not be misreported as
      // perf.yml's default.
      base: plan.available ? plan.baseRef : config.base,
      block_merge: config.block_merge,
      auto_fix: config.auto_fix,
      sourcePath: config.sourcePath,
    },
    base:
      plan.available && base
        ? {
            available: true,
            ref: plan.baseRef,
            sha: plan.baseSha,
            fromCache: base.fromCache,
            measuredAt: base.measuredAt,
            ...base.side,
          }
        : { available: false, reason: plan.available ? 'base side was not measured' : plan.reason },
    current: { workingTree: true, ...current },
    comparison,
    verdict: softening.length > 0 && measuredVerdict !== 'inconclusive' ? 'inconclusive-context' : measuredVerdict,
    ...(softening.length > 0 && measuredVerdict !== 'inconclusive' ? { softening } : {}),
    warnings: [...config.warnings, ...(plan.available ? plan.warnings : [])],
  }
}

/** Attaches the analysis block — the only way an analysis enters the contract. */
export function attachAnalysis(result: ResultJson, analysis: AnalysisReport): ResultJson {
  return { ...result, analysis }
}

/** Attaches the verification block — measured evidence about the analysis's own fix. */
export function attachVerification(result: ResultJson, verification: VerificationReport): ResultJson {
  return { ...result, verification }
}

function buildComparison(input: BuildResultInput): Comparison {
  const { plan, base, current, config } = input

  const measurementPath = input.measurementPath ?? 'fresh'

  if (!plan.available || !base) {
    return {
      measurementPath,
      dependenciesChanged: null,
      lockfileStatus: plan.available ? plan.lockfileStatus : null,
      protocolsMatch: false,
      protocolMismatches: [],
      metrics: compareMetrics([], current.metrics, {
        noiseFloorPercent: config.noiseFloorPercent,
        thresholdPercent: config.thresholdPercent,
        protocolMismatches: [],
      }).map((m) => ({
        ...m,
        verdict: 'skipped' as const,
        delta: null,
        reason: plan.available ? 'base side was not measured' : `base unavailable: ${plan.reason}`,
      })),
    }
  }

  const mismatches = protocolMismatches(base.side.protocol, current.protocol)

  return {
    measurementPath,
    dependenciesChanged: plan.dependenciesChanged,
    lockfileStatus: plan.lockfileStatus,
    protocolsMatch: mismatches.length === 0,
    protocolMismatches: mismatches,
    metrics: compareMetrics(base.side.metrics, current.metrics, {
      noiseFloorPercent: config.noiseFloorPercent,
      thresholdPercent: config.thresholdPercent,
      protocolMismatches: mismatches,
    }),
  }
}

/**
 * ok | regression | inconclusive, judged on the key metrics (the ones perf.yml promises).
 *
 * regression: any key regression at or beyond the threshold. inconclusive: a key metric has no
 * verdict at all (skipped / not_comparable) — we cannot honestly say "ok" about something we
 * could not compare. install_time is contextual, not key: it only exists when deps changed, and
 * its absence never blocks an "ok".
 */
/**
 * Key metrics when perf.yml says nothing — the normal case, since the config is optional.
 *
 * These must be ids the tool actually PRODUCES. This named `bundle_size` from M1 until the M8
 * split retired that id, which quietly demoted the headline metric: a client-bundle regression
 * could not reach a 'regression' verdict on a default config, and analysis (which runs only on
 * that verdict) never saw it. A test cross-checks this list against the metric registry.
 */
export const DEFAULT_KEY_METRICS: readonly string[] = ['build_time', 'client_bundle_size']

function runVerdict(comparison: Comparison, config: ResolvedConfig): RunVerdict {
  const keyIds = config.measure.length > 0 ? config.measure : DEFAULT_KEY_METRICS
  // measure entries may be full ids or class tokens ('route_latency', 'lcp', …) covering every
  // per-route metric of that class.
  const keySet = new Set<string>(keyIds)
  const isKey = (id: string) => keySet.has(id) || keySet.has(id.split(':')[0]!)
  const key = comparison.metrics.filter((m) => isKey(m.id))

  if (key.some((m) => m.verdict === 'regressed' && m.exceedsThreshold)) return 'regression'
  if (key.length === 0 || key.some(isUndecided)) return 'inconclusive'
  return 'ok'
}

function isUndecided(m: MetricComparison): boolean {
  if (m.excluded) return false // policy exclusion — nothing failed, nothing undecided
  return m.verdict === 'skipped' || m.verdict === 'not_comparable'
}
