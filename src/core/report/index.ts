export { DEFAULT_KEY_METRICS, attachAnalysis, attachVerification, buildResult } from './build-result.js'
export { buildRecordResult } from './record-result.js'
export type { BuildRecordInput } from './record-result.js'
export type { BuildResultInput } from './build-result.js'
export { compareMetrics, isCiHost, quantumFor } from './compare-metrics.js'
export { shortReason, summariseReason, summariseReasonWith } from './reason.js'
export type { RenderedReason } from './reason.js'
export type { CompareOptions } from './compare-metrics.js'
export { protocolMismatches } from './protocol-match.js'
export { requiresConfirmation } from './escalation.js'
export { RESULT_SCHEMA_MINOR, RESULT_SCHEMA_VERSION } from './types.js'
export type {
  VerificationMetric,
  VerificationMetricVerdict,
  VerificationOutcome,
  VerificationReport,
} from './verification.js'
export { machineDiff } from './analysis.js'
export type {
  AnalysisFix,
  AnalysisReport,
  ContextManifest,
  FileDisposition,
  ManifestEntry,
  StageStats,
} from './analysis.js'
export type {
  BaseSideReport,
  MeasurementPath,
  Comparison,
  ConfigReport,
  CurrentSideReport,
  MetricComparison,
  MetricVerdict,
  ProjectReport,
  ResultJson,
  RunVerdict,
  SideReport,
  SideUnavailable,
} from './types.js'
export { STALE_BASE_COMMITS, STALE_BASE_DAYS, softeningConditions, softeningSummary } from './context.js'
export type { SofteningCondition } from './context.js'
