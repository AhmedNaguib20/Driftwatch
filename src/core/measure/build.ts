import { rm } from 'node:fs/promises'
import path from 'node:path'
import type { ProjectProfile } from '../detect/types.js'
import { BUILD_SAMPLES, BUILD_TIMEOUT_MS, MEASUREMENT_ENV, median } from './protocol.js'
import { formatCommand, runCommand } from './run-command.js'
import type { MetricResult } from './types.js'
import type { Workspace } from './workspace.js'

export interface BuildOutcome {
  readonly metric: MetricResult
  /** True when the build produced output that bundle_size may weigh. */
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
        reason: 'dependencies are not installed in the workspace',
      },
    }
  }

  const samples: number[] = []

  for (let i = 1; i <= BUILD_SAMPLES; i += 1) {
    // Re-chill before every sample: clearing makes "cold" a guarantee of this function rather
    // than a property of how the workspace happened to be made.
    for (const dir of [...profile.cacheDirs, ...profile.buildOutputDirs]) {
      await rm(path.join(workspace.dir, dir), { recursive: true, force: true })
    }

    progress(`build sample ${i}/${BUILD_SAMPLES}…`)
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
          reason:
            `build sample ${i}/${BUILD_SAMPLES} exited with ${outcome.exitCode === null ? 'no code (failed to start or killed)' : `code ${outcome.exitCode}`}` +
            (tail ? `; last output:\n${tail}` : ''),
        },
      }
    }

    samples.push(Math.round(outcome.durationMs))
  }

  return {
    succeeded: true,
    metric: {
      id: 'build_time',
      status: 'measured',
      value: median(samples),
      unit: 'ms',
      label,
      collectedBy: `median of ${BUILD_SAMPLES} cold builds, wall clock around \`${formatCommand(profile.commands.build)}\` in a ${workspace.kind}`,
      samples: BUILD_SAMPLES,
      sampleValues: samples,
    },
  }
}
