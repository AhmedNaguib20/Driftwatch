export { measureBaseSide, predictProtocol } from './baseline.js'
export type { BaseSideResult, MeasureBaseOptions } from './baseline.js'
export { planBaseline } from './plan.js'
export type { BaselinePlan, BaselineUnavailable } from './plan.js'
export { compareLockfiles } from './lockfile-compare.js'
export type { LockfileComparison, LockfileStatus } from './lockfile-compare.js'
export { createBaseWorkspace, sweepStaleWorktrees } from './worktree.js'
export type { BaseWorkspaceOptions } from './worktree.js'
export {
  CACHE_SCHEMA_VERSION,
  DRIFTWATCH_VERSION,
  cacheDir,
  cachePath,
  canonicalJson,
  protocolHash,
  protocolHashInput,
  readCachedSide,
  writeCachedSide,
} from './cache.js'
export type { CacheEntry } from './cache.js'
