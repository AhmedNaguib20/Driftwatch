/**
 * Public surface of the platform-agnostic core.
 *
 * Core takes input and returns JSON. It knows nothing about GitHub, CI, or any other platform —
 * see CLAUDE.md hard rule 1 and spec §3.1. Adapters and the CLI consume what is exported here.
 *
 * Populated as M1 lands: detect → measure → baseline → report.
 */

export * from './detect/index.js'
export * from './measure/index.js'
export * from './baseline/index.js'
export * from './report/index.js'
export * from './trend/index.js'
export * from './replay/index.js'
export * from './verify/index.js'
export { recordRun } from './record.js'
export type { RecordOptions } from './record.js'
export { runDriftwatch } from './run.js'
export type { RunOptions as DriftwatchRunOptions } from './run.js'
