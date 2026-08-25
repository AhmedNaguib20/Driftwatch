#!/usr/bin/env node
import { Command } from 'commander'
import pc from 'picocolors'
import {
  DRIFTWATCH_VERSION,
  STALE_BUILD_ENV,
  buildStamp,
  checkStaleness,
  staleBuildRefusal,
} from '../core/index.js'
import { initCommand } from './init-command.js'
import { runCommand } from './run-command.js'

/**
 * Startup guard (spec v50): a compiled build older than its source is REFUSED, not warned about.
 * A warning is what we would have scrolled past; five days of both of us reasoning about code
 * that was not running is what it actually cost. The build hook in package.json covers install
 * and publish; this covers the case the hook cannot see — a source edit mid-session.
 */
const staleness = checkStaleness()
if (staleness.stale && process.env[STALE_BUILD_ENV] !== '1') {
  console.error(pc.red(staleBuildRefusal(staleness.detail!)))
  process.exit(1)
}
if (staleness.stale) {
  console.error(pc.yellow(`warning: running a stale build (${STALE_BUILD_ENV}=1) — ${staleness.detail}`))
}

const program = new Command()

program
  .name('driftwatch')
  .description('Measure code performance, compare against a baseline, explain regressions.')
  .version(`${DRIFTWATCH_VERSION} — ${buildStamp()}`)

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
  .option('--app <path>', 'which workspace package to measure (monorepos)')
  .option('--cwd <dir>', 'project directory', process.cwd())
  .action(async (flags: { base?: string; baseLabel?: string; json: boolean; cache: boolean; ai: boolean; serve: boolean; browser: boolean; verify: boolean; app?: string; cwd: string }) => {
    await runCommand(flags)
  })

program
  .command('record')
  .description('Measure this commit absolutely (trend point) — no baseline, no comparison, no AI')
  .option('--json', 'print the schema result JSON to stdout instead of the table', false)
  .option('--no-serve', 'skip booting the app and route-latency metrics')
  .option('--no-browser', 'skip Lighthouse browser metrics')
  .option('--no-verify', 'skip measuring the AI\'s suggested diff fix')
  .option('--app <path>', 'which workspace package to measure (monorepos)')
  .option('--cwd <dir>', 'project directory', process.cwd())
  .action(async (flags: { json: boolean; serve: boolean; browser: boolean; app?: string; cwd: string }) => {
    const { recordCommand } = await import('./record-command.js')
    await recordCommand(flags)
  })

program
  .command('replay')
  .description('Measure the mainline\'s recent history retroactively (record mode, no AI) — spec §10')
  .option('--last <n>', 'how many first-parent commits of the default branch to replay', '10')
  .option('--since <ref>', 'replay every mainline commit after <ref> instead of a count')
  .option('--yes', 'skip the cost-estimate confirmation', false)
  .option('--write-perf-data', 'consent to CREATE the perf-data branch in this repo if absent', false)
  .option('--push', 'push the batched perf-data update to origin (default: local only)', false)
  .option('--harvest', 'write eval candidate folders for each movement (human completes the truth)', false)
  .option('--app <path>', 'which workspace package to measure (monorepos)')
  .option('--json', 'print the replay summary as JSON', false)
  .option('--no-serve', 'skip booting the app and route-latency metrics')
  .option('--no-browser', 'skip Lighthouse browser metrics')
  .option('--cwd <dir>', 'project directory', process.cwd())
  .action(async (flags: { last?: string; since?: string; yes: boolean; push: boolean; writePerfData: boolean; harvest: boolean; app?: string; json: boolean; serve: boolean; browser: boolean; cwd: string }) => {
    const { replayCommand } = await import('./replay-command.js')
    await replayCommand(flags)
  })

program
  .command('trend')
  .description('Where has main been going? Reads the perf-data branch (read-only)')
  .option('--moves', 'print the movement report — the commits where metrics moved beyond noise', false)
  .option('--json', 'print the trend structures as JSON', false)
  .option('--no-fetch', 'use the local perf-data ref without fetching origin')
  .option('--cwd <dir>', 'project directory', process.cwd())
  .action(async (flags: { moves: boolean; json: boolean; fetch: boolean; cwd: string }) => {
    const { trendCommand } = await import('./trend-command.js')
    await trendCommand(flags)
  })

program
  .command('alerts')
  .description('What the recorded history would interrupt someone about — decided locally, writes nothing')
  .option('--json', 'print the alert decision as JSON', false)
  .option('--no-fetch', 'use the local perf-data ref without fetching origin')
  .option('--cwd <dir>', 'project directory', process.cwd())
  .action(async (flags: { json: boolean; fetch: boolean; cwd: string }) => {
    const { alertsCommand } = await import('./alerts-command.js')
    await alertsCommand(flags)
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
  .command('doctor')
  .description('Is the AI tier working? Reports key, provider, model and cost — writes nothing')
  .option('--json', 'print the report as JSON', false)
  .option('--cwd <dir>', 'project directory', process.cwd())
  .action(async (flags: { json: boolean; cwd: string }) => {
    const { doctorCommand } = await import('./doctor-command.js')
    await doctorCommand(flags)
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
  .option('--app <path>', 'which workspace package to measure (monorepos)')
  .option('--github', 'also write .github/workflows/driftwatch.yml', false)
  .option('--force', 'overwrite an existing workflow file', false)
  .action(async (options: { cwd: string; json: boolean; github: boolean; force: boolean; app?: string }) => {
    await initCommand(options)
  })

program.parseAsync(process.argv)
