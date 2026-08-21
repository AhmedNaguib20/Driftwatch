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
  parsePercent,
} from './config-schema.js'
export type { PerfConfig, ResolvedConfig } from './config-schema.js'
export { renderConfig, writeConfigIfAbsent } from './config-write.js'
export type { WriteResult } from './config-write.js'
export { NO_CONFIG_NOTICE, loadConfig } from './config-load.js'
export type {
  Command,
  Evidence,
  Framework,
  Language,
  MetricId,
  PackageManager,
  ProjectProfile,
} from './types.js'
