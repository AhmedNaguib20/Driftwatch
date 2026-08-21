import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ResultJson } from '../report/types.js'
import { assessDrift } from './drift.js'
import { renderDashboard } from './dashboard/index.js'
import { appendEntry, entryFromResult } from './index-file.js'
import type { EntryCommitInfo } from './index-file.js'
import { PERF_DATA_BRANCH, commitPerfDataTree, git, openPerfDataTree } from './store-tree.js'
import { buildTimelines } from './timeline.js'

/**
 * The perf-data branch writer (spec §6.3): results as JSON in a dedicated orphan branch of the
 * user's own repo — plain Git, portable, no backend. Worktree mechanics live in store-tree.ts.
 *
 *  - perf-data absent → created as an orphan.
 *  - perf-data present WITHOUT our index marker → refuse. It is somebody else's branch.
 *  - Racing appends (two pushes landing together) → fetch-and-reapply once; a second conflict
 *    warns and gives up: a missing trend point is recoverable, a corrupted index is not.
 */

export { PERF_DATA_BRANCH }

export interface AppendOutcome {
  readonly ok: boolean
  /** 'appended' | 'appended-after-retry' | a refusal/give-up reason. */
  readonly detail: string
}

export async function appendToPerfData(
  gitRoot: string,
  result: ResultJson,
  sha: string,
  branch: string | null,
  push: boolean,
  /** CI record mode: installing the workflow IS the consent to create perf-data (spec §6.3). */
  allowCreate = true,
): Promise<AppendOutcome> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const outcome = await tryAppend(gitRoot, result, sha, branch, push, allowCreate)
    if (outcome !== 'push-rejected') {
      return {
        ok: outcome === 'appended',
        detail: outcome === 'appended' && attempt === 2 ? 'appended-after-retry' : outcome,
      }
    }
  }
  return {
    ok: false,
    detail:
      'perf-data push rejected twice (concurrent runs racing) — giving up on this trend point; a missing point is recoverable, a corrupted index is not',
  }
}

type AttemptOutcome = 'appended' | 'push-rejected' | string

async function tryAppend(
  gitRoot: string,
  result: ResultJson,
  sha: string,
  branch: string | null,
  push: boolean,
  allowCreate: boolean,
): Promise<AttemptOutcome> {
  let opened
  try {
    opened = await openPerfDataTree(gitRoot, push, allowCreate)
  } catch (error) {
    return `perf-data append failed: ${(error as Error).message}`
  }
  if ('refusal' in opened) return opened.refusal
  const { tree, index, hasRemote, cleanup } = opened

  try {
    await mkdir(path.join(tree, 'results'), { recursive: true })
    await writeFile(
      path.join(tree, 'results', `${sha.slice(0, 12)}.json`),
      JSON.stringify(result, null, 2) + '\n',
      'utf8',
    )
    const updated = appendEntry(index, entryFromResult(result, sha, branch, await commitInfo(gitRoot, sha)))
    await writeFile(path.join(tree, 'index.json'), JSON.stringify(updated, null, 2) + '\n', 'utf8')

    // The dashboard is regenerated on every append: point GitHub Pages at this branch and the
    // trend chart is always current (spec §6.3 — no server, no backend).
    const reports = buildTimelines(updated).map((timeline) => ({ timeline, drift: assessDrift(timeline) }))
    await writeFile(
      path.join(tree, 'index.html'),
      renderDashboard({
        reports,
        index: updated,
        generatedAt: result.createdAt,
        sourceLabel: branch,
      }),
      'utf8',
    )

    const committed = await commitPerfDataTree(
      gitRoot,
      tree,
      `record ${sha.slice(0, 12)}${branch ? ` (${branch})` : ''}`,
      push,
      hasRemote,
    )
    return committed === 'committed' ? 'appended' : 'push-rejected'
  } catch (error) {
    return `perf-data append failed: ${(error as Error).message}`
  } finally {
    await cleanup()
  }
}

/**
 * Author date + first parent for the entry's topology fields (M7 ordering). Undefined when the
 * sha is unknown to this clone (shallow checkout) — the entry then orders by its measurement
 * timestamp.
 */
export async function commitInfo(gitRoot: string, sha: string): Promise<EntryCommitInfo | undefined> {
  try {
    const raw = (await git(gitRoot, ['show', '-s', '--format=%aI %P', sha])).trim()
    const [committedAt, ...parents] = raw.split(/\s+/)
    if (!committedAt) return undefined
    return { committedAt, parentSha: parents[0] ?? null }
  } catch {
    return undefined
  }
}
