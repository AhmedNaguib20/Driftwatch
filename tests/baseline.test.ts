import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

import {
  canonicalJson,
  createBaseWorkspace,
  detectProject,
  measureBaseSide,
  planBaseline,
  predictProtocol,
  protocolHash,
  readCachedSide,
  sweepStaleWorktrees,
  writeCachedSide,
} from '../src/core/index.js'
import type { BaselinePlan, MeasurementProtocol, SideMeasurement } from '../src/core/index.js'

const exec = promisify(execFile)
const temps: string[] = []

async function scratch(prefix = 'driftwatch-bl-'): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}

async function writeFileIn(dir: string, rel: string, contents = ''): Promise<void> {
  const target = path.join(dir, rel)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, contents, 'utf8')
}

async function git(dir: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-C', dir, ...args])
  return stdout.trim()
}

const EMPTY_LOCK = JSON.stringify({
  name: 'p',
  version: '1.0.0',
  lockfileVersion: 3,
  requires: true,
  packages: { '': { name: 'p', version: '1.0.0' } },
})

/**
 * A real repo with a main branch and a feature change on top, cheap enough to build in tests:
 * the "build" writes a file into .next so bundle_size has something to weigh.
 */
async function repoWithHistory(): Promise<string> {
  const dir = await scratch('driftwatch-repo-')
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  await git(dir, 'config', 'user.email', 't@driftwatch.dev')
  await git(dir, 'config', 'user.name', 'tests')
  // Framework signal comes from next.config.mjs, not a dependency — the empty lockfile must stay
  // consistent with package.json or `npm ci` (rightly) refuses to run.
  await writeFileIn(
    dir,
    'package.json',
    JSON.stringify({ name: 'p', version: '1.0.0', scripts: { build: 'node build.js' } }),
  )
  await writeFileIn(dir, 'next.config.mjs', 'export default {}\n')
  await writeFileIn(
    dir,
    'build.js',
    `const fs = require('fs')\nfs.mkdirSync('.next/static', { recursive: true })\nfs.writeFileSync('.next/static/app.js', 'x'.repeat(1000))\n`,
  )
  await writeFileIn(dir, 'package-lock.json', EMPTY_LOCK)
  await writeFileIn(dir, '.gitignore', 'node_modules/\n.next/\n.perf/\n')
  await writeFileIn(dir, 'src/index.js', 'module.exports = 1\n')
  await git(dir, 'add', '-A')
  await git(dir, 'commit', '-q', '-m', 'base')
  // A working-tree change on top of the committed base.
  await writeFileIn(dir, 'src/index.js', 'module.exports = 2\n')
  // Give the working tree a node_modules for the clone path.
  await writeFileIn(dir, 'node_modules/pkg/index.js', 'dep')
  return dir
}

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function fakeProtocol(overrides: Partial<MeasurementProtocol> = {}): MeasurementProtocol {
  return {
    version: 1,
    workspace: 'worktree',
    cacheState: 'cold',
    nodeModules: 'cloned',
    gitMetadata: 'absent',
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    buildCommand: 'npm run build',
    buildSamples: 3,
    warmupSamples: 1,
    routeSamples: 5,
    routeWarmupSamples: 1,
    browser: 'none',
    lighthouseProfile: 'none',
    hostLabels: [],
    env: { NEXT_TELEMETRY_DISABLED: '1' },
    ...overrides,
  }
}

function fakeSide(protocol: MeasurementProtocol): SideMeasurement {
  return {
    metrics: [
      {
        id: 'build_time',
        status: 'measured',
        value: 5000,
        unit: 'ms',
        label: 'build time (cold)',
        collectedBy: 'test',
        samples: 3,
        sampleValues: [5200, 5000, 4990],
      },
    ],
    protocol,
    warnings: [],
    elapsedMs: 1,
    layer2aElapsedMs: 0,
  }
}

