import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

import {
  PERF_DATA_BRANCH,
  appendToPerfData,
  emptyIndex,
  entryFromResult,
  appendEntry,
  parseIndex,
} from '../src/core/index.js'
import type { ResultJson } from '../src/core/index.js'

const exec = promisify(execFile)
const temps: string[] = []

async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'driftwatch-trend-'))
  temps.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(temps.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-C', cwd, ...args])
  return stdout.trim()
}

/** A working repo with a bare origin — the CI shape. */
async function repoWithOrigin(): Promise<{ work: string; bare: string }> {
  const bare = await scratch()
  await exec('git', ['init', '-q', '--bare', bare])
  const work = await scratch()
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: work })
  await git(work, 'config', 'user.email', 't@t')
  await git(work, 'config', 'user.name', 't')
  await writeFile(path.join(work, 'README.md'), 'x', 'utf8')
  await git(work, 'add', '-A')
  await git(work, 'commit', '-q', '-m', 'init')
  await git(work, 'remote', 'add', 'origin', bare)
  await git(work, 'push', '-q', 'origin', 'main')
  return { work, bare }
}

async function recordResult(sha: string): Promise<ResultJson> {
  const raw = await readFile(path.join(import.meta.dirname, 'golden', 'result-v1.1.json'), 'utf8')
  const base = JSON.parse(raw.replaceAll('<driftwatch-version>', '0.5.0')) as ResultJson
  return { ...base, mode: 'record', verdict: 'recorded', createdAt: `2026-08-19T12:00:00.000Z` }
}

async function readBranchFile(repo: string, file: string): Promise<string> {
  return git(repo, 'show', `${PERF_DATA_BRANCH}:${file}`)
}

