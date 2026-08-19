import { createInterface } from 'node:readline'
import pc from 'picocolors'
import { replayHistory } from '../core/index.js'

/**
 * `driftwatch replay --last N | --since <ref>` — measure the mainline's recent history
 * retroactively (spec §10). Cost is confirmed before work; per-commit progress goes to stderr
 * (hours of silence is the M3 lesson); one perf-data update at the end, local unless --push.
 */
export async function replayCommand(flags: {
  last?: string
  since?: string
  yes: boolean
  push: boolean
  json: boolean
  serve: boolean
  browser: boolean
  cwd: string
}): Promise<void> {
  const progress = (message: string) => console.error(pc.dim(`→ ${message}`))

  const last = flags.last !== undefined ? Number.parseInt(flags.last, 10) : undefined
  if (flags.last !== undefined && (!Number.isInteger(last) || last! <= 0)) {
    console.error(pc.red(`--last must be a positive integer, got "${flags.last}"`))
    process.exitCode = 1
    return
  }

  try {
    const summary = await replayHistory({
      cwd: flags.cwd,
      last,
      since: flags.since,
      serve: flags.serve,
      browser: flags.browser,
      push: flags.push,
      confirm: flags.yes ? undefined : confirmOnTerminal,
      progress,
    })

    if (flags.json) {
      console.log(JSON.stringify(summary, null, 2))
      return
    }
    if (summary.write.detail === 'declined') {
      console.log(pc.yellow('replay declined — nothing was measured.'))
      return
    }
    const parts = [
      `${summary.measured} measured`,
      ...(summary.resumed > 0 ? [`${summary.resumed} resumed from a previous interrupt`] : []),
      ...(summary.alreadyRecorded > 0 ? [`${summary.alreadyRecorded} already recorded`] : []),
      ...(summary.skipped.length > 0 ? [`${summary.skipped.length} skipped`] : []),
    ]
    console.log(`replay: ${parts.join(', ')} — perf-data ${summary.write.detail}${flags.push ? '' : ' (local; use --push to publish)'}`)
    for (const skip of summary.skipped) {
      console.log(pc.yellow(`  skipped ${skip.sha.slice(0, 12)}: ${skip.reason.split('\n')[0]}`))
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(pc.red(`driftwatch replay failed before measuring: ${message}`))
    process.exitCode = 1
  }
}

/** The estimate → a real y/N prompt. Non-interactive without --yes refuses rather than assumes. */
async function confirmOnTerminal(description: string): Promise<boolean> {
  console.error(`${pc.bold('replay cost:')} ${description}.`)
  if (!process.stdin.isTTY) {
    console.error(pc.yellow('not a terminal and --yes was not given — refusing to start hours of work unconfirmed.'))
    return false
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  const answer = await new Promise<string>((resolve) => rl.question('Proceed? [y/N] ', resolve))
  rl.close()
  return /^y(es)?$/i.test(answer.trim())
}
