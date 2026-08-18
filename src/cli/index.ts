#!/usr/bin/env node
import { Command } from 'commander'

const program = new Command()

program
  .name('driftwatch')
  .description('Measure code performance, compare against a baseline, explain regressions.')
  .version('0.1.0')

program
  .command('run', { isDefault: true })
  .description('Measure the working tree and compare it against a base commit')
  .option('--base <ref>', 'git ref to compare against', 'main')
  .option('--json', 'print the result JSON instead of the terminal table', false)
  .option('--no-ai', 'skip AI analysis (fully offline run)')
  .action(() => {
    console.error('driftwatch run is not implemented yet (M1 in progress).')
    process.exitCode = 1
  })

program
  .command('init')
  .description('Detect the stack and write perf.yml')
  .action(() => {
    console.error('driftwatch init is not implemented yet (M1 in progress).')
    process.exitCode = 1
  })

program.parseAsync(process.argv)
