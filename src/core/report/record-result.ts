import { DRIFTWATCH_VERSION } from '../baseline/cache.js'
import { buildIdentity } from '../build-identity.js'
import type { BuildIdentity } from '../build-identity.js'
import type { ResolvedConfig } from '../detect/config-schema.js'
import type { ProjectProfile } from '../detect/types.js'
import type { SideMeasurement } from '../measure/types.js'
import { RESULT_SCHEMA_MINOR, RESULT_SCHEMA_VERSION } from './types.js'
import type { ResultJson } from './types.js'

/**
 * Assembles a record-mode result: the absolute measurement of one commit. No base, no deltas, no
 * thresholds — the comparison block is empty rather than full of vacuous rows, and the verdict is
 * 'recorded': nothing was compared, so nothing passed or failed (saying "ok" would report a
 * judgement we never made — rule 3).
 *
 * The full protocol rides along untouched: trend consumers must refuse cross-protocol
 * comparisons exactly like PR runs do — a Node upgrade mid-history is a protocol break in the
 * chart, not a data point (§5.1 applies to time-series too).
 */
export interface BuildRecordInput {
  readonly profile: ProjectProfile
  readonly config: ResolvedConfig
  readonly current: SideMeasurement
  /** The commit this measurement describes (record mode measures a pushed, committed tree). */
  readonly sha: string | null
  readonly branch: string | null
  readonly now?: () => Date
  /** Injected so golden files stay byte-stable; defaults to the running build (spec v50). */
  readonly build?: BuildIdentity
}

export function buildRecordResult(input: BuildRecordInput): ResultJson {
  const { profile, config, current } = input
  const now = input.now ?? (() => new Date())
  const build = input.build ?? buildIdentity()

  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    schemaMinorVersion: RESULT_SCHEMA_MINOR,
    driftwatchVersion: DRIFTWATCH_VERSION,
    build,
    mode: 'record',
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
      evidence: [
        ...profile.evidence,
        ...(input.sha
          ? [{ fact: `recorded: ${input.branch ?? '(detached)'} @ ${input.sha.slice(0, 12)}`, source: 'git' }]
          : []),
      ],
      warnings: profile.warnings,
    },
    config: {
      provider: config.provider,
      model: config.model,
      thresholdPercent: config.thresholdPercent,
      noiseFloorPercent: config.noiseFloorPercent,
      base: config.base,
      block_merge: config.block_merge,
      auto_fix: config.auto_fix,
      maxCostPerRunUsd: config.maxCostPerRunUsd,
      sourcePath: config.sourcePath,
    },
    base: { available: false, reason: 'record mode — this run measures one commit; there is no baseline comparison' },
    current: { workingTree: true, ...current },
    comparison: {
      measurementPath: 'fresh',
      dependenciesChanged: null,
      lockfileStatus: null,
      protocolsMatch: true,
      protocolMismatches: [],
      metrics: [],
    },
    verdict: 'recorded',
    // Record mode measures one commit absolutely; there is no comparison, so there is nothing
    // for analysis to explain. `not_applicable`, not `skipped` — the same distinction M11 drew
    // for a clean run: `skipped` means an attempt was made and failed, and record mode never
    // attempts. This one was missed at M11 because the human surfaces are silent either way; it
    // only showed in the result JSON, where a machine consumer would read it as a failure.
    analysis: { outcome: 'not_applicable' },
    warnings: [...config.warnings],
  }
}
