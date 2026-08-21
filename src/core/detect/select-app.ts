import path from 'node:path'
import { detectProject } from './detect.js'
import type { DetectOptions } from './detect.js'
import type { ProjectProfile } from './types.js'
import { multiAppRefusal } from './workspace-warnings.js'

/**
 * Which package of a workspace are we measuring? (spec §9a, M8 step 3.)
 *
 * The rule is explicitness: a monorepo with one buildable package is unambiguous, but with two or
 * more the choice belongs to the user — a silent pick would measure the wrong app and report the
 * number with total confidence. The refusal carries the list and the exact flag, in the M3/M6
 * stanza style.
 */

export interface AppSelection {
  readonly profile: ProjectProfile
  /** Set when driftwatch cannot choose: the message names every candidate and how to pick. */
  readonly refusal: string | null
}

export interface SelectOptions extends DetectOptions {
  /** `--app <path>` (relative to the workspace root) or `app:` from perf.yml. */
  readonly app?: string | null
  readonly configPath?: string | null
}

export async function selectApp(options: SelectOptions = {}): Promise<AppSelection> {
  const first = await detectProject(options)

  // Not a workspace, or the caller already stands in a package: nothing to choose.
  if (first.workspaceRoot === null && first.workspaceApps.length === 0) {
    return { profile: first, refusal: null }
  }

  const workspaceRoot = first.workspaceRoot ?? first.projectRoot
  const apps = first.workspaceApps

  if (options.app) {
    const chosen = path.normalize(options.app).replace(/[\\/]+$/, '')
    const known = apps.includes(chosen)
    const target = path.resolve(workspaceRoot, chosen)
    if (!known && apps.length > 0) {
      return {
        profile: first,
        refusal: [
          `"${options.app}" is not a package of this workspace. It declares:`,
          '',
          ...apps.map((a) => `    ${a}`),
        ].join('\n'),
      }
    }
    return { profile: await detectProject({ ...options, cwd: target }), refusal: null }
  }

  // Standing inside a package already (the common case): measure it.
  if (first.pathInWorkspace !== null && first.pathInWorkspace !== '.') {
    return { profile: first, refusal: null }
  }

  if (apps.length === 1) {
    return {
      profile: await detectProject({ ...options, cwd: path.resolve(workspaceRoot, apps[0]!) }),
      refusal: null,
    }
  }
  if (apps.length > 1) {
    return { profile: first, refusal: multiAppRefusal(apps, options.configPath ?? null) }
  }
  return { profile: first, refusal: null }
}
