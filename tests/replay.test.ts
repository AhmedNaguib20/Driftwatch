import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

import {
  buildTimelines,
  describeEstimate,
  estimate,
  readPerfDataIndex,
  replayHistory,
  resolveReplayCommits,
  savePending,
} from '../src/core/index.js'
import type { ResultJson } from '../src/core/index.js'

const exec = promisify(execFile)
const temps: string[] = []

afterEach(async () => {
  await Promise.all(temps.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

/**
 * A real tiny git repo whose "build" copies app.js into .next/static — the same shape the verify
 * tests use, but with node_modules COMMITTED so replay worktrees measure without installing.
 * History (all on main except the feature branch):
 *   c1 root → c2 (app grows; via feature-branch MERGE — first-parent must keep the merge, skip
 *   the branch commit) → c3 (build broken) → c4 (fixed, app shrinks back)
 */
async function repo(): Promise<{
  dir: string
  shas: { c1: string; fb: string; c2: string; c3: string; c4: string }
}> {
  const dir = await mkdtemp(path.join(tmpdir(), 'driftwatch-replay-'))
  temps.push(dir)
  const w = async (rel: string, c: string) => {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true })
    await writeFile(path.join(dir, rel), c, 'utf8')
  }
  const g = (...args: string[]) => exec('git', ['-C', dir, ...args])
  const sha = async () => (await g('rev-parse', 'HEAD')).stdout.trim()

  await g('init', '-q', '-b', 'main')
  await g('config', 'user.email', 't@t')
  await g('config', 'user.name', 't')
  await w('package.json', JSON.stringify({ name: 'p', scripts: { build: 'node build.js' } }))
  await w('next.config.mjs', 'export default {}\n')
  await w('app.js', "const payload = 'x'.repeat(100)\n")
  await w('build.js', "const fs=require('fs')\nfs.mkdirSync('.next/static',{recursive:true})\nfs.writeFileSync('.next/static/out.js',fs.readFileSync('app.js'))\n")
  await w('node_modules/pkg/index.js', 'x')
  await w('.gitignore', '.next/\n.perf/\nperf.yml\n')
  await g('add', '-A')
  await g('commit', '-q', '-m', 'c1: base')
  const c1 = await sha()

  // c2 lands via a merge so first-parent resolution has something to prove.
  await g('checkout', '-q', '-b', 'feature')
  await w('app.js', "const payload = 'x'.repeat(5000)\n")
  await g('add', '-A')
  await g('commit', '-q', '-m', 'fb: grow the app')
  const fb = await sha()
  await g('checkout', '-q', 'main')
  await g('merge', '-q', '--no-ff', '-m', 'c2: merge feature', 'feature')
  const c2 = await sha()

  await w('build.js', "console.error('kaboom: this historical commit does not build')\nprocess.exit(1)\n")
  await g('add', '-A')
  await g('commit', '-q', '-m', 'c3: broken build')
  const c3 = await sha()

  await w('build.js', "const fs=require('fs')\nfs.mkdirSync('.next/static',{recursive:true})\nfs.writeFileSync('.next/static/out.js',fs.readFileSync('app.js'))\n")
  await w('app.js', "const payload = 'x'.repeat(200)\n")
  await g('add', '-A')
  await g('commit', '-q', '-m', 'c4: fixed again')
  const c4 = await sha()

  return { dir, shas: { c1, fb, c2, c3, c4 } }
}

function fakeResult(sha: string): ResultJson {
  return {
    schemaVersion: 1,
    driftwatchVersion: '0.0.0-test',
    mode: 'record',
    createdAt: '2026-08-19T00:00:00.000Z',
    current: {
      metrics: [
        { id: 'bundle_size', status: 'measured', value: 100, unit: 'bytes', label: 'bundle size', collectedBy: 't', samples: 1 },
      ],
      protocol: { nodeVersion: 'v0', platform: 'test', arch: 'test', browser: 'none', hostLabels: [], driftwatchVersion: '0.0.0-test' },
      benchmarkIndex: null,
    },
    project: { root: `/x/${sha.slice(0, 4)}` },
  } as unknown as ResultJson
}

describe('resolveReplayCommits — first-parent mainline', () => {
  it('walks the default branch oldest-first, keeping merges and skipping branch commits', async () => {
    const { dir, shas } = await repo()
    const plan = await resolveReplayCommits(dir, { last: 10 })

    expect(plan.branch).toBe('main')
    expect(plan.commits.map((c) => c.sha)).toEqual([shas.c1, shas.c2, shas.c3, shas.c4])
    expect(plan.commits.map((c) => c.sha)).not.toContain(shas.fb)
    // Topology fields feed the index: root has no parent; the mainline chains first-parent.
    expect(plan.commits[0]!.parentSha).toBeNull()
    expect(plan.commits[1]!.parentSha).toBe(shas.c1)
    expect(plan.commits[0]!.committedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('--since replays only commits after the ref; an unknown ref is a hard error', async () => {
    const { dir, shas } = await repo()
    const plan = await resolveReplayCommits(dir, { since: shas.c2 })
    expect(plan.commits.map((c) => c.sha)).toEqual([shas.c3, shas.c4])
    await expect(resolveReplayCommits(dir, { since: 'no-such-ref' })).rejects.toThrow(/does not resolve/)
  })
})

describe('replayHistory — the real loop (measure, skip, batch, one segment)', () => {
  it('measures history, marks the broken commit skipped, continues, writes ONE batch', async () => {
    const { dir, shas } = await repo()
    const confirmations: string[] = []

    const summary = await replayHistory({
      cwd: dir,
      last: 10,
      serve: false,
      browser: false,
      confirm: async (description) => {
        confirmations.push(description)
        return true
      },
    })

    // Estimate was shown BEFORE work; no record run existed, and it said so honestly.
    expect(confirmations).toHaveLength(1)
    expect(confirmations[0]).toMatch(/4 commit\(s\)/)
    expect(confirmations[0]).toMatch(/no record run has been measured/)

    expect(summary.planned).toBe(4)
    expect(summary.measured).toBe(3)
    expect(summary.skipped).toHaveLength(1)
    expect(summary.skipped[0]!.sha).toBe(shas.c3)
    expect(summary.skipped[0]!.reason).toMatch(/build/)
    expect(summary.write).toEqual({ ok: true, detail: 'written' })

    // The batch landed in perf-data (local branch, no remote): 4 entries, honest shapes.
    const read = await readPerfDataIndex(dir, { fetch: false })
    if ('unavailable' in read) throw new Error(read.unavailable)
    const entries = read.index.entries
    expect(entries).toHaveLength(4)
    expect(entries.every((e) => e.replayed === true)).toBe(true)
    expect(entries.every((e) => typeof e.committedAt === 'string')).toBe(true)
    const skippedEntry = entries.find((e) => e.sha === shas.c3)!
    expect(skippedEntry.skipped?.reason).toMatch(/build/)
    expect(Object.keys(skippedEntry.metrics)).toHaveLength(0)

    // ONE segment by construction: all measured points share today's protocol, ordered by
    // topology (c1 → c2 merge → c4), with the skipped commit contributing no point and no break.
    const timeline = buildTimelines(read.index).find((t) => t.id === 'bundle_size')!
    expect(timeline.segments).toHaveLength(1)
    expect(timeline.segments[0]!.points.map((p) => p.sha)).toEqual([shas.c1, shas.c2, shas.c4])
    // The measurement itself is real: c2 grew the app, c4 shrank it back.
    const values = timeline.segments[0]!.points.map((p) => p.value)
    expect(values[1]!).toBeGreaterThan(values[0]!)
    expect(values[2]!).toBeLessThan(values[1]!)
  }, 300_000)

  it('dedup: a second replay measures nothing — every commit is already recorded', async () => {
    const { dir } = await repo()
    await replayHistory({ cwd: dir, last: 10, serve: false, browser: false })

    let calls = 0
    const summary = await replayHistory({
      cwd: dir,
      last: 10,
      serve: false,
      browser: false,
      recordFn: async () => {
        calls += 1
        throw new Error('must not be called')
      },
    })
    expect(calls).toBe(0)
    expect(summary.alreadyRecorded).toBe(4)
    expect(summary.measured).toBe(0)
    expect(summary.write.detail).toBe('nothing to do')
  }, 300_000)

  it('resume: a pending result from an interrupted run is used without re-measuring', async () => {
    const { dir, shas } = await repo()
    // The interrupt: c1 was measured and saved, then the process died.
    await savePending(dir, { sha: shas.c1, result: fakeResult(shas.c1) })

    const measuredShas: string[] = []
    const summary = await replayHistory({
      cwd: dir,
      last: 10,
      serve: false,
      browser: false,
      recordFn: async (options) => {
        const cwd = options?.cwd
        if (!cwd) throw new Error('replay must pass the worktree cwd')
        const sha = (await exec('git', ['-C', cwd, 'rev-parse', 'HEAD'])).stdout.trim()
        measuredShas.push(sha)
        return fakeResult(sha)
      },
    })

    expect(summary.resumed).toBe(1)
    expect(summary.measured).toBe(3)
    expect(measuredShas).not.toContain(shas.c1) // never re-measured
    expect(measuredShas).toEqual([shas.c2, shas.c3, shas.c4])

    const read = await readPerfDataIndex(dir, { fetch: false })
    if ('unavailable' in read) throw new Error(read.unavailable)
    expect(read.index.entries.map((e) => e.sha).sort()).toEqual(
      [shas.c1, shas.c2, shas.c3, shas.c4].sort(),
    )
  }, 300_000)

  it('a declined confirmation measures nothing and writes nothing', async () => {
    const { dir } = await repo()
    let calls = 0
    const summary = await replayHistory({
      cwd: dir,
      last: 10,
      serve: false,
      browser: false,
      confirm: async () => false,
      recordFn: async () => {
        calls += 1
        throw new Error('must not be called')
      },
    })
    expect(calls).toBe(0)
    expect(summary.measured).toBe(0)
    expect(summary.write.detail).toBe('declined')
    const read = await readPerfDataIndex(dir, { fetch: false })
    expect('unavailable' in read).toBe(true)
  })
})

describe('the estimate line', () => {
  it('is measured or honestly unknown — never a guessed number', () => {
    expect(describeEstimate(estimate(12, 45))).toBe(
      "12 commit(s) × ~45s (measured from your machine's last record run) ≈ 9 minute(s)",
    )
    expect(describeEstimate(estimate(200, 50))).toMatch(/≈ 2\.8 hours/)
    expect(describeEstimate(estimate(5, null))).toMatch(/unknown duration.*first commit will calibrate/)
  })
})
