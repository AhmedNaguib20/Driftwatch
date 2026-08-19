import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  CONFIG_FILENAME,
  configFromProfile,
  detectProject,
  detectRoutes,
  installCommand,
  loadConfig,
  parsePercent,
  renderConfig,
  writeConfigIfAbsent,
} from '../src/core/index.js'

const repoRoot = path.resolve(import.meta.dirname, '..')
const fixture = path.join(repoRoot, 'fixtures', 'next-app')

const temps: string[] = []

async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'driftwatch-detect-'))
  temps.push(dir)
  return dir
}

async function writeFileIn(dir: string, rel: string, contents = ''): Promise<void> {
  const target = path.join(dir, rel)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, contents, 'utf8')
}

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('detectProject on the Next.js fixture', () => {
  it('identifies the stack from real files', async () => {
    const profile = await detectProject({ cwd: fixture })

    expect(profile.projectRoot).toBe(fixture)
    expect(profile.language).toBe('javascript')
    expect(profile.framework).toBe('nextjs')
    expect(profile.frameworkVersion).toMatch(/^15\./)
    expect(profile.packageManager).toBe('npm')
    expect(profile.lockfile).toBe('package-lock.json')
  })

  it('locates the project inside its git repo, so the worktree can find it later', async () => {
    const profile = await detectProject({ cwd: fixture })

    expect(profile.gitRoot).toBe(repoRoot)
    expect(profile.pathInRepo).toBe(path.join('fixtures', 'next-app'))
  })

  it('resolves a runnable build command and the dirs a cold build must clear', async () => {
    const profile = await detectProject({ cwd: fixture })

    expect(profile.commands.build).toEqual({ bin: 'npm', args: ['run', 'build'] })
    expect(profile.buildOutputDirs).toEqual(['.next'])
    // Hard rule 5: both sides are forced cold, so .next must be on the clear list.
    expect(profile.cacheDirs).toContain('.next')
  })

  it('only claims metrics it can actually collect', async () => {
    const profile = await detectProject({ cwd: fixture })
    expect(profile.supportedMetrics).toEqual(['build_time', 'bundle_size'])
  })

  it('records evidence for what it concluded', async () => {
    const profile = await detectProject({ cwd: fixture })
    const facts = profile.evidence.map((e) => e.fact)

    expect(facts).toContain('framework: nextjs')
    expect(facts).toContain('package manager: npm')
    expect(profile.evidence.every((e) => e.source.length > 0)).toBe(true)
  })

  it('finds every route in the fixture', async () => {
    const profile = await detectProject({ cwd: fixture })
    expect(profile.routes).toEqual(['/', '/about', '/blog', '/blog/[slug]', '/dashboard', '/live'])
  })

  it('detects from a subdirectory by walking up to the project root', async () => {
    const profile = await detectProject({ cwd: path.join(fixture, 'app', 'blog') })
    expect(profile.projectRoot).toBe(fixture)
    expect(profile.framework).toBe('nextjs')
  })
})

