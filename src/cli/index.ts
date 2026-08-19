#!/usr/bin/env node
import { Command } from 'commander'
import { initCommand } from './init-command.js'
import { runCommand } from './run-command.js'

const program = new Command()

program
  .name('driftwatch')
  .description('Measure code performance, compare against a baseline, explain regressions.')
  .version('0.2.0')

program
  .command('run', { isDefault: true })
  .description('Measure the working tree and compare it against a base commit')
  .option('--base <ref>', 'git ref to compare against (default: base from perf.yml, else main)')
  .option('--base-label <name>', 'display name for the base when --base is a bare SHA (CI use)')
  .option('--json', 'print the schema-v1 result JSON to stdout instead of the table', false)
  .option('--no-cache', 'ignore the baseline cache for this run (results are still written)')
  .option('--no-ai', 'skip AI analysis entirely — fully offline run (also: DRIFTWATCH_NO_AI=1)')
  .option('--no-serve', 'skip booting the app and route-latency metrics')
  .option('--no-browser', 'skip Lighthouse browser metrics')
  .option('--no-verify', 'skip measuring the AI\'s suggested diff fix')
  .option('--cwd <dir>', 'project directory', process.cwd())
  .action(async (flags: { base?: string; baseLabel?: string; json: boolean; cache: boolean; ai: boolean; serve: boolean; browser: boolean; verify: boolean; cwd: string }) => {
    await runCommand(flags)
  })

program
  .command('record')
  .description('Measure this commit absolutely (trend point) — no baseline, no comparison, no AI')
  .option('--json', 'print the schema result JSON to stdout instead of the table', false)
  .option('--no-serve', 'skip booting the app and route-latency metrics')
  .option('--no-browser', 'skip Lighthouse browser metrics')
  .option('--no-verify', 'skip measuring the AI\'s suggested diff fix')
  .option('--cwd <dir>', 'project directory', process.cwd())
  .action(async (flags: { json: boolean; serve: boolean; browser: boolean; cwd: string }) => {
    const { recordCommand } = await import('./record-command.js')
    await recordCommand(flags)
  })

program
  .command('trend')
  .description('Where has main been going? Reads the perf-data branch (read-only)')
  .option('--json', 'print the trend structures as JSON', false)
  .option('--no-fetch', 'use the local perf-data ref without fetching origin')
  .option('--cwd <dir>', 'project directory', process.cwd())
  .action(async (flags: { json: boolean; fetch: boolean; cwd: string }) => {
    const { trendCommand } = await import('./trend-command.js')
    await trendCommand(flags)
  })

program
  .command('dashboard')
  .description('Write the static trend dashboard to .perf/dashboard.html from the perf-data branch')
  .option('--open', 'open it in the default browser', false)
  .option('--no-fetch', 'use the local perf-data ref without fetching origin')
  .option('--cwd <dir>', 'project directory', process.cwd())
  .action(async (flags: { open: boolean; fetch: boolean; cwd: string }) => {
    const { dashboardCommand } = await import('./dashboard-command.js')
    await dashboardCommand(flags)
  })

program
  .command('eval', { hidden: true })
  .description('dev: run the eval cases against the live provider and judge the prompts')
  .option('--cases <dir>', 'cases directory', 'eval/cases')
  .action(async (options: { cases: string }) => {
    const { evalCommand } = await import('./eval-command.js')
    await evalCommand(options)
  })

program
  .command('init')
  .description('Detect the stack and write perf.yml')
  .option('--cwd <dir>', 'directory to detect in', process.cwd())
  .option('--json', 'print the project profile as JSON', false)
  .option('--github', 'also write .github/workflows/driftwatch.yml', false)
  .option('--force', 'overwrite an existing workflow file', false)
  .action(async (options: { cwd: string; json: boolean; github: boolean; force: boolean }) => {
    await initCommand(options)
  })

program.parseAsync(process.argv)
