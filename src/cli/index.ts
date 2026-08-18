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
  .option('--json', 'print the schema-v1 result JSON to stdout instead of the table', false)
  .option('--no-cache', 'ignore the baseline cache for this run (results are still written)')
  .option('--no-ai', 'skip AI analysis entirely — fully offline run (also: DRIFTWATCH_NO_AI=1)')
  .option('--cwd <dir>', 'project directory', process.cwd())
  .action(async (flags: { base?: string; json: boolean; cache: boolean; ai: boolean; cwd: string }) => {
    await runCommand(flags)
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
  .action(async (options: { cwd: string; json: boolean }) => {
    await initCommand(options)
  })

program.parseAsync(process.argv)