describe('perf-data store', () => {
  it('creates the orphan branch, writes the result and index, pushes', async () => {
    const { work, bare } = await repoWithOrigin()
    const sha = 'a'.repeat(40)

    const outcome = await appendToPerfData(work, await recordResult(sha), sha, 'main', true)

    expect(outcome).toEqual({ ok: true, detail: 'appended' })
    // Orphan: no shared history with main (seed commit + record commit, nothing else).
    await expect(git(work, 'merge-base', PERF_DATA_BRANCH, 'main')).rejects.toThrow()
    expect(await git(work, 'rev-list', '--count', PERF_DATA_BRANCH)).toBe('2')
    const index = parseIndex(await readBranchFile(work, 'index.json'))!
    expect(index.entries).toHaveLength(1)
    expect(index.entries[0]!.shortSha).toBe('a'.repeat(12))
    expect(index.entries[0]!.protocol.nodeVersion).toBe('v20.20.0')
    // Pushed to origin too.
    expect(await git(bare, 'rev-parse', `refs/heads/${PERF_DATA_BRANCH}`)).toBeTruthy()
    // And main was never touched.
    expect(await git(work, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
  })

  it('appends to an existing branch and keeps prior entries', async () => {
    const { work } = await repoWithOrigin()
    await appendToPerfData(work, await recordResult('a'.repeat(40)), 'a'.repeat(40), 'main', true)

    const outcome = await appendToPerfData(work, await recordResult('b'.repeat(40)), 'b'.repeat(40), 'main', true)

    expect(outcome.ok).toBe(true)
    const index = parseIndex(await readBranchFile(work, 'index.json'))!
    expect(index.entries.map((e) => e.shortSha)).toEqual(['a'.repeat(12), 'b'.repeat(12)])
    expect(await readBranchFile(work, `results/${'b'.repeat(12)}.json`)).toContain('"mode": "record"')
  })

  it('re-recording the same sha replaces its entry instead of duplicating', async () => {
    const { work } = await repoWithOrigin()
    const sha = 'a'.repeat(40)
    await appendToPerfData(work, await recordResult(sha), sha, 'main', true)
    await appendToPerfData(work, await recordResult(sha), sha, 'main', true)

    const index = parseIndex(await readBranchFile(work, 'index.json'))!
    expect(index.entries).toHaveLength(1)
  })

  it('REFUSES a perf-data branch that is not ours — never overwrites', async () => {
    const { work } = await repoWithOrigin()
    // Someone's unrelated perf-data branch.
    await git(work, 'checkout', '-q', '--orphan', PERF_DATA_BRANCH)
    await writeFile(path.join(work, 'index.json'), '{"someone":"else"}', 'utf8')
    await git(work, 'add', '-A')
    await git(work, 'commit', '-q', '-m', 'theirs')
    const theirCommit = await git(work, 'rev-parse', PERF_DATA_BRANCH)
    await git(work, 'checkout', '-q', 'main')

    const outcome = await appendToPerfData(work, await recordResult('a'.repeat(40)), 'a'.repeat(40), 'main', false)

    expect(outcome.ok).toBe(false)
    expect(outcome.detail).toMatch(/not driftwatch's — refusing/)
    expect(await git(work, 'rev-parse', PERF_DATA_BRANCH)).toBe(theirCommit) // untouched
  })

  it('a stale local ref is refreshed by the pre-push fetch — the common race is serialized', async () => {
    const { work, bare } = await repoWithOrigin()
    await appendToPerfData(work, await recordResult('a'.repeat(40)), 'a'.repeat(40), 'main', true)

    // A second clone appends and pushes first; our local ref is now stale.
    const other = await scratch()
    await exec('git', ['clone', '-q', bare, other])
    await git(other, 'config', 'user.email', 'o@o')
    await git(other, 'config', 'user.name', 'other')
    expect((await appendToPerfData(other, await recordResult('b'.repeat(40)), 'b'.repeat(40), 'main', true)).ok).toBe(true)

    const outcome = await appendToPerfData(work, await recordResult('c'.repeat(40)), 'c'.repeat(40), 'main', true)

    expect(outcome.ok).toBe(true) // fetch picked up B before building — no rejection needed
    const index = parseIndex(await git(bare, 'show', `${PERF_DATA_BRANCH}:index.json`))!
    expect(index.entries.map((e) => e.shortSha).sort()).toEqual([
      'a'.repeat(12),
      'b'.repeat(12),
      'c'.repeat(12),
    ]) // nothing lost
  })

  it('retries once after a genuinely rejected push (race lost between fetch and push)', async () => {
    const { work, bare } = await repoWithOrigin()
    await appendToPerfData(work, await recordResult('a'.repeat(40)), 'a'.repeat(40), 'main', true)

    // One-shot rejection hook: the first push is refused (simulating losing the race in the
    // fetch→push window), every later push passes.
    const hook = path.join(bare, 'hooks', 'pre-receive')
    const flag = path.join(bare, 'reject-once')
    await writeFile(flag, '', 'utf8')
    await mkdir(path.dirname(hook), { recursive: true })
    await writeFile(hook, `#!/bin/sh
if [ -f "${flag}" ]; then rm "${flag}"; echo "simulated race loss" >&2; exit 1; fi
exit 0
`, 'utf8')
    await exec('chmod', ['+x', hook])

    const outcome = await appendToPerfData(work, await recordResult('c'.repeat(40)), 'c'.repeat(40), 'main', true)

    expect(outcome.ok).toBe(true)
    expect(outcome.detail).toBe('appended-after-retry')
    const index = parseIndex(await git(bare, 'show', `${PERF_DATA_BRANCH}:index.json`))!
    expect(index.entries.map((e) => e.shortSha).sort()).toEqual(['a'.repeat(12), 'c'.repeat(12)])
  })

  it('gives up with a warning when the push is rejected twice — a missing point over a corrupted index', async () => {
    const { work, bare } = await repoWithOrigin()
    await appendToPerfData(work, await recordResult('a'.repeat(40)), 'a'.repeat(40), 'main', true)

    const hook = path.join(bare, 'hooks', 'pre-receive')
    await mkdir(path.dirname(hook), { recursive: true })
    await writeFile(hook, ['#!/bin/sh', 'echo "always rejected" >&2', 'exit 1', ''].join('\n'), 'utf8')
    await exec('chmod', ['+x', hook])

    const outcome = await appendToPerfData(work, await recordResult('c'.repeat(40)), 'c'.repeat(40), 'main', true)

    expect(outcome.ok).toBe(false)
    expect(outcome.detail).toMatch(/rejected twice.*missing point is recoverable/)
  })

  it('works without a remote (local-only repos): commits the branch, skips the push', async () => {
    const work = await scratch()
    await exec('git', ['init', '-q', '-b', 'main'], { cwd: work })
    await git(work, 'config', 'user.email', 't@t')
    await git(work, 'config', 'user.name', 't')
    await writeFile(path.join(work, 'a.txt'), 'x', 'utf8')
    await git(work, 'add', '-A')
    await git(work, 'commit', '-q', '-m', 'init')

    const outcome = await appendToPerfData(work, await recordResult('a'.repeat(40)), 'a'.repeat(40), 'main', true)

    expect(outcome.ok).toBe(true)
    expect(parseIndex(await readBranchFile(work, 'index.json'))).not.toBeNull()
  })
})

describe('index file', () => {
  it('round-trips and rejects foreign json', () => {
    const index = appendEntry(emptyIndex(), {
      sha: 'a'.repeat(40), shortSha: 'a'.repeat(12), timestamp: 't', branch: 'main',
      metrics: { build_time: { value: 9000, unit: 'ms' } },
      protocol: { nodeVersion: 'v20', platform: 'darwin', arch: 'arm64', browser: 'none', hostLabels: [], driftwatchVersion: '0.5.0' },
    })
    expect(parseIndex(JSON.stringify(index))).toEqual(index)
    expect(parseIndex('{"someone":"else"}')).toBeNull()
    expect(parseIndex('not json')).toBeNull()
  })
})
