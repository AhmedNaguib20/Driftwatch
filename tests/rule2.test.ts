import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

import { recordRun, replayHistory, runDriftwatch } from '../src/core/index.js'

const exec = promisify(execFile)
const temps: string[] = []

afterEach(async () => {
  await Promise.all(temps.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

/**
 * Rule 2, enforced (spec §9a): driftwatch never writes to the user's working tree. The jinni
 * trial caught `run` creating perf.yml uninvited and never saying so — these tests are the
 * regression guard, phrased exactly as the user experiences it: `git status --porcelain`.
 */
async function project(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'driftwatch-rule2-'))
  temps.push(dir)
  const w = async (rel: string, c: string) => {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true })
    await writeFile(path.join(dir, rel), c, 'utf8')
  }
  const g = (...args: string[]) => exec('git', ['-C', dir, ...args])

  await g('init', '-q', '-b', 'main')
  await g('config', 'user.email', 't@t')
  await g('config', 'user.name', 't')
  await w('package.json', JSON.stringify({ name: 'p', scripts: { build: 'node build.js' } }))
  await w('next.config.mjs', 'export default {}\n')
  await w('app.js', "const payload = 'x'.repeat(100)\n")
  await w('build.js', "const fs=require('fs')\nfs.mkdirSync('.next/static',{recursive:true})\nfs.writeFileSync('.next/static/out.js',fs.readFileSync('app.js'))\n")
  await w('node_modules/pkg/index.js', 'x')
  // .perf/ is the ONE directory driftwatch may write in — ignored, as init would ignore it.
  await w('.gitignore', 'node_modules/\n.next/\n.perf/\n')
  await g('add', '-A')
  await g('commit', '-q', '-m', 'base')
  return dir
}

const status = async (dir: string) => (await exec('git', ['-C', dir, 'status', '--porcelain'])).stdout

describe('rule 2 — the user\'s tree is never written to', () => {
  it('run leaves git status --porcelain byte-identical (no perf.yml, no anything)', async () => {
    const dir = await project()
    const before = await status(dir)
    expect(before).toBe('')

    await runDriftwatch({ cwd: dir, serve: false, browser: false })

    expect(await status(dir)).toBe(before)
  }, 300_000)

  it('run on a project with no perf.yml says so instead of writing one', async () => {
    const dir = await project()
    const messages: string[] = []
    await runDriftwatch({ cwd: dir, serve: false, browser: false, progress: (m) => messages.push(m) })

    expect(messages.join('\n')).toContain('no perf.yml — using defaults')
    expect(await status(dir)).toBe('')
  }, 300_000)

  it('record leaves git status --porcelain unchanged', async () => {
    const dir = await project()
    await recordRun({ cwd: dir, serve: false, browser: false })
    expect(await status(dir)).toBe('')
  }, 300_000)

  it('replay leaves git status --porcelain unchanged', async () => {
    const dir = await project()
    await replayHistory({ cwd: dir, last: 5, serve: false, browser: false, writePerfData: true })
    expect(await status(dir)).toBe('')
  }, 300_000)
})

describe('rule 2 — the perf-data branch needs consent', () => {
  it('replay refuses to CREATE perf-data uninvited, and says exactly how to allow it', async () => {
    const dir = await project()
    const summary = await replayHistory({ cwd: dir, last: 5, serve: false, browser: false })

    expect(summary.measured).toBeGreaterThan(0) // the work happened…
    expect(summary.write.ok).toBe(false) // …but nothing was written to the repo
    expect(summary.write.detail).toMatch(/will not do that uninvited/)
    expect(summary.write.detail).toMatch(/--write-perf-data/)

    const branches = (await exec('git', ['-C', dir, 'branch', '--list', 'perf-data'])).stdout.trim()
    expect(branches).toBe('')
    expect(await status(dir)).toBe('')
  }, 300_000)

  it('with consent it creates the branch — and STILL does not touch the working tree', async () => {
    const dir = await project()
    const summary = await replayHistory({ cwd: dir, last: 5, serve: false, browser: false, writePerfData: true })

    expect(summary.write.ok).toBe(true)
    const branches = (await exec('git', ['-C', dir, 'branch', '--list', 'perf-data'])).stdout.trim()
    expect(branches).toContain('perf-data')
    expect(await status(dir)).toBe('')
  }, 300_000)
})
