import type { ProjectProfile } from '../detect/types.js'
import { INSTALL_TIMEOUT_MS, MEASUREMENT_ENV } from './protocol.js'
import { formatCommand, runCommand } from './run-command.js'
import type { MetricResult } from './types.js'
import type { Workspace } from './workspace.js'

export interface InstallOutcome {
  readonly metric: MetricResult
  readonly succeeded: boolean
}

/**
 * Times a frozen install (lockfile rule, spec §5.1 second instance — only run when dependencies
 * changed between the sides, and then on both).
 *
 * One sample, not a median: repeat installs hit the package manager's machine-wide cache, so
 * sample 2 would measure a different thing than sample 1. Truly cold installs would require
 * clearing that cache, which belongs to the user, not to us. The shared-cache caveat is recorded
 * in `collectedBy` rather than hidden.
 */
export async function collectInstallTime(
  profile: ProjectProfile,
  workspace: Workspace,
  progress: (message: string) => void = () => {},
): Promise<InstallOutcome> {
  const label = 'install time'

  if (!profile.commands.install) {
    return {
      succeeded: false,
      metric: { id: 'install_time', status: 'skipped', label, reason: 'no install command detected' },
    }
  }

  progress(`installing dependencies with \`${formatCommand(profile.commands.install)}\`…`)
  const outcome = await runCommand(profile.commands.install, {
    cwd: workspace.dir,
    env: MEASUREMENT_ENV,
    timeoutMs: INSTALL_TIMEOUT_MS,
  })

  if (outcome.exitCode !== 0) {
    const tail = outcome.outputTail.split('\n').slice(-15).join('\n')
    return {
      succeeded: false,
      metric: {
        id: 'install_time',
        status: 'skipped',
        label,
        reason:
          `install exited with ${outcome.exitCode === null ? 'no code (failed to start or killed)' : `code ${outcome.exitCode}`}` +
          (tail ? `; last output:\n${tail}` : ''),
      },
    }
  }

  return {
    succeeded: true,
    metric: {
      id: 'install_time',
      status: 'measured',
      value: Math.round(outcome.durationMs),
      unit: 'ms',
      label,
      collectedBy: `wall clock around \`${formatCommand(profile.commands.install)}\` in a ${workspace.kind}; single sample, package-manager cache shared with the machine`,
      samples: 1,
    },
  }
}
