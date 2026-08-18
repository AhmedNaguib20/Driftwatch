import path from 'node:path'
import pc from 'picocolors'
import { configFromProfile, detectProject, writeConfigIfAbsent } from '../core/index.js'
import type { ProjectProfile } from '../core/index.js'

/** `driftwatch init` — detect the stack, print what was concluded and why, write perf.yml. */
export async function initCommand(options: { cwd: string; json: boolean }): Promise<void> {
  const profile = await detectProject({ cwd: options.cwd })

  if (options.json) {
    console.log(JSON.stringify(profile, null, 2))
    return
  }

  printProfile(profile)

  const result = await writeConfigIfAbsent(profile.projectRoot, configFromProfile(profile))
  const rel = path.relative(process.cwd(), result.path) || result.path
  console.log(
    result.created
      ? `\n${pc.green('wrote')} ${rel}`
      : `\n${pc.dim('kept')}  ${rel} ${pc.dim(`(${result.reason})`)}`,
  )
}

function printProfile(profile: ProjectProfile): void {
  const rows: [string, string][] = [
    ['project', profile.projectRoot],
    ['framework', profile.frameworkVersion
      ? `${profile.framework} ${profile.frameworkVersion}`
      : profile.framework],
    ['package manager', profile.lockfile
      ? `${profile.packageManager} (${profile.lockfile})`
      : `${profile.packageManager} (no lockfile)`],
    ['build', profile.commands.build
      ? [profile.commands.build.bin, ...profile.commands.build.args].join(' ')
      : pc.yellow('none')],
    ['routes', profile.routes.length > 0 ? String(profile.routes.length) : pc.dim('none found')],
    ['metrics', profile.supportedMetrics.length > 0
      ? profile.supportedMetrics.join(', ')
      : pc.yellow('none available')],
  ]

  const width = Math.max(...rows.map(([label]) => label.length))
  for (const [label, value] of rows) {
    console.log(`${pc.dim(label.padEnd(width))}  ${value}`)
  }

  if (profile.evidence.length > 0) {
    console.log(`\n${pc.dim('evidence')}`)
    for (const item of profile.evidence) {
      const detail = item.detail ? pc.dim(` \u2014 ${item.detail}`) : ''
      console.log(`  ${item.fact} ${pc.dim(`[${item.source}]`)}${detail}`)
    }
  }

  for (const warning of profile.warnings) {
    console.log(`\n${pc.yellow('warning')} ${warning}`)
  }
}
