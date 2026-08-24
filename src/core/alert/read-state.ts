import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ALERT_STATE_FILE, emptyAlertState, parseAlertState } from './state.js'
import type { AlertState } from './state.js'

const exec = promisify(execFile)

/**
 * Reads alert state from a perf-data ref. Read-only, like every trend read: nothing of the user's
 * is written, and an absent file is not an error — a branch that has never alerted has no state.
 */
export async function readAlertState(
  gitRoot: string,
  ref: string,
): Promise<{ state: AlertState } | { unreadable: string }> {
  try {
    const { stdout } = await exec('git', ['-C', gitRoot, 'show', `${ref}:${ALERT_STATE_FILE}`], {
      maxBuffer: 8 * 1024 * 1024,
    })
    const state = parseAlertState(stdout)
    if (state === null) {
      return { unreadable: `${ALERT_STATE_FILE} on ${ref} is not driftwatch's alert state — refusing to read it as ours` }
    }
    return { state }
  } catch {
    return { state: emptyAlertState() }
  }
}
