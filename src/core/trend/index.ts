export { appendToPerfData, PERF_DATA_BRANCH } from './store.js'
export { buildTimelines, identityDiff } from './timeline.js'
export type { MetricTimeline, ProtocolBreak, ProtocolIdentity, TimelinePoint, TimelineSegment } from './timeline.js'
export { MIN_TREND_POINTS, assessDrift } from './drift.js'
export type { DriftReport, DriftVerdict } from './drift.js'
export { readPerfDataIndex } from './read.js'
export { renderDashboard } from './dashboard/index.js'
export type { DashboardInput } from './dashboard/index.js'
export type { AppendOutcome } from './store.js'
export {
  INDEX_SCHEMA_VERSION,
  INDEX_TOOL_MARKER,
  appendEntry,
  emptyIndex,
  entryFromResult,
  parseIndex,
} from './index-file.js'
export type { EntryCommitInfo, IndexEntry, IndexFile } from './index-file.js'
export { orderEntries, orderedIndex } from './order.js'
export { commitInfo } from './store.js'
