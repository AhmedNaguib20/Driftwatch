import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

import {
  collectBuildTime,
  collectBundleSize,
  createWorkingTreeWorkspace,
  detectProject,
  measureWorkspace,
  runCommand,
} from '../src/core/index.js'
import type { ProjectProfile, Workspace } from '../src/core/index.js'

const exec = promisify(execFile)
const temps: string[] = []

async function scratch(prefix = 'driftwatch-measure-'): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}

async function writeFileIn(dir: string, rel: string, contents = ''): Promise<void> {
  const target = path.join(dir, rel)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, contents, 'utf8')
}

/** A tiny real git repo that looks enough like a project to detect. */
async function gitProject(): Promise<string> {
  const dir = await scratch('driftwatch-repo-')
  await exec('git', ['init', '-q'], { cwd: dir })
  await exec('git', ['config', 'user.email', 'test@driftwatch.dev'], { cwd: dir })
  await exec('git', ['config', 'user.name', 'driftwatch tests'], { cwd: dir })
  await writeFileIn(dir, 'package.json', JSON.stringify({ name: 'p', scripts: { build: 'true' } }))
  await writeFileIn(dir, '.gitignore', 'node_modules/\n.next/\nsecret.txt\n')
  await writeFileIn(dir, 'src/index.ts', 'export const a = 1\n')
  await exec('git', ['add', '-A'], { cwd: dir })
  await exec('git', ['commit', '-q', '-m', 'init'], { cwd: dir })
  return dir
}

const cleanups: Workspace[] = []

async function workspaceFor(profile: ProjectProfile): Promise<Workspace> {
  const ws = await createWorkingTreeWorkspace(profile)
  cleanups.push(ws)
  return ws
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((ws) => ws.cleanup()))
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('working-tree workspace: fidelity', () => {
  it('includes uncommitted and untracked-but-not-ignored files', async () => {
    const dir = await gitProject()
    await writeFileIn(dir, 'src/uncommitted.ts', 'export const b = 2\n') // untracked
    await writeFileIn(dir, 'src/index.ts', 'export const a = 999\n') // modified, unstaged

    const ws = await workspaceFor(await detectProject({ cwd: dir }))

    expect(await readFile(path.join(ws.dir, 'src/uncommitted.ts'), 'utf8')).toContain('b = 2')
    expect(await readFile(path.join(ws.dir, 'src/index.ts'), 'utf8')).toContain('a = 999')
    expect(ws.copiedBy).toContain('git ls-files')
  })

  it('excludes ignored files, .git, and build caches', async () => {
    const dir = await gitProject()
    await writeFileIn(dir, 'secret.txt', 'ignored')
    await writeFileIn(dir, '.next/stale-cache.js', 'old build')
    await writeFileIn(dir, 'node_modules/left/index.js', 'x')

    const profile = await detectProject({ cwd: dir })
    const ws = await workspaceFor(profile)

    for (const absent of ['secret.txt', '.git', '.next/stale-cache.js']) {
      await expect(stat(path.join(ws.dir, absent))).rejects.toThrow()
    }
  })

  it('omits files deleted from disk but still in the index — that IS the working tree state', async () => {
    const dir = await gitProject()
    await rm(path.join(dir, 'src/index.ts'))

    const ws = await workspaceFor(await detectProject({ cwd: dir }))

    await expect(stat(path.join(ws.dir, 'src/index.ts'))).rejects.toThrow()
  })

  it('isolates node_modules: writes in the workspace never reach the real tree', async () => {
    const dir = await gitProject()
    await writeFileIn(dir, 'node_modules/pkg/index.js', 'original')

    const ws = await workspaceFor(await detectProject({ cwd: dir }))
    expect(['cloned', 'copied']).toContain(ws.nodeModules)

    // Mutate the workspace copy the way a build cache write would.
    await writeFileIn(ws.dir, 'node_modules/.cache/build.json', '{"poison": true}')
    await writeFile(path.join(ws.dir, 'node_modules/pkg/index.js'), 'mutated', 'utf8')

    await expect(stat(path.join(dir, 'node_modules/.cache'))).rejects.toThrow()
    expect(await readFile(path.join(dir, 'node_modules/pkg/index.js'), 'utf8')).toBe('original')
  })

  it('never modifies the working directory at all', async () => {
    const dir = await gitProject()
    await writeFileIn(dir, 'src/wip.ts', 'work in progress')
    const before = (await exec('git', ['status', '--porcelain'], { cwd: dir })).stdout

    const ws = await workspaceFor(await detectProject({ cwd: dir }))
    await ws.cleanup()

    const after = (await exec('git', ['status', '--porcelain'], { cwd: dir })).stdout
    expect(after).toBe(before)
    expect(await readFile(path.join(dir, 'src/wip.ts'), 'utf8')).toBe('work in progress')
  })

  it('falls back to a directory walk outside git, with the same exclusions', async () => {
    const dir = await scratch()
    await writeFileIn(dir, 'package.json', JSON.stringify({ name: 'x', scripts: { build: 'true' } }))
    await writeFileIn(dir, 'src/a.ts', 'a')
    await writeFileIn(dir, 'node_modules/dep/index.js', 'x')

    const ws = await workspaceFor(await detectProject({ cwd: dir }))

    expect(ws.copiedBy).toContain('directory walk')
    expect(await readFile(path.join(ws.dir, 'src/a.ts'), 'utf8')).toBe('a')
  })

  it('warns when the build appears to read git metadata', async () => {
    const dir = await gitProject()
    await writeFileIn(
      dir,
      'package.json',
      JSON.stringify({ name: 'p', scripts: { build: 'git rev-parse HEAD && true' } }),
    )

    const ws = await workspaceFor(await detectProject({ cwd: dir }))

    expect(ws.warnings.join('\n')).toMatch(/git metadata/)
  })
})

