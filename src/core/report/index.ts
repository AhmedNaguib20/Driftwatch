export { attachAnalysis, buildResult } from './build-result.js'
export type { BuildResultInput } from './build-result.js'
export { compareMetrics } from './compare-metrics.js'
export type { CompareOptions } from './compare-metrics.js'
export { protocolMismatches } from './protocol-match.js'
export { requiresConfirmation } from './escalation.js'
export { RESULT_SCHEMA_MINOR, RESULT_SCHEMA_VERSION } from './types.js'
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
