import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

import {
  detectProject,
  planBaseline,
  measureBaseSide,
  protocolHash,
  requiresConfirmation,
  runDriftwatch,
  cachePath,
} from '../src/core/index.js'
import type { MetricComparison, ResultJson } from '../src/core/index.js'

const exec = promisify(execFile)
const temps: string[] = []

async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'driftwatch-esc-'))
  temps.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function writeFileIn(dir: string, rel: string, contents = ''): Promise<void> {
  const target = path.join(dir, rel)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, contents, 'utf8')
}

async function git(dir: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-C', dir, ...args])
  return stdout.trim()
}

/** Tiny buildable repo — same shape as the baseline tests. */
async function repo(): Promise<string> {
  const dir = await scratch()
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  await git(dir, 'config', 'user.email', 't@t')
  await git(dir, 'config', 'user.name', 't')
  await writeFileIn(dir, 'package.json', JSON.stringify({ name: 'p', version: '1.0.0', scripts: { build: 'node build.js' } }))
  await writeFileIn(dir, 'next.config.mjs', 'export default {}\n')
  // Sleep-based duration: wall-clock stays ~300ms even when parallel test workers saturate the
  // CPU — a pure-write build jitters past the 100ms quantum under suite load.
  await writeFileIn(
    dir,
    'build.js',
    `const fs = require('fs')\nfs.mkdirSync('.next/static', { recursive: true })\nfs.writeFileSync('.next/static/app.js', 'x'.repeat(1000))\nsetTimeout(() => {}, 300)\n`,
  )
  await writeFileIn(dir, 'package-lock.json', JSON.stringify({ name: 'p', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'p', version: '1.0.0' } } }))
  await writeFileIn(dir, '.gitignore', 'node_modules/\n.next/\n.perf/\n')
  await git(dir, 'add', '-A')
  await git(dir, 'commit', '-q', '-m', 'base')
  await writeFileIn(dir, 'node_modules/pkg/index.js', 'dep')
  return dir
}

function metricRow(result: ResultJson, id: string): MetricComparison {
  return result.comparison.metrics.find((m) => m.id === id)!
}

describe('requiresConfirmation', () => {
  function fakeResult(metrics: Partial<MetricComparison>[]): ResultJson {
    return { comparison: { metrics } } as unknown as ResultJson
  }

  it('fires on a floor-crossing time metric, in either direction', () => {
    expect(requiresConfirmation(fakeResult([{ unit: 'ms', verdict: 'regressed' }]))).toBe(true)
    expect(requiresConfirmation(fakeResult([{ unit: 'ms', verdict: 'improved' }]))).toBe(true)
  })

  it('never fires on bundle size — bytes do not drift', () => {
    expect(requiresConfirmation(fakeResult([{ unit: 'bytes', verdict: 'regressed' }]))).toBe(false)
  })

  it('never fires on no_change, skipped, or not_comparable — nothing to confirm', () => {
    expect(
      requiresConfirmation(
        fakeResult([
          { unit: 'ms', verdict: 'no_change' },
          { unit: 'ms', verdict: 'skipped' },
          { unit: 'ms', verdict: 'not_comparable' },
        ]),
      ),
    ).toBe(false)
  })
})

describe('the screening → confirm path, end to end', () => {
  it('first run is fresh, second run screens from cache', async () => {
    const dir = await repo()

    const first = await runDriftwatch({ cwd: dir })
    expect(first.comparison.measurementPath).toBe('fresh')
    expect(first.base.available && first.base.fromCache).toBe(false)

    const second = await runDriftwatch({ cwd: dir })
    expect(second.comparison.measurementPath).toBe('screened')
    expect(second.base.available && second.base.fromCache).toBe(true)
    expect(second.verdict).toBe('ok')
  })

  it('a poisoned cached median escalates, confirms fresh, and replaces the cache entry', async () => {
    const dir = await repo()
    const profile = await detectProject({ cwd: dir })
    const plan = await planBaseline(profile, 'main')
    if (!plan.available) throw new Error('plan unavailable')

    // Seed the cache with a real measurement, then poison its build median far past both noise
    // floors — simulating a base measured under heavy machine load half an hour ago.
    await measureBaseSide(profile, plan)
    const file = cachePath(
      profile.gitRoot!,
      plan.baseSha,
      protocolHash((await measureBaseSide(profile, plan)).side.protocol),
    )
    const entry = JSON.parse(await readFile(file, 'utf8'))
    const build = entry.side.metrics.find((m: { id: string }) => m.id === 'build_time')
    const poisoned = build.value * 2 + 1000 // comfortably past the 2% and 100ms floors
    build.value = poisoned
    build.sampleValues = [poisoned + 100, poisoned, poisoned - 100]
    await writeFile(file, JSON.stringify(entry), 'utf8')

    const progress: string[] = []
    const result = await runDriftwatch({ cwd: dir, progress: (m) => progress.push(m) })

    // The poisoned delta was screened, crossed the floor, and was re-measured — the reported
    // result is the confirmed one and shows no change (the code did not change).
    expect(progress.join('\n')).toMatch(/re-measuring both sides fresh to confirm/)
    expect(result.comparison.measurementPath).toBe('confirmed')
    expect(result.base.available && result.base.fromCache).toBe(false)
    expect(metricRow(result, 'build_time').verdict).toBe('no_change')
    expect(result.verdict).toBe('ok')

    // The poisoned entry was replaced by the confirming measurement.
    const replaced = JSON.parse(await readFile(file, 'utf8'))
    const replacedBuild = replaced.side.metrics.find((m: { id: string }) => m.id === 'build_time')
    expect(replacedBuild.value).not.toBe(poisoned)
  }, 120_000)

  it('records warm-up in the protocol and keeps it out of the samples', async () => {
    const dir = await repo()
    const result = await runDriftwatch({ cwd: dir })

    expect(result.current.protocol.warmupSamples).toBe(1)
    const build = result.current.metrics.find((m) => m.id === 'build_time')
    expect(build?.status).toBe('measured')
    if (build?.status === 'measured') {
      expect(build.samples).toBe(3)
      expect(build.sampleValues).toHaveLength(3)
      expect(build.collectedBy).toMatch(/after 1 discarded warm-up/)
    }
  })
})
