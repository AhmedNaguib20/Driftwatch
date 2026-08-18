#!/usr/bin/env node
import { Command } from 'commander'
import pc from 'picocolors'
import path from 'node:path'
import { configFromProfile, detectProject, writeConfigIfAbsent } from '../core/index.js'
import type { ProjectProfile } from '../core/index.js'

const program = new Command()

program
  .name('driftwatch')
  .description('Measure code performance, compare against a baseline, explain regressions.')
  .version('0.1.0')

program
  .command('run', { isDefault: true })
  .description('Measure the working tree and compare it against a base commit')
  .option('--base <ref>', 'git ref to compare against')
  .option('--json', 'print the result JSON instead of the terminal table', false)
  .option('--no-ai', 'skip AI analysis (fully offline run)')
  .action(() => {
    console.error('driftwatch run is not implemented yet (M1 step 5).')
    process.exitCode = 1
  })

program
  .command('init')
  .description('Detect the stack and write perf.yml')
  .option('--cwd <dir>', 'directory to detect in', process.cwd())
  .option('--json', 'print the project profile as JSON', false)
  .action(async (options: { cwd: string; json: boolean }) => {
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
  })

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
      const detail = item.detail ? pc.dim(` — ${item.detail}`) : ''
      console.log(`  ${item.fact} ${pc.dim(`[${item.source}]`)}${detail}`)
    }
  }

  for (const warning of profile.warnings) {
    console.log(`\n${pc.yellow('warning')} ${warning}`)
  }
}

program.parseAsync(process.argv)
