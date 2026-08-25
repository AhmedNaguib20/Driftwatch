/**
 * Public surface of the platform-agnostic core.
 *
 * Core takes input and returns JSON. It knows nothing about GitHub, CI, or any other platform —
 * see CLAUDE.md hard rule 1 and spec §3.1. Adapters and the CLI consume what is exported here.
 *
 * Populated as M1 lands: detect → measure → baseline → report.
 */

export * from './detect/index.js'
export { parseUsd } from './detect/config-schema.js'
export * from './measure/index.js'
export * from './baseline/index.js'
export * from './report/index.js'
export * from './trend/index.js'
export * from './alert/index.js'
export * from './replay/index.js'
export * from './verify/index.js'
export {
  PROVIDER_KEY_ENV,
  describeKeySource,
  literalKeyInConfig,
  literalKeyRefusal,
  looksLikeApiKey,
  maskKey,
  resolveAiKey,
} from './key.js'
export type { KeyConfig, KeySource, ResolvedKey } from './key.js'
export {
  AI_KEY_ENV,
  CAPABILITIES,
  capabilitiesOf,
  requiresAiTier,
  tierMention,
} from './tier.js'
export type { Capability, Tier, TierMention } from './tier.js'
export { DESTINATIONS, destinationOf, disclosureLine } from './disclosure.js'
export type { Destination } from './disclosure.js'
export { keyChecks, reportFrom } from './doctor.js'
export type { CheckState, DoctorCheck, DoctorReport } from './doctor.js'
export { recordRun } from './record.js'
export type { RecordOptions } from './record.js'
export { runDriftwatch } from './run.js'
export type { RunOptions as DriftwatchRunOptions } from './run.js'
export {
  DRIFTWATCH_VERSION,
  STALE_BUILD_ENV,
  buildIdentity,
  buildStamp,
  checkStaleness,
  staleBuildRefusal,
} from './build-identity.js'
export type { BuildIdentity, Staleness } from './build-identity.js'
