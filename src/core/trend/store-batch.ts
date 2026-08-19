import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ResultJson } from '../report/types.js'
import { assessDrift } from './drift.js'
import { renderDashboard } from './dashboard/index.js'
import { appendEntry, entryFromResult } from './index-file.js'
import type { IndexEntry } from './index-file.js'
import { commitPerfDataTree, openPerfDataTree } from './store-tree.js'
import { buildTimelines } from './timeline.js'

/**
 * The replay batch writer (M7): ONE perf-data update for a whole replay — every measured result,
 * every honest skip, one index rewrite, one dashboard regeneration, one commit. Local by
 * default; push is the caller's explicit choice (`--push`).
 */

export interface ReplayBatchItem {
  readonly sha: string
  readonly branch: string | null
  readonly committedAt: string
  readonly parentSha: string | null
  /** Present for a measured commit. */
  readonly result?: ResultJson
  /** Present when the commit could not be measured — reason with log tail (spec §10). */
  readonly skipReason?: string
  /** Measurement-attempt time for skipped entries (measured ones carry result.createdAt). */
  readonly attemptedAt: string
}

export interface BatchOutcome {
  readonly ok: boolean
  readonly detail: string
}

export async function appendReplayBatch(
  gitRoot: string,
  batch: readonly ReplayBatchItem[],
  push: boolean,
): Promise<BatchOutcome> {
  if (batch.length === 0) return { ok: true, detail: 'nothing to write' }

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const outcome = await tryBatch(gitRoot, batch, push)
    if (outcome !== 'push-rejected') {
      return {
        ok: outcome === 'written',
        detail: outcome === 'written' ? (attempt === 2 ? 'written-after-retry' : 'written') : outcome,
      }
    }
  }
  return {
    ok: false,
    detail:
      'perf-data push rejected twice (concurrent runs racing) — the batch is still committed locally; push it later with a record run or by hand',
  }
}

async function tryBatch(
  gitRoot: string,
  batch: readonly ReplayBatchItem[],
  push: boolean,
): Promise<'written' | 'push-rejected' | string> {
  let opened
  try {
    opened = await openPerfDataTree(gitRoot, push)
  } catch (error) {
    return `perf-data batch write failed: ${(error as Error).message}`
  }
  if ('refusal' in opened) return opened.refusal
  const { tree, index, hasRemote, cleanup } = opened

  try {
    await mkdir(path.join(tree, 'results'), { recursive: true })
    let updated = index
    for (const item of batch) {
      if (item.result) {
        await writeFile(
          path.join(tree, 'results', `${item.sha.slice(0, 12)}.json`),
          JSON.stringify(item.result, null, 2) + '\n',
          'utf8',
        )
        updated = appendEntry(
          updated,
          entryFromResult(item.result, item.sha, item.branch, {
            committedAt: item.committedAt,
            parentSha: item.parentSha,
            replayed: true,
          }),
        )
      } else {
        updated = appendEntry(updated, skippedEntry(item))
      }
    }
    await writeFile(path.join(tree, 'index.json'), JSON.stringify(updated, null, 2) + '\n', 'utf8')

    const generatedAt = batch.map((i) => i.result?.createdAt ?? i.attemptedAt).sort().at(-1)!
    const reports = buildTimelines(updated).map((timeline) => ({ timeline, drift: assessDrift(timeline) }))
    await writeFile(
      path.join(tree, 'index.html'),
      renderDashboard({
        reports,
        index: updated,
        generatedAt,
        sourceLabel: batch[0]!.branch,
      }),
      'utf8',
    )

    const measured = batch.filter((i) => i.result).length
    const committed = await commitPerfDataTree(
      gitRoot,
      tree,
      `replay ${batch.length} commit(s) (${measured} measured, ${batch.length - measured} skipped)`,
      push,
      hasRemote,
    )
    return committed === 'committed' ? 'written' : 'push-rejected'
  } catch (error) {
    return `perf-data batch write failed: ${(error as Error).message}`
  } finally {
    await cleanup()
  }
}

/**
 * A commit replay could not measure stays in history as an honest skip: no metrics (it
 * contributes no timeline points, so its placeholder protocol can never split a segment), the
 * reason with its log tail preserved.
 */
function skippedEntry(item: ReplayBatchItem): IndexEntry {
  return {
    sha: item.sha,
    shortSha: item.sha.slice(0, 12),
    timestamp: item.attemptedAt,
    branch: item.branch,
    committedAt: item.committedAt,
    parentSha: item.parentSha,
    replayed: true,
    skipped: { reason: item.skipReason ?? 'unknown failure' },
    metrics: {},
    protocol: {
      nodeVersion: 'unknown',
      platform: 'unknown',
      arch: 'unknown',
      browser: 'none',
      hostLabels: [],
      driftwatchVersion: 'unknown',
    },
  }
}
