import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { promisify } from 'node:util'
import { selectApp } from '../detect/select-app.js'
import { SelectionRefused } from '../detect/refusal.js'
import { recordRun } from '../record.js'
import type { ResultJson } from '../report/types.js'
import { readPerfDataIndex } from '../trend/read.js'
import { appendReplayBatch } from '../trend/store-batch.js'
import type { BatchOutcome, ReplayBatchItem } from '../trend/store-batch.js'
import { resolveReplayCommits } from './commits.js'
import type { ReplayCommit, ReplayRange } from './commits.js'
import { describeEstimate, estimate, readLastRecordSeconds, writeLastRecordSeconds } from './estimate.js'
import { clearPending, loadPending, savePending } from './pending.js'

const exec = promisify(execFile)

/**
 * Git History Replay (spec §10): measure the mainline's recent history retroactively, in record
 * mode, on the developer's own machine. The oldest promises hold in code:
 *
 *  - the user picks N; cost is estimated from THIS machine's last record run and confirmed
 *    before any work;
 *  - a commit that fails to build/detect/install is marked skipped with the reason and a log
 *    tail — the loop NEVER aborts;
 *  - every measured commit lands in .perf/replay-pending/ immediately (Ctrl-C loses nothing;
 *    a rerun resumes), and perf-data is written ONCE at the end.
 *
 * Every commit is checked out into its own temp worktree — the user's working directory is
 * never touched (hard rule 2).
 */

export interface ReplayOptions extends ReplayRange {
  readonly cwd?: string
  readonly serve?: boolean
  readonly browser?: boolean
  readonly push?: boolean
  /** Explicit consent to CREATE the perf-data branch when it does not exist yet (spec §9a). */
  readonly writePerfData?: boolean
  /** Shown the estimate; returns whether to proceed. CLI wires the prompt; --yes short-circuits. */
  readonly confirm?: (description: string) => Promise<boolean>
  readonly progress?: (message: string) => void
  /** `--app <path>`: which workspace package to measure (spec §9a). */
  readonly app?: string | null
  /** Injectable for tests; defaults to the real record-mode measurement. */
  readonly recordFn?: typeof recordRun
}

export interface ReplaySummary {
  readonly planned: number
  readonly alreadyRecorded: number
  readonly resumed: number
  readonly measured: number
  readonly skipped: readonly { readonly sha: string; readonly reason: string }[]
  readonly write: BatchOutcome | { readonly ok: true; readonly detail: 'declined' | 'nothing to do' }
}

