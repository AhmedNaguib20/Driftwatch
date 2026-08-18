import { measureBaseSide } from './baseline/baseline.js'
import type { BaseSideResult } from './baseline/baseline.js'
import { planBaseline } from './baseline/plan.js'
import { loadConfig } from './detect/config-load.js'
import { configFromProfile } from './detect/config-schema.js'
import { writeConfigIfAbsent } from './detect/config-write.js'
import { detectProject } from './detect/detect.js'
import { measureWorkingTree } from './measure/measure.js'
import type { ProgressReporter } from './measure/measure.js'
import { buildResult } from './report/build-result.js'
import type { ResultJson } from './report/types.js'

/**
 * The full run: detect → config → plan → measure base → measure current → result JSON.
 *
 * This is core's front door — the CLI and every adapter call this and render what comes back.
 * Nothing in here knows what a terminal or a PR comment is.
 */

export interface RunOptions {
  readonly cwd?: string
  /** Overrides the config's base ref (--base). */
  readonly base?: string
  /** Skip the baseline cache lookup (--no-cache). Results are still written. */
  readonly readCache?: boolean
  readonly progress?: ProgressReporter
}

export async function runDriftwatch(options: RunOptions = {}): Promise<ResultJson> {
  const progress = options.progress ?? (() => {})

  progress('detecting project…')
  const profile = await detectProject({ cwd: options.cwd })

  // DoD step 1: write perf.yml if absent, then load it (the user's file wins if present).
  await writeConfigIfAbsent(profile.projectRoot, configFromProfile(profile))
  const config = await loadConfig(profile.projectRoot, configFromProfile(profile))

  const baseRef = options.base ?? config.base
  const plan = await planBaseline(profile, baseRef)

  let base: BaseSideResult | null = null
  if (plan.available) {
    base = await measureBaseSide(profile, plan, progress, { readCache: options.readCache })
  } else {
    progress(`baseline unavailable: ${plan.reason}`)
  }

  const current = await measureWorkingTree(profile, progress, {
    dependencies: plan.available ? plan.dependencies : 'clone',
    installIfAbsent: plan.available && plan.dependencies === 'install',
  })

  return buildResult({ profile, config, plan, base, current })
}
