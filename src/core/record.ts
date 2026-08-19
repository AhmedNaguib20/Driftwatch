import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { loadConfig } from './detect/config-load.js'
import { exists } from './detect/fs-probe.js'
import { configFromProfile } from './detect/config-schema.js'
import { detectProject } from './detect/detect.js'
import { measureWorkingTree } from './measure/measure.js'
import type { ProgressReporter } from './measure/measure.js'
import { buildRecordResult } from './report/record-result.js'
import type { ResultJson } from './report/types.js'

const exec = promisify(execFile)

/**
 * Record mode (M5): the absolute measurement of one commit — current side only, no base, no
 * comparison, no AI. Same measurement path and protocol as a PR run's current side, so trend
 * points and PR points are the same instrument's readings.
 */
export interface RecordOptions {
  readonly cwd?: string
  readonly serve?: boolean
  readonly browser?: boolean
  readonly progress?: ProgressReporter
}

export async function recordRun(options: RecordOptions = {}): Promise<ResultJson> {
  const progress = options.progress ?? (() => {})

  progress('detecting project…')
  const profile = await detectProject({ cwd: options.cwd })
  const config = await loadConfig(profile.projectRoot, configFromProfile(profile))

  const sha = profile.gitRoot ? await headSha(profile.gitRoot) : null
  const branch = profile.gitRoot ? await headBranch(profile.gitRoot) : null

  // No lockfile rule in record mode (there is no other side): clone node_modules when present,
  // fresh-install when absent — a bare CI checkout must still produce a full trend point.
  const hasNodeModules = await exists(path.join(profile.projectRoot, 'node_modules'))
  const current = await measureWorkingTree(profile, (m) => progress(`current: ${m}`), {
    dependencies: hasNodeModules ? 'clone' : 'install',
    installIfAbsent: true,
    serve: (options.serve ?? true) && config.serve,
    browser: (options.browser ?? true) && config.browser,
  })

  return buildRecordResult({ profile, config, current, sha, branch })
}

async function headSha(gitRoot: string): Promise<string | null> {
  try {
    return (await exec('git', ['-C', gitRoot, 'rev-parse', 'HEAD'])).stdout.trim()
  } catch {
    return null
  }
}

async function headBranch(gitRoot: string): Promise<string | null> {
  try {
    const name = (await exec('git', ['-C', gitRoot, 'rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
    return name === 'HEAD' ? null : name
  } catch {
    return null
  }
}