describe('protocol hash — §5.1 third instance', () => {
  it('is stable for identical protocols regardless of field order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }))
    expect(protocolHash(fakeProtocol(), 'app')).toBe(protocolHash(fakeProtocol(), 'app'))
  })

  it('changes with the measured PROJECT — one commit holds many apps in a monorepo', () => {
    // Without this, `--app apps/admin` would read the entry `--app apps/web` wrote and
    // report one app's build time as the other's (rule 3). Found in the trial re-run.
    expect(protocolHash(fakeProtocol(), 'apps/web')).not.toBe(
      protocolHash(fakeProtocol(), 'apps/admin'),
    )
  })

  it('changes when the node version, arch, sample count, or install state changes', () => {
    // Derived from the host, never literal: the fixture takes `process.arch`, so hardcoding
    // 'x64' made this a no-op on an x64 runner while passing on the arm64 machine it was written
    // on. A test whose assertion evaporates on someone else's hardware is not a test there.
    const otherArch = process.arch === 'x64' ? 'arm64' : 'x64'
    const otherNode = process.version === 'v22.0.0' ? 'v18.0.0' : 'v22.0.0'

    const base = protocolHash(fakeProtocol(), 'app')
    expect(protocolHash(fakeProtocol({ nodeVersion: otherNode }), 'app')).not.toBe(base)
    expect(protocolHash(fakeProtocol({ arch: otherArch }), 'app')).not.toBe(base)
    expect(protocolHash(fakeProtocol({ buildSamples: 5 }), 'app')).not.toBe(base)
    expect(protocolHash(fakeProtocol({ nodeModules: 'fresh-install' }), 'app')).not.toBe(base)
  })

  it('does not change on mechanism details: cloned vs copied are the same install state', () => {
    expect(protocolHash(fakeProtocol({ nodeModules: 'copied' }), 'app')).toBe(
      protocolHash(fakeProtocol({ nodeModules: 'cloned' }), 'app'),
    )
  })

  it('ignores buildCommand — the SHA fixes it; full-protocol comparison still sees it', () => {
    expect(protocolHash(fakeProtocol({ buildCommand: 'pnpm run build' }), 'app')).toBe(
      protocolHash(fakeProtocol(), 'app'),
    )
  })
})

describe('baseline cache', () => {
  it('round-trips a side with its raw sampleValues intact', async () => {
    const root = await scratch()
    const side = fakeSide(fakeProtocol())
    const sha = 'a'.repeat(40)

    const { hash } = await writeCachedSide(root, sha, side, 'app')
    const entry = await readCachedSide(root, sha, hash)

    expect(entry).not.toBeNull()
    const metric = entry!.side.metrics[0]!
    expect(metric.status).toBe('measured')
    if (metric.status === 'measured') expect(metric.sampleValues).toEqual([5200, 5000, 4990])
  })

  it('misses on a different protocol hash — same SHA is not enough', async () => {
    const root = await scratch()
    const sha = 'a'.repeat(40)
    await writeCachedSide(root, sha, fakeSide(fakeProtocol()), 'app')

    const otherHash = protocolHash(fakeProtocol({ nodeVersion: 'v22.0.0' }), 'app')
    expect(await readCachedSide(root, sha, otherHash)).toBeNull()
  })

  it('treats a corrupt entry as a miss, not an error', async () => {
    const root = await scratch()
    const sha = 'a'.repeat(40)
    const hash = protocolHash(fakeProtocol(), 'app')
    await mkdir(path.join(root, '.perf', 'cache'), { recursive: true })
    await writeFile(path.join(root, '.perf', 'cache', `${sha}-${hash}.json`), '{torn', 'utf8')

    expect(await readCachedSide(root, sha, hash)).toBeNull()
  })

  it('keeps .perf out of version control without touching the user gitignore', async () => {
    const root = await scratch()
    await writeCachedSide(root, 'a'.repeat(40), fakeSide(fakeProtocol()), 'app')

    expect(await readFile(path.join(root, '.perf', '.gitignore'), 'utf8')).toBe('*\n')
  })
})

describe('planBaseline — the lockfile rule', () => {
  it('clones and skips install when the lockfile is identical', async () => {
    const dir = await repoWithHistory()
    const plan = await planBaseline(await detectProject({ cwd: dir }), 'main')

    expect(plan.available).toBe(true)
    if (plan.available) {
      expect(plan.lockfileStatus).toBe('identical')
      expect(plan.dependenciesChanged).toBe(false)
      expect(plan.dependencies).toBe('clone')
    }
  })

  it('installs on both sides and flags the change when the lockfile differs', async () => {
    const dir = await repoWithHistory()
    await writeFileIn(dir, 'package-lock.json', EMPTY_LOCK.replace('1.0.0', '1.0.1'))

    const plan = await planBaseline(await detectProject({ cwd: dir }), 'main')

    expect(plan.available).toBe(true)
    if (plan.available) {
      expect(plan.lockfileStatus).toBe('changed')
      expect(plan.dependenciesChanged).toBe(true)
      expect(plan.dependencies).toBe('install')
    }
  })

  it('reports unknown — not a guess — when there is no lockfile at all', async () => {
    const dir = await repoWithHistory()
    await rm(path.join(dir, 'package-lock.json'))
    await git(dir, 'add', '-A')
    await git(dir, 'commit', '-q', '-m', 'drop lockfile')

    const plan = await planBaseline(await detectProject({ cwd: dir }), 'main')

    expect(plan.available).toBe(true)
    if (plan.available) {
      expect(plan.lockfileStatus).toBe('missing')
      expect(plan.dependenciesChanged).toBeNull()
      expect(plan.dependencies).toBe('install')
      expect(plan.warnings.join('\n')).toMatch(/No lockfile/)
    }
  })

  it('falls back to install on both sides when lockfile is unchanged but node_modules is absent', async () => {
    const dir = await repoWithHistory()
    await rm(path.join(dir, 'node_modules'), { recursive: true })

    const plan = await planBaseline(await detectProject({ cwd: dir }), 'main')

    expect(plan.available).toBe(true)
    if (plan.available) {
      expect(plan.lockfileStatus).toBe('identical')
      expect(plan.dependencies).toBe('install')
      expect(plan.warnings.join('\n')).toMatch(/node_modules is absent/)
    }
  })

  it('degrades honestly on a ref that does not exist', async () => {
    const dir = await repoWithHistory()
    const plan = await planBaseline(await detectProject({ cwd: dir }), 'no-such-branch')

    expect(plan.available).toBe(false)
    if (!plan.available) expect(plan.reason).toMatch(/no-such-branch/)
  })

  it('degrades honestly outside a git repository', async () => {
    const dir = await scratch()
    await writeFileIn(dir, 'package.json', '{}')

    const plan = await planBaseline(await detectProject({ cwd: dir }), 'main')

    expect(plan.available).toBe(false)
    if (!plan.available) expect(plan.reason).toMatch(/git repository/)
  })
})

