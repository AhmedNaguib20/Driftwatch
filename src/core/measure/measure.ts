import { performance } from 'node:perf_hooks'
import { NO_SERVER_FIX } from './fixes.js'
import type { ProjectProfile } from '../detect/types.js'
import { collectBuildTime } from './build.js'
import { collectBundleSizes } from './bundle.js'
import { collectInstallTime } from './install.js'
import { NO_BROWSER_HINT, resolveBrowser } from './browser.js'
import { LIGHTHOUSE_PROFILE, measureLighthouse, selectLighthouseRoutes } from './lighthouse.js'
import { MEASUREMENT_ENV, buildProtocol } from './protocol.js'
import { measureRoutes, prerenderedRoutes, selectRoutes } from './route-latency.js'
import { startServer, sweepStaleServers } from './serve.js'
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
   is measured — identically on both sides.
   */
  readonly installIfAbsent?: boolean
  /** Boot the built app and measure route latency (M4 Layer 2a). Default true when servable. */
  readonly serve?: boolean
  /** Lighthouse browser metrics (independent of serve). Default true when Chrome is found. */
  readonly browser?: boolean
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
          : 'dependencies provided by cloning the existing node_modules — install not measured',
    })
  }

  progress(`building (cold) with \`${profile.commands.build ? [profile.commands.build.bin, ...profile.commands.build.args].join(' ') : '—'}\`…`)
  const build = await collectBuildTime(profile, effective, progress)
  metrics.push(build.metric)

  progress('weighing build output…')
  metrics.push(...(await collectBundleSizes(profile, effective, build.succeeded)))

  const layer2a = await collectLayer2a(profile, effective, build.succeeded, progress, options)
  metrics.push(...layer2a.metrics)

  return {
    metrics,
    protocol: buildProtocol(profile, effective, layer2a.browser, layer2a.lighthouseProfile),
    warnings: [...workspace.warnings],
    elapsedMs: Math.round(performance.now() - started),
    layer2aElapsedMs: layer2a.elapsedMs,
    benchmarkIndex: layer2a.benchmarkIndex,
  }
}

interface Layer2aOutcome {
  readonly metrics: MetricResult[]
  readonly elapsedMs: number
  readonly browser: string
  readonly lighthouseProfile: string
  /** Runner-lottery normalization data (see LighthouseOutcome) — never identity. */
  readonly benchmarkIndex: number | null
}

/**
 * Layer 2a: boot the built app ONCE, measure request-level route latency, then Lighthouse
 * browser metrics against the same server. Every promised metric appears — measured, or skipped
 * with the reason (disabled / build failed / boot failed / no Chrome). The wall-clock cost of
 * the whole layer is reported per side (the CI-budget guardrail).
 */
async function collectLayer2a(
  profile: ProjectProfile,
  workspace: Workspace,
  buildSucceeded: boolean,
  progress: ProgressReporter,
  options: MeasureOptions,
): Promise<Layer2aOutcome> {
  const started = performance.now()
  const none = (metrics: MetricResult[] = []): Layer2aOutcome => ({
    metrics,
    elapsedMs: Math.round(performance.now() - started),
    browser: 'none',
    lighthouseProfile: 'none',
    benchmarkIndex: null,
  })

  if (!profile.commands.serve || profile.routes.length === 0) return none() // unservable: not promised

  const prerendered = buildSucceeded
    ? await prerenderedRoutes(workspace.dir, profile.buildOutputDirs)
    : new Set<string>()
  const { selected, skipped } = selectRoutes(profile.routes, prerendered)
  const browserWanted = options.browser !== false
  const browserInfo = browserWanted ? await resolveBrowser() : null
  const lighthouseRoutes = selectLighthouseRoutes(profile.routes, prerendered)

  const skipRoutes = (reason: string): MetricResult[] =>
    selected.map((route) => ({
      id: `route_latency:${route}` as const,
      status: 'skipped' as const,
      label: `route ${route}`,
      reason,
    }))
  const skipLighthouse = (reason: string): MetricResult[] =>
    lighthouseRoutes.flatMap((route) =>
      (['lcp', 'tbt', 'fcp', 'transfer_size'] as const).map((kind) => ({
        id: `${kind}:${route}` as MetricResult['id'],
        status: 'skipped' as const,
        label: `${kind === 'transfer_size' ? 'transfer size' : kind.toUpperCase()} ${route}`,
        reason,
      })),
    )
  const excluded: MetricResult[] = skipped.map(({ route, reason }) => ({
    id: `route_latency:${route}` as const,
    status: 'skipped' as const,
    label: `route ${route}`,
    reason,
    excluded: true,
  }))

  if (options.serve === false) {
    const reason = 'serving disabled (--no-serve / serve: false)'
    const markExcluded = (m: MetricResult) => ({ ...m, excluded: true }) as MetricResult
    return none([...skipRoutes(reason).map(markExcluded), ...skipLighthouse(reason).map(markExcluded), ...excluded])
  }
  if (!buildSucceeded) {
    const reason = 'no server to boot (build did not succeed)'
    const withFix = (m: MetricResult) => ({ ...m, fix: NO_SERVER_FIX }) as MetricResult
    return none([...skipRoutes(reason).map(withFix), ...skipLighthouse(reason).map(withFix)])
  }

  await sweepStaleServers().catch(() => [])

  progress('booting the built app…')
  const boot = await startServer(workspace.dir, profile.commands.serve, MEASUREMENT_ENV)
  if (!boot.ok) return none([...skipRoutes(boot.reason), ...skipLighthouse(boot.reason)])

  try {
    progress(`serving on :${boot.server.port} — measuring ${selected.length} route(s)…`)
    const metrics = [...(await measureRoutes(boot.server, selected, progress)), ...excluded]

    let browser = 'none'
    let lighthouseProfile = 'none'
    let benchmarkIndex: number | null = null
    if (!browserWanted) {
      metrics.push(
        ...skipLighthouse('browser metrics disabled (--no-browser / browser: false)').map(
          (m) => ({ ...m, excluded: true }) as MetricResult,
        ),
      )
    } else if (!browserInfo) {
      metrics.push(...skipLighthouse(NO_BROWSER_HINT))
    } else {
      browser = browserInfo.signature
      lighthouseProfile = LIGHTHOUSE_PROFILE
      const lighthouse = await measureLighthouse(boot.server, browserInfo, lighthouseRoutes, progress)
      metrics.push(...lighthouse.metrics)
      benchmarkIndex = lighthouse.benchmarkIndex
    }

    return {
      metrics,
      elapsedMs: Math.round(performance.now() - started),
      browser,
      lighthouseProfile,
      benchmarkIndex,
    }
  } finally {
    await boot.server.stop()
  }
}

/** Measures the current working tree — via a temp copy, never in place (hard rule 2). */
export async function measureWorkingTree(
  profile: ProjectProfile,
  progress: ProgressReporter = silent,
  options: WorkspaceOptions & MeasureOptions = {},
): Promise<SideMeasurement> {
  progress('copying the working tree into a measurement copy…')
  const workspace = await createWorkingTreeWorkspace(profile, options)
  try {
    return await measureWorkspace(profile, workspace, progress, options)
  } finally {
    await workspace.cleanup()
  }
}
