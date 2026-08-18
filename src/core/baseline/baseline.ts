import path from 'node:path'
import { detectProject } from '../detect/detect.js'
import type { ProjectProfile } from '../detect/types.js'
import { exists } from '../detect/fs-probe.js'
import { BUILD_SAMPLES, MEASUREMENT_ENV, WARMUP_SAMPLES } from '../measure/protocol.js'
import { measureWorkspace } from '../measure/measure.js'
import type { ProgressReporter } from '../measure/measure.js'
import type { MeasurementProtocol, SideMeasurement } from '../measure/types.js'
import { gitReadingWarnings } from '../measure/git-warnings.js'
import { protocolHash, readCachedSide, writeCachedSide } from './cache.js'
import type { BaselinePlan } from './plan.js'
import { createBaseWorkspace, sweepStaleWorktrees } from './worktree.js'

/**
 * Measures the base side of a comparison: worktree checkout → the SAME measurement path as the
 * working tree (`measureWorkspace` — one function, two inputs; symmetry by shared code, not by a
 * parallel implementation kept in step by hand) → cached under `(SHA, protocol hash)`.
 */

export interface BaseSideResult {
  readonly side: SideMeasurement
  readonly sha: string
  readonly fromCache: boolean
  /** ISO timestamp of when the cached entry was measured, when fromCache. */
  readonly measuredAt: string | null
  readonly cachePath: string | null
}

export interface MeasureBaseOptions {
  /** Skip cache lookup (still writes). For --no-cache style flags. */
  readonly readCache?: boolean
}

export async function measureBaseSide(
  profile: ProjectProfile,
  plan: BaselinePlan,
  progress: ProgressReporter = () => {},
  options: MeasureBaseOptions = {},
): Promise<BaseSideResult> {
  const gitRoot = profile.gitRoot!
  const readCache = options.readCache ?? true

  // Reap leftovers from crashed runs before adding a new worktree — a stale registration can
  // block git operations repo-wide.
  const swept = await sweepStaleWorktrees(gitRoot).catch(() => [])
  if (swept.length > 0) {
    progress(`removed ${swept.length} stale driftwatch worktree(s) from a previous run`)
  }

  if (readCache) {
    const expectedHash = protocolHash(predictProtocol(plan))
    const cached = await readCachedSide(gitRoot, plan.baseSha, expectedHash)
    if (cached) {
      progress(`base ${plan.baseSha.slice(0, 12)} found in cache (protocol ${expectedHash})`)
      return {
        side: cached.side,
        sha: plan.baseSha,
        fromCache: true,
        measuredAt: cached.measuredAt,
        cachePath: null,
      }
    }
  }

  progress(`checking out base ${plan.baseSha.slice(0, 12)} into a temp worktree…`)
  const workspace = await createBaseWorkspace({
    gitRoot,
    pathInRepo: profile.pathInRepo!,
    sha: plan.baseSha,
    dependencies: plan.dependencies,
    sourceNodeModules: (await exists(path.join(profile.projectRoot, 'node_modules')))
      ? path.join(profile.projectRoot, 'node_modules')
      : null,
  })

  try {
    // Detect on the worktree itself: the base commit decides its own build command. If it differs
    // from the current side's, the full-protocol comparison in the report step will say so.
    const baseProfile = await detectProject({ cwd: workspace.dir })
    const warnings = [
      ...workspace.warnings,
      ...(await gitReadingWarnings(baseProfile)),
    ]

    const side = await measureWorkspace(
      baseProfile,
      { ...workspace, warnings },
      progress,
      { installIfAbsent: plan.dependencies === 'install' },
    )

    // Cache only a side whose build was actually measured: a transient failure (OOM, disk full)
    // must not become the permanent truth about this SHA.
    const buildMeasured = side.metrics.some(
      (m) => m.id === 'build_time' && m.status === 'measured',
    )
    let cachePath: string | null = null
    if (buildMeasured) {
      cachePath = (await writeCachedSide(gitRoot, plan.baseSha, side)).path
    }

    return { side, sha: plan.baseSha, fromCache: false, measuredAt: null, cachePath }
  } finally {
    await workspace.cleanup()
  }
}

/**
 * The protocol this plan will produce, computed before anything is measured — this is what makes
 * an up-front cache lookup possible. Kept honest by construction: every field here is either
 * environment (known now) or decided by the plan; nothing is a guess about measurement outcomes.
 * The fields the hash actually uses are selected in `protocolHashInput`.
 */
export function predictProtocol(plan: BaselinePlan): MeasurementProtocol {
  return {
    version: 1,
    workspace: 'worktree',
    cacheState: 'cold',
    nodeModules: plan.dependencies === 'install' ? 'fresh-install' : 'cloned',
    gitMetadata: 'absent',
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    buildCommand: null, // not part of the hash — the SHA fixes it
    buildSamples: BUILD_SAMPLES,
    warmupSamples: WARMUP_SAMPLES,
    env: MEASUREMENT_ENV,
  }
}