describe('base workspace — worktree lifecycle', () => {
  it('checks out base content, not the working tree, and carries no .git', async () => {
    const dir = await repoWithHistory()
    const sha = await git(dir, 'rev-parse', 'main')

    const ws = await createBaseWorkspace({
      gitRoot: dir,
      pathInRepo: '.',
      sha,
      dependencies: 'clone',
      sourceNodeModules: path.join(dir, 'node_modules'),
    })

    try {
      // Base content (module.exports = 1), not the working-tree edit (= 2).
      expect(await readFile(path.join(ws.dir, 'src/index.js'), 'utf8')).toContain('= 1')
      await expect(readFile(path.join(ws.dir, '.git'), 'utf8')).rejects.toThrow()
      expect(ws.kind).toBe('worktree')
      expect(['cloned', 'copied']).toContain(ws.nodeModules)
    } finally {
      await ws.cleanup()
    }
  })

  it('cleanup leaves no worktree registration behind', async () => {
    const dir = await repoWithHistory()
    const sha = await git(dir, 'rev-parse', 'main')

    const ws = await createBaseWorkspace({
      gitRoot: dir,
      pathInRepo: '.',
      sha,
      dependencies: 'install',
      sourceNodeModules: null,
    })
    await ws.cleanup()

    const list = await git(dir, 'worktree', 'list', '--porcelain')
    expect(list).not.toMatch(/driftwatch-base-/)
  })

  it('sweeps a leaked worktree whose owning process is dead', async () => {
    const dir = await repoWithHistory()
    const sha = await git(dir, 'rev-parse', 'main')

    // Simulate a crash: create a worktree, replace its owner with a dead pid, never clean up.
    const ws = await createBaseWorkspace({
      gitRoot: dir,
      pathInRepo: '.',
      sha,
      dependencies: 'install',
      sourceNodeModules: null,
    })
    const parent = path.dirname(ws.dir)
    await writeFile(
      path.join(parent, 'owner.json'),
      JSON.stringify({ pid: 999999999, startedAt: new Date().toISOString() }),
      'utf8',
    )

    const removed = await sweepStaleWorktrees(dir)

    expect(removed.length).toBe(1)
    expect(await git(dir, 'worktree', 'list', '--porcelain')).not.toMatch(/driftwatch-base-/)
    await expect(readFile(path.join(ws.dir, 'package.json'), 'utf8')).rejects.toThrow()
  })

  it('leaves a worktree owned by a live process alone', async () => {
    const dir = await repoWithHistory()
    const sha = await git(dir, 'rev-parse', 'main')

    const ws = await createBaseWorkspace({
      gitRoot: dir,
      pathInRepo: '.',
      sha,
      dependencies: 'install',
      sourceNodeModules: null,
    })

    try {
      const removed = await sweepStaleWorktrees(dir)
      expect(removed).toEqual([])
      expect(await readFile(path.join(ws.dir, 'package.json'), 'utf8')).toContain('"p"')
    } finally {
      await ws.cleanup()
    }
  })
})

