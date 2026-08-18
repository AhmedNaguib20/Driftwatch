export { detectProject } from './detect.js'
export type { DetectOptions } from './detect.js'
export { detectRoutes } from './routes.js'
export { detectFramework } from './framework.js'
export { detectPackageManager, installCommand, runScript } from './package-manager.js'
export { findGitRoot } from './git.js'
export {
  CONFIG_FILENAME,
  DEFAULT_CONFIG,
  NOISE_FLOOR_PERCENT,
  configFromProfile,
  loadConfig,
  parsePercent,
  renderConfig,
  writeConfigIfAbsent,
} from './perf-config.js'
export type { PerfConfig, ResolvedConfig, WriteResult } from './perf-config.js'
export type {
  Command,
  Evidence,
  Framework,
  Language,
  MetricId,
  PackageManager,
  ProjectProfile,
} from './types.js'
