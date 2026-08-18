import pc from 'picocolors'
import { runDriftwatch } from '../core/index.js'
import { renderResult } from './render-table.js'

/**
 * `driftwatch run` — the full flow.
 *
 * stdout carries the deliverable (table, or with --json the schema-v1 JSON and NOTHING else, so
 * it pipes cleanly); progress goes to stderr — long silences look like hangs. Exit code is 0
 * always in M1 (warn-only; block_merge is not implemented): even a run that could not measure
 * reports an honest "inconclusive" and exits 0.
 */

export interface RunFlags {
  readonly base?: string
  readonly json: boolean
  readonly cache: boolean
  readonly cwd?: string
}

export async function runCommand(flags: RunFlags): Promise<void> {
  const progress = (message: string) => {
    console.error(pc.dim(`\u2192 ${message}`))
  }

  try {
    const result = await runDriftwatch({
      cwd: flags.cwd,
      base: flags.base,
      readCache: flags.cache,
      progress,
    })

    console.log(flags.json ? JSON.stringify(result, null, 2) : renderResult(result))
  } catch (error) {
    // A crash here is a driftwatch bug, not a project problem — say so honestly, still exit 0
    // (M1 is warn-only; a broken measurement must never break anyone's pipeline).
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
    console.error(pc.red(`driftwatch could not complete the run: ${message}`))
    console.error(pc.red('This is a driftwatch failure, not a verdict about your code.'))
    if (flags.json) {
      console.log(JSON.stringify({ error: 'driftwatch failed before producing a result' }))
    }
  }
}