describe('measureBaseSide — end to end on a tiny repo', () => {
  async function planFor(dir: string): Promise<{ profile: Awaited<ReturnType<typeof detectProject>>; plan: BaselinePlan }> {
    const profile = await detectProject({ cwd: dir })
    const plan = await planBaseline(profile, 'main')
    if (!plan.available) throw new Error(`plan unavailable: ${plan.reason}`)
    return { profile, plan }
  }

  it('measures the base through the same path and caches under (SHA, protocol hash)', async () => {
    const dir = await repoWithHistory()
    const { profile, plan } = await planFor(dir)

    const first = await measureBaseSide(profile, plan)

    expect(first.fromCache).toBe(false)
    expect(first.cachePath).toContain(path.join('.perf', 'cache', plan.baseSha))
    const build = first.side.metrics.find((m) => m.id === 'build_time')
    expect(build?.status).toBe('measured')
    expect(first.side.protocol.workspace).toBe('worktree')
    expect(first.side.protocol.cacheState).toBe('cold')

    const second = await measureBaseSide(profile, plan)
    expect(second.fromCache).toBe(true)
    expect(second.side.metrics).toEqual(first.side.metrics)
    expect(second.measuredAt).not.toBeNull()
  })

  it('skips install with the lockfile reason when dependencies are unchanged', async () => {
    const dir = await repoWithHistory()
    const { profile, plan } = await planFor(dir)

    const result = await measureBaseSide(profile, plan)
    const install = result.side.metrics.find((m) => m.id === 'install_time')

    expect(install?.status).toBe('skipped')
    if (install?.status === 'skipped') expect(install.reason).toMatch(/provided by cloning/)
  })

  it('measures install time on the base when the lockfile changed', async () => {
    const dir = await repoWithHistory()
    await writeFileIn(dir, 'package-lock.json', EMPTY_LOCK.replace('1.0.0', '1.0.1'))
    const { profile, plan } = await planFor(dir)

    const result = await measureBaseSide(profile, plan)
    const install = result.side.metrics.find((m) => m.id === 'install_time')

    expect(plan.dependenciesChanged).toBe(true)
    expect(install?.status).toBe('measured')
    if (install?.status === 'measured') {
      expect(install.unit).toBe('ms')
      expect(install.collectedBy).toMatch(/npm ci/)
    }
    expect(result.side.protocol.nodeModules).toBe('fresh-install')
  })

  it('does not cache a base whose build failed — a transient failure must not become the truth', async () => {
    const dir = await repoWithHistory()
    await writeFileIn(dir, 'build.js', 'process.exit(7)\n')
    await git(dir, 'add', 'build.js')
    await git(dir, 'commit', '-q', '-m', 'broken build')
    const { profile, plan } = await planFor(dir)

    const result = await measureBaseSide(profile, plan)

    const build = result.side.metrics.find((m) => m.id === 'build_time')
    expect(build?.status).toBe('skipped')
    if (build?.status === 'skipped') expect(build.reason).toMatch(/code 7/)
    expect(result.cachePath).toBeNull()

    const again = await measureBaseSide(profile, plan)
    expect(again.fromCache).toBe(false)
  })

  it('never modifies the user working tree, and leaves no worktree behind', async () => {
    const dir = await repoWithHistory()
    const { profile, plan } = await planFor(dir)
    const before = await git(dir, 'status', '--porcelain')

    await measureBaseSide(profile, plan)

    expect(await git(dir, 'status', '--porcelain')).toBe(before)
    expect(await git(dir, 'worktree', 'list', '--porcelain')).not.toMatch(/driftwatch-base-/)
    // The working-tree edit is still there, untouched.
    expect(await readFile(path.join(dir, 'src/index.js'), 'utf8')).toContain('= 2')
  })

  it('predictProtocol matches the protocol the measurement actually produces (cache hit by construction)', async () => {
    const dir = await repoWithHistory()
    const { profile, plan } = await planFor(dir)

    const predicted = protocolHash(predictProtocol(plan), profile.pathInRepo ?? '.')
    const result = await measureBaseSide(profile, plan)

    expect(protocolHash(result.side.protocol, profile.pathInRepo ?? '.')).toBe(predicted)
  })
})

describe('cache prediction parity with browser metrics', () => {
  it('predictProtocol with browser fields hashes identically to a measured protocol carrying them', () => {
    const plan: BaselinePlan = {
      available: true, baseRef: 'main', baseSha: 'a'.repeat(40), lockfileStatus: 'identical',
      dependenciesChanged: false, dependencies: 'clone', commitsAhead: 1, baseAgeDays: 0, likelyIntegrationTarget: null, warnings: [], evidence: [],
    }
    const predicted = predictProtocol(plan, 'chrome/151.0.1', 'simulated/desktop/v2')
    const measuredLike = { ...predicted, workspace: 'copy' as const, buildCommand: 'npm run build' }
    expect(protocolHash(measuredLike, 'app')).toBe(protocolHash(predicted, 'app'))
    // and a browser difference DOES change the hash — chrome upgrades strand caches
    expect(protocolHash(predictProtocol(plan, 'chrome/152.0.0', 'simulated/desktop/v2'), 'app')).not.toBe(
      protocolHash(predicted, 'app'),
    )
  })
})
