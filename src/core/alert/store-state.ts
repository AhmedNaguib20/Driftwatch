import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { commitPerfDataTree, openPerfDataTree } from '../trend/store-tree.js'
import { ALERT_STATE_FILE } from './state.js'
import type { AlertState } from './state.js'

/**
 * Persisting alert state to the perf-data branch — beside the data it describes.
 *
 * **State records what was SAID, not what was decided.** The caller publishes first and passes
 * the state earned by the events that actually landed; if publishing failed, nothing is recorded,
 * and the next run says it again. Recording an alert we never delivered would suppress the only
 * thing that could have told anyone.
 *
 * Consent needs no gate here: alerting reads a perf-data branch that must already exist to hold
 * the history it judges, so this never creates one (`allowCreate: false`, always).
 */

export interface StateWriteOutcome {
  readonly ok: boolean
  readonly detail: string
}

export async function writeAlertState(
  gitRoot: string,
  state: AlertState,
  push: boolean,
): Promise<StateWriteOutcome> {
  let opened
  try {
    opened = await openPerfDataTree(gitRoot, push, false)
  } catch (error) {
    return { ok: false, detail: `alert state not written: ${(error as Error).message}` }
  }
  if ('refusal' in opened) return { ok: false, detail: opened.refusal }
  const { tree, hasRemote, cleanup } = opened

  try {
    await writeFile(path.join(tree, ALERT_STATE_FILE), JSON.stringify(state, null, 2) + '\n', 'utf8')
    const open = state.open.length
    const committed = await commitPerfDataTree(
      gitRoot,
      tree,
      `alerts: ${open} open condition${open === 1 ? '' : 's'}`,
      push,
      hasRemote,
    )
    return committed === 'committed'
      ? { ok: true, detail: `alert state written (${open} open)` }
      : { ok: false, detail: 'alert state push rejected (a concurrent run wrote first) — nothing recorded' }
  } catch (error) {
    return { ok: false, detail: `alert state not written: ${(error as Error).message}` }
  } finally {
    await cleanup()
  }
}
