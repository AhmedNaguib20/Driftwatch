import { performance } from 'node:perf_hooks'
import type { ProjectProfile } from '../detect/types.js'
import { buildProtocol, collectBuildTime, collectBundleSize } from './collect.js'
import type { MetricResult, SideMeasurement } from './types.js'
import { createWorkingTreeWorkspace } from './workspace.js'
import type { Workspace } from './workspace.js'

/**
 * Measures one side of a comparison inside a workspace.
 *
 * `measureWorkspace` is side-agnostic on purpose: the current side (a filtered copy of the working
 * tree) and the baseline side (a git worktree, step 3) run the exact same collectors through the
 * exact same function. Symmetry by shared code path, not by parallel implementations that must be
 * kept in step by hand.
 */

export interface ProgressReporter {
  (message: string): void
}

const silent: ProgressReporter = () => {}

export async function measureWorkspace(
  profile: ProjectProfile,
  workspace: Workspace,
  progress: ProgressReporter = silent,
): Promise<SideMeasurement> {
  const started = performance.now()
  const metrics: MetricResult[] = []

  progress(`building (cold) with \`${profile.commands.build ? [profile.commands.build.bin, ...profile.commands.build.args].join(' ') : '—'}\`…`)
  const build = await collectBuildTime(profile, workspace, progress)
  metrics.push(build.metric)

  progress('weighing build output…')
  metrics.push(await collectBundleSize(profile, workspace, build.succeeded))

  return {
    metrics,
    protocol: buildProtocol(profile, workspace),
    warnings: [...workspace.warnings],
    elapsedMs: Math.round(performance.now() - started),
  }
}

/** Measures the current working tree — via a temp copy, never in place (hard rule 2). */
export async function measureWorkingTree(
  profile: ProjectProfile,
  progress: ProgressReporter = silent,
): Promise<SideMeasurement> {
  progress('copying working tree to a measurement workspace…')
  const workspace = await createWorkingTreeWorkspace(profile)
  try {
    return await measureWorkspace(profile, workspace, progress)
  } finally {
    await workspace.cleanup()
  }
}
