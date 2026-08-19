import { measureBaseSide } from './baseline/baseline.js'
import type { BaseSideResult } from './baseline/baseline.js'
import { planBaseline } from './baseline/plan.js'
import type { BaselinePlan, BaselineUnavailable } from './baseline/plan.js'
import { loadConfig } from './detect/config-load.js'
import { configFromProfile } from './detect/config-schema.js'
import type { ResolvedConfig } from './detect/config-schema.js'
import { writeConfigIfAbsent } from './detect/config-write.js'
import { detectProject } from './detect/detect.js'
import type { ProjectProfile } from './detect/types.js'
import { measureWorkingTree } from './measure/measure.js'
import type { ProgressReporter } from './measure/measure.js'
import { buildResult } from './report/build-result.js'
import { requiresConfirmation } from './report/escalation.js'
import type { ResultJson } from './report/types.js'

/**
 * The full run: detect → config → plan → measure base → measure current → result JSON.
 *
 * This is core's front door — the CLI and every adapter call this and render what comes back.
 * Nothing in here knows what a terminal or a PR comment is.
 *
 * The cached base is a screening tool, never reported truth (§5.1 fifth instance): a cached
 * comparison whose time-based deltas all sit under the floor is reported as 'screened'; one that
 * crosses the floor is re-measured fresh — both sides, this invocation — and only that
 * temporally-local result ('confirmed') is reported. The fresh base replaces the cache entry.
 */

export interface RunOptions {
  readonly cwd?: string
  /** Overrides the config's base ref (--base). */
  readonly base?: string
  /** Display name for the base when `base` is a bare SHA (CI: base branch name). */
  readonly baseLabel?: string
  /** Skip the baseline cache lookup (--no-cache). Results are still written. */
  readonly readCache?: boolean
  /** Skip booting the app / route metrics (--no-serve). perf.yml `serve: false` also disables. */
  readonly serve?: boolean
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
  const plan = await planBaseline(profile, baseRef, options.baseLabel)
  if (!plan.available) progress(`baseline unavailable: ${plan.reason}`)

  const first = await measureOnce(profile, config, plan, progress, {
    readCache: options.readCache ?? true,
    pathWhenFresh: 'fresh',
  }, serveEnabled(config, options))
  if (!first.fromCache || !requiresConfirmation(first.result)) return first.result

  progress(
    'cached-base delta crossed the noise floor — re-measuring both sides fresh to confirm (§5.1)…',
  )
  const confirmed = await measureOnce(profile, config, plan, progress, {
    readCache: false,
    pathWhenFresh: 'confirmed',
  }, serveEnabled(config, options))
  return confirmed.result
}

interface MeasureOnceOptions {
  readonly readCache: boolean
  /** Label when the base is NOT served from cache: 'fresh' first pass, 'confirmed' escalation. */
  readonly pathWhenFresh: 'fresh' | 'confirmed'
}

function serveEnabled(config: ResolvedConfig, options: RunOptions): boolean {
  return (options.serve ?? true) && config.serve
}

async function measureOnce(
  profile: ProjectProfile,
  config: ResolvedConfig,
  plan: BaselinePlan | BaselineUnavailable,
  progress: ProgressReporter,
  options: MeasureOnceOptions,
  serve: boolean,
): Promise<{ result: ResultJson; fromCache: boolean }> {
  let base: BaseSideResult | null = null
  if (plan.available) {
    base = await measureBaseSide(profile, plan, (m) => progress(`base: ${m}`), {
      readCache: options.readCache,
      serve,
    })
  }

  const current = await measureWorkingTree(profile, (m) => progress(`current: ${m}`), {
    dependencies: plan.available ? plan.dependencies : 'clone',
    installIfAbsent: plan.available && plan.dependencies === 'install',
    serve,
  })

  const fromCache = base?.fromCache ?? false
  const result = buildResult({
    profile,
    config,
    plan,
    base,
    current,
    measurementPath: fromCache ? 'screened' : options.pathWhenFresh,
  })
  return { result, fromCache }
}