export async function replayHistory(options: ReplayOptions): Promise<ReplaySummary> {
  const progress = options.progress ?? (() => {})
  const record = options.recordFn ?? recordRun

  const selection = await selectApp({ cwd: options.cwd, app: options.app ?? null })
  if (selection.refusal) throw new SelectionRefused(selection.refusal)
  const profile = selection.profile
  if (!profile.gitRoot) throw new Error('replay needs a git repository — no .git found above the project')
  const gitRoot = profile.gitRoot
  const pathInRepo = profile.pathInRepo ?? '.'

  const { commits, branch } = await resolveReplayCommits(gitRoot, { last: options.last, since: options.since })
  if (commits.length === 0) {
    return { planned: 0, alreadyRecorded: 0, resumed: 0, measured: 0, skipped: [], write: { ok: true, detail: 'nothing to do' } }
  }

  // Dedup against the index (no fetch here — replay is local-first; --push fetches at write time).
  const read = await readPerfDataIndex(gitRoot, { fetch: false })
  const recorded = new Set('index' in read ? read.index.entries.map((e) => e.sha) : [])
  const pending = await loadPending(profile.projectRoot)

  const todo = commits.filter((c) => !recorded.has(c.sha))
  const fresh = todo.filter((c) => !pending.has(c.sha))
  for (const c of commits.filter((x) => recorded.has(x.sha))) {
    progress(`${c.shortSha} already recorded — skipping`)
  }
  for (const c of todo.filter((x) => pending.has(x.sha))) {
    progress(`${c.shortSha} found in .perf/replay-pending — resuming without re-measuring`)
  }

  if (todo.length === 0) {
    return { planned: commits.length, alreadyRecorded: commits.length, resumed: 0, measured: 0, skipped: [], write: { ok: true, detail: 'nothing to do' } }
  }

  // Estimate + confirmation BEFORE work (spec §10) — only fresh commits cost anything.
  if (fresh.length > 0) {
    const perCommit = await readLastRecordSeconds(profile.projectRoot)
    const description = describeEstimate(estimate(fresh.length, perCommit))
    const proceed = options.confirm ? await options.confirm(description) : true
    if (!proceed) {
      return { planned: commits.length, alreadyRecorded: commits.length - todo.length, resumed: 0, measured: 0, skipped: [], write: { ok: true, detail: 'declined' } }
    }
  }

  const batch: ReplayBatchItem[] = []
  const skipped: { sha: string; reason: string }[] = []
  let resumed = 0
  let measured = 0

  for (const [i, commit] of todo.entries()) {
    const position = `${i + 1}/${todo.length}`
    const held = pending.get(commit.sha)
    if (held) {
      resumed += 1
      batch.push(toBatchItem(commit, branch, held.result, held.skipReason))
      continue
    }

    const started = performance.now()
    progress(`[${position}] ${commit.shortSha} "${commit.subject.slice(0, 60)}" — measuring…`)
    const outcome = await measureCommit(gitRoot, pathInRepo, commit, record, options)
    const elapsed = (performance.now() - started) / 1000

    if ('result' in outcome) {
      measured += 1
      await writeLastRecordSeconds(profile.projectRoot, elapsed)
      await savePending(profile.projectRoot, { sha: commit.sha, result: outcome.result })
      batch.push(toBatchItem(commit, branch, outcome.result))
      progress(`[${position}] ${commit.shortSha} measured in ${Math.round(elapsed)}s`)
    } else {
      skipped.push({ sha: commit.sha, reason: outcome.skipReason })
      await savePending(profile.projectRoot, { sha: commit.sha, skipReason: outcome.skipReason })
      batch.push(toBatchItem(commit, branch, undefined, outcome.skipReason))
      progress(`[${position}] ${commit.shortSha} SKIPPED after ${Math.round(elapsed)}s — ${outcome.skipReason.split('\n')[0]}`)
    }
  }

  progress(`writing ${batch.length} entr${batch.length === 1 ? 'y' : 'ies'} to perf-data in one update…`)
  const write = await appendReplayBatch(gitRoot, batch, options.push ?? false, options.writePerfData ?? false)
  if (write.ok) await clearPending(profile.projectRoot)

  return { planned: commits.length, alreadyRecorded: commits.length - todo.length, resumed, measured, skipped, write }
}

/** A failed commit yields a reason with the error's log tail — never an aborted replay. */
async function measureCommit(
  gitRoot: string,
  pathInRepo: string,
  commit: ReplayCommit,
  record: typeof recordRun,
  options: Pick<ReplayOptions, 'serve' | 'browser' | 'progress'>,
): Promise<{ result: ResultJson } | { skipReason: string }> {
  const parent = await mkdtemp(path.join(tmpdir(), 'driftwatch-replay-'))
  const tree = path.join(parent, 'tree')
  try {
    await exec('git', ['-C', gitRoot, 'worktree', 'add', '--detach', tree, commit.sha])
    const projectDir = path.join(tree, pathInRepo)
    const result = await record({
      cwd: projectDir,
      serve: options.serve,
      browser: options.browser,
      progress: (m) => options.progress?.(`  ${commit.shortSha}: ${m}`),
    })
    // Measurement never throws on a failing build (conventions) — it returns a result whose
    // metrics are skipped with reasons. A commit where NOTHING measured is spec §10's "fails to
    // build" case: the entry is marked skipped, carrying those reasons as its log tail.
    if ('metrics' in result.current && !result.current.metrics.some((m) => m.status === 'measured')) {
      const reasons = result.current.metrics
        .filter((m) => m.status === 'skipped')
        .map((m) => `${m.id}: ${m.reason}`)
        .join('\n')
      return { skipReason: logTail(reasons || 'no metric could be measured') }
    }
    return { result }
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
    return { skipReason: logTail(message) }
  } finally {
    await rm(parent, { recursive: true, force: true })
    await exec('git', ['-C', gitRoot, 'worktree', 'prune']).catch(() => {})
  }
}

/** The last ~10 lines — enough to see WHY without archiving the whole build log. */
function logTail(message: string): string {
  const lines = message.trimEnd().split('\n')
  return lines.slice(-10).join('\n')
}

function toBatchItem(commit: ReplayCommit, branch: string, result?: ResultJson, skipReason?: string): ReplayBatchItem {
  return {
    sha: commit.sha,
    branch,
    committedAt: commit.committedAt,
    parentSha: commit.parentSha,
    ...(result ? { result } : {}),
    ...(skipReason ? { skipReason } : {}),
    attemptedAt: result?.createdAt ?? new Date().toISOString(),
  }
}