describe('detectProject degrades honestly', () => {
  it('reports unknown and warns when there is no package.json', async () => {
    const dir = await scratch()
    const profile = await detectProject({ cwd: dir })

    expect(profile.language).toBe('unknown')
    expect(profile.framework).toBe('unknown')
    expect(profile.supportedMetrics).toEqual([])
    expect(profile.warnings.join('\n')).toMatch(/No package.json/)
  })

  it('warns rather than guessing when the framework is unrecognised', async () => {
    const dir = await scratch()
    await writeFileIn(dir, 'package.json', JSON.stringify({ name: 'plain', scripts: { build: 'tsc' } }))

    const profile = await detectProject({ cwd: dir })

    expect(profile.framework).toBe('unknown')
    expect(profile.supportedMetrics).toEqual([])
    expect(profile.warnings.join('\n')).toMatch(/No supported framework/)
  })

  it('warns when a custom distDir means we would weigh the wrong directory', async () => {
    const dir = await scratch()
    await writeFileIn(dir, 'package.json', JSON.stringify({ dependencies: { next: '15.1.3' } }))
    await writeFileIn(dir, 'next.config.mjs', 'export default { distDir: "build" }\n')

    const profile = await detectProject({ cwd: dir })

    expect(profile.framework).toBe('nextjs')
    expect(profile.warnings.join('\n')).toMatch(/distDir/)
  })

  it('warns when dependencies are not installed, so the version is only a range', async () => {
    const dir = await scratch()
    await writeFileIn(dir, 'package.json', JSON.stringify({ dependencies: { next: '^15.1.3' } }))

    const profile = await detectProject({ cwd: dir })

    expect(profile.frameworkVersion).toBe('^15.1.3')
    expect(profile.warnings.join('\n')).toMatch(/not installed/)
  })

  it('warns when there is no git repository to take a baseline from', async () => {
    const dir = await scratch()
    await writeFileIn(dir, 'package.json', JSON.stringify({ name: 'x' }))

    const profile = await detectProject({ cwd: dir })

    expect(profile.gitRoot).toBeNull()
    expect(profile.warnings.join('\n')).toMatch(/Not inside a git repository/)
  })
})

describe('package manager detection', () => {
  const cases: [string, string][] = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lockb', 'bun'],
    ['package-lock.json', 'npm'],
  ]

  for (const [lockfile, expected] of cases) {
    it(`reads ${expected} from ${lockfile}`, async () => {
      const dir = await scratch()
      await writeFileIn(dir, 'package.json', '{}')
      await writeFileIn(dir, lockfile, '')

      const profile = await detectProject({ cwd: dir })

      expect(profile.packageManager).toBe(expected)
      expect(profile.lockfile).toBe(lockfile)
    })
  }

  it('falls back to the corepack field when no lockfile exists', async () => {
    const dir = await scratch()
    await writeFileIn(dir, 'package.json', JSON.stringify({ packageManager: 'pnpm@9.15.0' }))

    const profile = await detectProject({ cwd: dir })

    expect(profile.packageManager).toBe('pnpm')
    expect(profile.lockfile).toBeNull()
  })

  it('labels the npm default as assumed rather than observed', async () => {
    const dir = await scratch()
    await writeFileIn(dir, 'package.json', '{}')

    const profile = await detectProject({ cwd: dir })
    const note = profile.evidence.find((e) => e.fact === 'package manager: npm')

    expect(note?.source).toBe('default')
    expect(note?.detail).toMatch(/assumed, not observed/)
  })

  it('installs frozen against a lockfile so both sides resolve identically', () => {
    expect(installCommand('npm', true)).toEqual({ bin: 'npm', args: ['ci'] })
    expect(installCommand('pnpm', true)).toEqual({
      bin: 'pnpm',
      args: ['install', '--frozen-lockfile'],
    })
    expect(installCommand('yarn', true)).toEqual({ bin: 'yarn', args: ['install', '--immutable'] })
  })
})

describe('route detection', () => {
  it('strips route groups and skips private and parallel folders', async () => {
    const dir = await scratch()
    await writeFileIn(dir, 'app/page.tsx')
    await writeFileIn(dir, 'app/(marketing)/pricing/page.tsx')
    await writeFileIn(dir, 'app/_components/page.tsx')
    await writeFileIn(dir, 'app/@modal/login/page.tsx')
    await writeFileIn(dir, 'app/docs/[...slug]/page.tsx')

    const { routes, routers } = await detectRoutes(dir)

    expect(routes).toEqual(['/', '/docs/[...slug]', '/pricing'])
    expect(routers).toEqual(['app'])
  })

  it('reads the pages router and ignores plumbing and api handlers', async () => {
    const dir = await scratch()
    await writeFileIn(dir, 'pages/index.tsx')
    await writeFileIn(dir, 'pages/about.tsx')
    await writeFileIn(dir, 'pages/_app.tsx')
    await writeFileIn(dir, 'pages/_document.tsx')
    await writeFileIn(dir, 'pages/api/hello.ts')

    const { routes, routers } = await detectRoutes(dir)

    expect(routes).toEqual(['/', '/about'])
    expect(routers).toEqual(['pages'])
  })

  it('reads routes from src/app as well', async () => {
    const dir = await scratch()
    await writeFileIn(dir, 'src/app/page.tsx')
    await writeFileIn(dir, 'src/app/team/page.tsx')

    const { routes } = await detectRoutes(dir)

    expect(routes).toEqual(['/', '/team'])
  })
})

