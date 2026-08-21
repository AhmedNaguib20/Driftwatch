import { createInterface } from 'node:readline'
import pc from 'picocolors'
import { detectProject, harvestCandidates, movementReport, readPerfDataIndex, replayHistory } from '../core/index.js'
import { renderMovements } from './render-moves.js'

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
  writePerfData: boolean
  harvest: boolean
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
      writePerfData: flags.writePerfData,
      // --yes skips the question, never the information: the cost line still prints.
      confirm: flags.yes
        ? async (description) => {
            console.error(`${pc.bold('replay cost:')} ${description}. (--yes given — proceeding)`)
            return true
          }
        : confirmOnTerminal,
      progress,
    })

    if (summary.write.detail === 'declined') {
      if (flags.json) console.log(JSON.stringify(summary, null, 2))
      else console.log(pc.yellow('replay declined — nothing was measured.'))
      return
    }

    // The movement report — the reason replay exists. Read back what the branch now holds.
    const profile = await detectProject({ cwd: flags.cwd })
    const read = profile.gitRoot ? await readPerfDataIndex(profile.gitRoot, { fetch: false }) : null
    const report = read && 'index' in read ? movementReport(read.index) : { moved: [], notJudged: [] }
    const entryCount = read && 'index' in read ? read.index.entries.length : 0

    // The harvest follows the doctrine for free: only attributable movements make candidates.
    const harvest =
      flags.harvest && profile.gitRoot && report.moved.length > 0
        ? await harvestCandidates(profile.gitRoot, report.moved)
        : null

    if (flags.json) {
      console.log(JSON.stringify({ ...summary, movements: report, harvest }, null, 2))
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
    console.log('')
    console.log(renderMovements(report, entryCount))
    if (harvest) {
      for (const dir of harvest.written) console.log(pc.dim(`  harvested ${dir}`))
      for (const dir of harvest.skippedExisting) console.log(pc.dim(`  candidate exists, left untouched: ${dir}`))
      for (const sha of harvest.missing) console.log(pc.yellow(`  could not harvest ${sha.slice(0, 12)}: endpoint results not on the perf-data branch`))
    } else if (flags.harvest && report.moved.length === 0) {
      console.log(pc.dim('  nothing to harvest — no movements.'))
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
