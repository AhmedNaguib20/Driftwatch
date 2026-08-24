import pc from 'picocolors'
import {
  ALERT_STATE_FILE,
  assessAlerts,
  buildStamp,
  detectProject,
  emptyAlertState,
  loadConfig,
  readAlertState,
  readPerfDataIndex,
} from '../core/index.js'
import { renderAlerts } from './render-alerts.js'

/**
 * `driftwatch alerts` — what the stored history would interrupt someone about, decided locally
 * from the perf-data branch. Read-only in every sense: no GitHub, and no state is written. The
 * scheduled surface that fires and records is M10's next step; this proves the decision first,
 * which is hard rule 7 (the CLI is the product; CI is one consumer of it).
 */
export async function alertsCommand(flags: { json: boolean; fetch: boolean; cwd: string }): Promise<void> {
  const profile = await detectProject({ cwd: flags.cwd })
  if (!profile.gitRoot) {
    console.error(pc.yellow('not inside a git repository — there is no perf-data branch to read'))
    return
  }

  const read = await readPerfDataIndex(profile.gitRoot, { fetch: flags.fetch })
  if ('unavailable' in read) {
    if (flags.json) console.log(JSON.stringify({ unavailable: read.unavailable }))
    else console.log(pc.yellow(read.unavailable))
    return
  }

  const stored = await readAlertState(profile.gitRoot, read.ref)
  if ('unreadable' in stored) {
    if (flags.json) console.log(JSON.stringify({ unavailable: stored.unreadable }))
    else console.log(pc.yellow(stored.unreadable))
    return
  }

  const config = await loadConfig(profile.projectRoot)
  const assessment = assessAlerts(read.index, stored.state ?? emptyAlertState(), {
    now: new Date().toISOString(),
    prThresholdPercent: config.thresholdPercent,
  })

  if (flags.json) {
    console.log(JSON.stringify({ ref: read.ref, entries: read.index.entries.length, ...assessment }, null, 2))
    return
  }

  const open = stored.state.open.length
  const stateNote =
    `${buildStamp()} · state: ${open === 0 ? `no open alerts (${ALERT_STATE_FILE} absent or empty)` : `${open} open alert(s) from ${ALERT_STATE_FILE}`} on ${read.ref}` +
    ' · nothing is written by this command'
  console.log(renderAlerts(assessment, read.index.entries.length, stateNote))
}
