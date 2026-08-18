import { performance } from 'node:perf_hooks'
import type { ProjectProfile } from '../detect/types.js'
import { collectBuildTime } from './build.js'
import { collectBundleSize } from './bundle.js'
import { collectInstallTime } from './install.js'
import { buildProtocol } from './protocol.js'
import type { MetricResult, SideMeasurement } from './types.js'
import { createWorkingTreeWorkspace } from './workspace.js'
import type { Workspace, WorkspaceOptions } from './workspace.js'

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

export interface MeasureOptions {
  /**
   * Run a timed install when the workspace has no dependencies. Set by the lockfile rule
   * (spec §5.1): dependencies changed between the sides, so the install is part of the change and
   * is measured — identically on both sides.
   */
  readonly installIfAbsent?: boolean
}

export async function measureWorkspace(
  profile: ProjectProfile,
  workspace: Workspace,
  progress: ProgressReporter = silent,
  options: MeasureOptions = {},
): Promise<SideMeasurement> {
  const started = performance.now()
  const metrics: MetricResult[] = []

  // install_time always appears — measured, or skipped with the reason. Omitting it silently
  // would hide that we looked (rule 3).
  let effective = workspace
  if (workspace.nodeModules === 'absent' && options.installIfAbsent) {
    const install = await collectInstallTime(profile, workspace, progress)
    metrics.push(install.metric)
    if (install.succeeded) effective = { ...workspace, nodeModules: 'fresh-install' }
  } else {
    metrics.push({
      id: 'install_time',
      status: 'skipped',
      label: 'install time',
      reason:
        workspace.nodeModules === 'absent'
          ? 'dependencies are not installed and no install was requested'
          : 'dependencies unchanged between sides — provided by clone, install not measured',
    })
  }

  progress(`building (cold) with \`${profile.commands.build ? [profile.commands.build.bin, ...profile.commands.build.args].join(' ') : '—'}\`…`)
  const build = await collectBuildTime(profile, effective, progress)
  metrics.push(build.metric)

  progress('weighing build output…')
  metrics.push(await collectBundleSize(profile, effective, build.succeeded))

  return {
    metrics,
    protocol: buildProtocol(profile, effective),
    warnings: [...workspace.warnings],
    elapsedMs: Math.round(performance.now() - started),
  }
}

/** Measures the current working tree — via a temp copy, never in place (hard rule 2). */
export async function measureWorkingTree(
  profile: ProjectProfile,
  progress: ProgressReporter = silent,
  options: WorkspaceOptions & MeasureOptions = {},
): Promise<SideMeasurement> {
  progress('copying working tree to a measurement workspace…')
  const workspace = await createWorkingTreeWorkspace(profile, options)
  try {
    return await measureWorkspace(profile, workspace, progress, options)
  } finally {
    await workspace.cleanup()
  }
}
