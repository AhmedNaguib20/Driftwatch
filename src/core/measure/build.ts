import { rm } from 'node:fs/promises'
import path from 'node:path'
import type { ProjectProfile } from '../detect/types.js'
import { BUILD_SAMPLES, BUILD_TIMEOUT_MS, MEASUREMENT_ENV, WARMUP_SAMPLES, median } from './protocol.js'
import { DEPS_MISSING_FIX, describeWorkspace, toolStartupFix } from './fixes.js'
import { formatCommand, runCommand } from './run-command.js'
import type { MetricResult } from './types.js'
import type { Workspace } from './workspace.js'

export interface BuildOutcome {
  readonly metric: MetricResult
  /** True when the build produced output the byte metrics may weigh. */
  readonly succeeded: boolean
}

/** Clears cache dirs (cold protocol, spec §5.1), runs the build BUILD_SAMPLES times, reports the median. */
export async function collectBuildTime(
  profile: ProjectProfile,
  workspace: Workspace,
  progress: (message: string) => void = () => {},
): Promise<BuildOutcome> {
  const label = 'build time (cold)'

  if (!profile.commands.build) {
    return {
      succeeded: false,
      metric: { id: 'build_time', status: 'skipped', label, reason: 'no build command detected' },
    }
  }
  if (workspace.nodeModules === 'absent') {
    return {
      succeeded: false,
      metric: {
        id: 'build_time',
        status: 'skipped',
        label,
        reason: 'dependencies are not installed in the measurement copy',
        fix: DEPS_MISSING_FIX,
      },
    }
  }

  const samples: number[] = []

  // Warm-up runs first: timed like any sample, then thrown away (see WARMUP_SAMPLES).
  for (let i = 1 - WARMUP_SAMPLES; i <= BUILD_SAMPLES; i += 1) {
    const isWarmup = i < 1
    // Re-chill before every sample: clearing makes "cold" a guarantee of this function rather
    // than a property of how the workspace happened to be made.
    for (const dir of [...profile.cacheDirs, ...profile.buildOutputDirs]) {
      await rm(path.join(workspace.dir, dir), { recursive: true, force: true })
    }

    progress(isWarmup ? 'warm-up build (discarded)…' : `build sample ${i}/${BUILD_SAMPLES}…`)
    const outcome = await runCommand(profile.commands.build, {
      cwd: workspace.dir,
      env: MEASUREMENT_ENV,
      timeoutMs: BUILD_TIMEOUT_MS,
    })

    if (outcome.exitCode !== 0) {
      const tail = outcome.outputTail.split('\n').slice(-15).join('\n')
      return {
        succeeded: false,
        metric: {
          id: 'build_time',
          status: 'skipped',
          label,
          // Multi-line by convention: the summary first, the tool's own last word last —
          // renderers show the last line (spec §9a).
          reason:
            `${isWarmup ? 'warm-up build' : `build sample ${i}/${BUILD_SAMPLES}`} failed (${outcome.exitCode === null ? 'no exit code — failed to start or killed' : `exit code ${outcome.exitCode}`})` +
            (tail ? `:\n${tail}` : ''),
          ...(toolStartupFix(formatCommand(profile.commands.build!), tail) ? { fix: toolStartupFix(formatCommand(profile.commands.build!), tail)! } : {}),
        },
      }
    }

    if (!isWarmup) samples.push(Math.round(outcome.durationMs))
  }

  return {
    succeeded: true,
    metric: {
      id: 'build_time',
      status: 'measured',
      value: median(samples),
      unit: 'ms',
      label,
      collectedBy: `median of ${BUILD_SAMPLES} cold builds after ${WARMUP_SAMPLES} discarded warm-up, wall clock around \`${formatCommand(profile.commands.build)}\` in a ${describeWorkspace(workspace.kind)}`,
      samples: BUILD_SAMPLES,
      sampleValues: samples,
    },
  }
}