describe('perf.yml', () => {
  it('lists only the metrics detection found', async () => {
    const profile = await detectProject({ cwd: fixture })
    const yaml = renderConfig(configFromProfile(profile))

    expect(yaml).toContain('detect: nextjs')
    expect(yaml).toContain('measure: [build_time, bundle_size]')
    expect(yaml).toContain('threshold: 5%')
    expect(yaml).toContain('block_merge: false')
  })

  it('round-trips through the loader', async () => {
    const dir = await scratch()
    const profile = await detectProject({ cwd: fixture })
    const config = configFromProfile(profile)
    await writeFile(path.join(dir, CONFIG_FILENAME), renderConfig(config), 'utf8')

    const loaded = await loadConfig(dir)

    expect(loaded.detect).toBe('nextjs')
    expect(loaded.measure).toEqual(['build_time', 'bundle_size'])
    expect(loaded.thresholdPercent).toBe(5)
    expect(loaded.noiseFloorPercent).toBe(2)
    expect(loaded.block_merge).toBe(false)
    expect(loaded.warnings).toEqual([])
  })

  it('writes when absent', async () => {
    const dir = await scratch()
    await writeFileIn(dir, 'package.json', '{}')

    const result = await writeConfigIfAbsent(dir, configFromProfile(await detectProject({ cwd: dir })))

    expect(result.created).toBe(true)
    expect(await loadConfig(dir)).toBeTruthy()
  })

  it('never overwrites a config the user has edited', async () => {
    const dir = await scratch()
    const mine = 'detect: nextjs\nthreshold: 12%\n'
    await writeFile(path.join(dir, CONFIG_FILENAME), mine, 'utf8')

    const result = await writeConfigIfAbsent(dir, configFromProfile(await detectProject({ cwd: dir })))
    const loaded = await loadConfig(dir)

    expect(result.created).toBe(false)
    expect(loaded.thresholdPercent).toBe(12)
  })

  it('degrades to defaults and says so when the file is malformed', async () => {
    const dir = await scratch()
    await writeFile(path.join(dir, CONFIG_FILENAME), 'detect: [unclosed\n', 'utf8')

    const loaded = await loadConfig(dir)

    expect(loaded.thresholdPercent).toBe(5)
    expect(loaded.warnings.join('\n')).toMatch(/could not be parsed/)
  })

  it('flags unknown keys and bad values instead of silently accepting them', async () => {
    const dir = await scratch()
    await writeFile(
      path.join(dir, CONFIG_FILENAME),
      'detect: nextjs\nthreshold: soon\nblock_merge: maybe\nmeasure: [build_time, telepathy]\nnonsense: 1\n',
      'utf8',
    )

    const loaded = await loadConfig(dir)
    const warnings = loaded.warnings.join('\n')

    expect(loaded.measure).toEqual(['build_time'])
    expect(loaded.thresholdPercent).toBe(5)
    expect(warnings).toMatch(/telepathy/)
    expect(warnings).toMatch(/nonsense/)
    expect(warnings).toMatch(/block_merge/)
    expect(warnings).toMatch(/threshold/)
  })

  it('parses percentages written either way', () => {
    expect(parsePercent('5%')).toBe(5)
    expect(parsePercent('5')).toBe(5)
    expect(parsePercent('2.5%')).toBe(2.5)
    expect(parsePercent('later')).toBeNull()
  })
})
