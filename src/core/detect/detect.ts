import path from 'node:path'
import { realpath } from 'node:fs/promises'
import type { Command, Evidence, MetricId, ProjectProfile } from './types.js'
import { exists, readPackageJson } from './fs-probe.js'
import type { PackageJson } from './fs-probe.js'
import { detectPackageManager, installCommand, runScript } from './package-manager.js'
import { detectFramework } from './framework.js'
import { detectRoutes } from './routes.js'
import { findGitRoot } from './git.js'

/**
 * Detection entry point (spec §3.3 — "near-zero config; the tool detects and generates its own").
 *
 * Nothing here throws on a hostile repo. An unrecognised project yields a profile that honestly
 * reports what it could not determine, and the metrics that depend on those findings are simply
 * absent from `supportedMetrics` — never guessed at.
 */

export interface DetectOptions {
  /** Where to start looking. Defaults to the process working directory. */
  readonly cwd?: string
}

export async function detectProject(options: DetectOptions = {}): Promise<ProjectProfile> {
  const startDir = path.resolve(options.cwd ?? process.cwd())
  const evidence: Evidence[] = []
  const warnings: string[] = []

  // Realpath, not the spelled path: git reports symlink-resolved paths (macOS /var vs
  // /private/var), and pathInRepo is computed against git's answer. A mismatch here once produced
  // a pathInRepo full of ../.. that ESCAPED the baseline worktree — resolve before comparing.
  const projectRoot = await realpath((await findProjectRoot(startDir)) ?? startDir)
  const pkg = await readPackageJson(projectRoot)

  if (pkg) {
    evidence.push({
      fact: 'language: javascript',
      source: path.join(path.relative(startDir, projectRoot) || '.', 'package.json'),
      ...(pkg.name ? { detail: `package "${pkg.name}"` } : {}),
    })
  } else {
    warnings.push(
      `No package.json found at or above ${startDir}. Nothing to measure — Driftwatch supports JS/TS projects in M1.`,
    )
  }

  const gitRoot = await findGitRoot(projectRoot)
  const pathInRepo = gitRoot ? path.relative(gitRoot, projectRoot) || '.' : null

  if (gitRoot) {
    evidence.push({
      fact: `git repository: ${gitRoot}`,
      source: 'git',
      detail: pathInRepo === '.' ? 'project sits at the repo root' : `project sits at ${pathInRepo}`,
    })
  } else {
    warnings.push(
      'Not inside a git repository. Baseline comparison needs one — the working tree can still be measured on its own.',
    )
  }

  const pm = await detectPackageManager(projectRoot, pkg)
  evidence.push(...pm.evidence)

  const framework = await detectFramework(projectRoot, pkg)
  evidence.push(...framework.evidence)
  warnings.push(...framework.warnings)

  const routeDetection = await detectRoutes(projectRoot)
  if (routeDetection.routes.length > 0) {
    evidence.push({
      fact: `${routeDetection.routes.length} route(s) detected`,
      source: routeDetection.sources.join(', '),
      detail: `${routeDetection.routers.join(' + ')} router`,
    })
  }

  const build = await resolveBuildCommand(projectRoot, pkg, pm.manager, warnings, evidence)
  const install = installCommand(pm.manager, pm.lockfile !== null)

  const canBuild = build !== null && framework.buildOutputDirs.length > 0
  // Only metrics with a collector behind them and a project able to produce them (hard rule 3).
  const supportedMetrics: MetricId[] = canBuild ? ['build_time', 'bundle_size'] : []

  if (!canBuild && pkg) {
    warnings.push('build_time and bundle_size are unavailable: no usable build command.')
  }

  return {
    projectRoot,
    gitRoot,
    pathInRepo,
    language: pkg ? 'javascript' : 'unknown',
    framework: framework.framework,
    frameworkVersion: framework.version,
    packageManager: pm.manager,
    lockfile: pm.lockfile,
    commands: { install, build, serve: framework.serve },
    buildOutputDirs: framework.buildOutputDirs,
    cacheDirs: framework.cacheDirs,
    routes: routeDetection.routes,
    supportedMetrics,
    warnings,
    evidence,
  }
}

/**
 * Walks up from `startDir` looking for a `package.json`.
 *
 * Running `driftwatch` from a subdirectory of a project is normal, so we search upward. The search
 * stops at the git root: crossing out of the repository would find some unrelated package.json in a
 * parent directory and measure the wrong project entirely.
 */
async function findProjectRoot(startDir: string): Promise<string | null> {
  const gitRoot = await findGitRoot(startDir)
  let dir = startDir

  for (;;) {
    if (await exists(path.join(dir, 'package.json'))) return dir
    if (gitRoot && path.resolve(dir) === path.resolve(gitRoot)) return null

    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

async function resolveBuildCommand(
  projectRoot: string,
  pkg: PackageJson | null,
  manager: ProjectProfile['packageManager'],
  warnings: string[],
  evidence: Evidence[],
): Promise<Command | null> {
  const script = pkg?.scripts?.build
  if (script) {
    evidence.push({
      fact: `build command: ${manager} run build`,
      source: 'package.json',
      detail: `scripts.build = "${script}"`,
    })
    return runScript(manager, 'build')
  }

  // No build script, but the framework binary is installed — use it directly rather than give up.
  const localNext = path.join(projectRoot, 'node_modules', '.bin', 'next')
  if (await exists(localNext)) {
    evidence.push({
      fact: 'build command: node_modules/.bin/next build',
      source: 'node_modules/.bin/next',
      detail: 'no scripts.build in package.json — fell back to the installed Next.js binary',
    })
    return { bin: localNext, args: ['build'] }
  }

  if (pkg) {
    warnings.push('No "build" script in package.json and no installed Next.js binary to fall back on.')
  }
  return null
}