describe('collectors: honest failure modes', () => {
  it('skips build_time with the exit code and log tail when the build fails', async () => {
    const dir = await gitProject()
    await writeFileIn(
      dir,
      'package.json',
      JSON.stringify({
        name: 'p',
        dependencies: { next: '15.0.0' },
        scripts: { build: 'node -e "console.error(\'boom: module not found\');process.exit(3)"' },
      }),
    )
    await writeFileIn(dir, 'node_modules/pkg/index.js', 'x') // deps present, build still fails
    const profile = await detectProject({ cwd: dir })
    const ws = await workspaceFor(profile)

    const outcome = await collectBuildTime(profile, ws)

    expect(outcome.succeeded).toBe(false)
    expect(outcome.metric.status).toBe('skipped')
    if (outcome.metric.status === 'skipped') {
      expect(outcome.metric.reason).toMatch(/sample 1\/3 exited with code 3/)
      expect(outcome.metric.reason).toMatch(/boom: module not found/)
    }
  })

  it('skips bundle_size rather than weighing nothing when the build failed', async () => {
    const dir = await gitProject()
    const profile = await detectProject({ cwd: dir })
    const ws = await workspaceFor(profile)

    const metric = await collectBundleSize(profile, ws, false)

    expect(metric.status).toBe('skipped')
    if (metric.status === 'skipped') expect(metric.reason).toMatch(/did not succeed/)
  })

  it('skips build_time when dependencies are absent instead of failing confusingly', async () => {
    const dir = await gitProject()
    await writeFileIn(
      dir,
      'package.json',
      JSON.stringify({ name: 'p', dependencies: { next: '15.0.0' }, scripts: { build: 'next build' } }),
    )
    const profile = await detectProject({ cwd: dir })
    const ws = await workspaceFor(profile)

    const outcome = await collectBuildTime(profile, ws)

    expect(outcome.metric.status).toBe('skipped')
    if (outcome.metric.status === 'skipped') {
      expect(outcome.metric.reason).toMatch(/not installed/)
    }
  })

  it('labels build time as cold — it is a comparison instrument, not the daily build', async () => {
    const dir = await gitProject()
    const profile = await detectProject({ cwd: dir })
    const ws = await workspaceFor(profile)

    const outcome = await collectBuildTime(profile, ws)

    expect(outcome.metric.label).toBe('build time (cold)')
  })
})

describe('bundle weighing', () => {
  it('sums output files but excludes the internal cache dir', async () => {
    const dir = await gitProject()
    const profile = { ...(await detectProject({ cwd: dir })), buildOutputDirs: ['.next'] }
    const ws = await workspaceFor(profile)

    await writeFileIn(ws.dir, '.next/static/app.js', 'x'.repeat(1000))
    await writeFileIn(ws.dir, '.next/server/page.js', 'y'.repeat(500))
    await writeFileIn(ws.dir, '.next/cache/webpack/huge.pack', 'z'.repeat(50_000))

    const metric = await collectBundleSize(profile, ws, true)

    expect(metric.status).toBe('measured')
    if (metric.status === 'measured') {
      expect(metric.value).toBe(1500)
      expect(metric.unit).toBe('bytes')
      expect(metric.collectedBy).toMatch(/excluding internal cache/)
    }
  })
})

describe('runCommand', () => {
  it('reports a command that cannot start instead of throwing', async () => {
    const outcome = await runCommand(
      { bin: 'driftwatch-definitely-not-a-binary', args: [] },
      { cwd: tmpdir(), env: {}, timeoutMs: 5000 },
    )
    expect(outcome.exitCode).toBeNull()
    expect(outcome.outputTail).toMatch(/failed to start/)
  })

  it('kills and reports on timeout', async () => {
    const outcome = await runCommand(
      { bin: 'node', args: ['-e', 'setTimeout(() => {}, 60000)'] },
      { cwd: tmpdir(), env: {}, timeoutMs: 300 },
    )
    expect(outcome.exitCode).not.toBe(0)
    expect(outcome.outputTail).toMatch(/timed out/)
  })
})

describe('protocol record', () => {
  it('captures workspace kind, cold cache, node_modules state, and environment', async () => {
    const dir = await gitProject()
    const profile = await detectProject({ cwd: dir })
    const ws = await workspaceFor(profile)

    const side = await measureWorkspace(profile, ws)

    expect(side.protocol).toMatchObject({
      version: 1,
      workspace: 'copy',
      cacheState: 'cold',
      gitMetadata: 'absent',
      nodeVersion: process.version,
      env: { NEXT_TELEMETRY_DISABLED: '1' },
    })
    expect(['cloned', 'copied', 'absent']).toContain(side.protocol.nodeModules)
  })
})

describe('median', () => {
  it('takes the middle sample, robust to one outlier', async () => {
    const { median } = await import('../src/core/index.js')
    expect(median([10, 900, 11])).toBe(11)
    expect(median([5])).toBe(5)
    expect(median([4, 8])).toBe(6)
  })
})
