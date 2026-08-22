import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

import {
  createWorkingTreeWorkspace,
  detectProject,
  detectWorkspaceRoot,
  parsePnpmWorkspace,
  runDriftwatch,
  selectApp,
} from '../src/core/index.js'

const exec = promisify(execFile)
const temps: string[] = []

afterEach(async () => {
  await Promise.all(temps.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

/**
 * Monorepo support (spec §9a, M8 step 3) — the jinni blocker.
 *
 * Fixtures are built for the three workspace shapes the JS ecosystem actually uses, each with TWO
 * buildable apps so the "never guess which app" rule has something to refuse. Nothing here is
 * Next.js-specific beyond one config file per app: workspaces are an ecosystem feature, and the
 * detection has to read the declaration, not the framework.
 */
type Shape = 'pnpm' | 'npm' | 'yarn'

async function workspace(shape: Shape, options: { readonly declaredPm?: boolean } = {}): Promise<string> {
  const made = await mkdtemp(path.join(tmpdir(), `driftwatch-${shape}-`))
  temps.push(made)
  // macOS /var is a symlink to /private/var and detection realpaths deliberately (an earlier bug
  // produced a pathInRepo full of ../.. that escaped the worktree) — compare like with like.
  const dir = await realpath(made)
  const w = async (rel: string, content: string) => {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true })
    await writeFile(path.join(dir, rel), content, 'utf8')
  }

  const rootPkg: Record<string, unknown> = { name: 'root', private: true }
  if (options.declaredPm) rootPkg.packageManager = `${shape}@9.0.0`
  if (shape === 'pnpm') {
    await w('pnpm-workspace.yaml', 'packages:\n  - "apps/*"\n  - "packages/*"\n')
    await w('pnpm-lock.yaml', 'lockfileVersion: 9.0\n')
  } else {
    rootPkg.workspaces = ['apps/*', 'packages/*']
    await w(shape === 'yarn' ? 'yarn.lock' : 'package-lock.json', '{}\n')
  }
  await w('package.json', JSON.stringify(rootPkg, null, 2))

  // Two buildable apps + one library that declares no build script.
  for (const app of ['web', 'admin']) {
    await w(`apps/${app}/package.json`, JSON.stringify({
      name: `@acme/${app}`,
      scripts: { build: 'node build.js' },
      dependencies: { '@acme/ui': 'workspace:*', next: '^15.1.0' },
    }))
    await w(`apps/${app}/next.config.mjs`, 'export default {}\n')
    // Deliberately different sizes: the measured number must match the CHOSEN app, so the two
    // must be distinguishable by bytes alone.
    await w(`apps/${app}/app.js`, `const payload = '${app === 'web' ? 'W'.repeat(4000) : 'a'}'\n`)
    await w(`apps/${app}/build.js`, "const fs=require('fs')\nfs.mkdirSync('.next/static',{recursive:true})\nfs.writeFileSync('.next/static/out.js',fs.readFileSync('app.js'))\n")
  }
  await w('packages/ui/package.json', JSON.stringify({ name: '@acme/ui', main: 'index.js' }))
  await w('packages/ui/index.js', 'module.exports = {}\n')
  return dir
}

describe('workspace root detection — the declaration is the evidence', () => {
  for (const shape of ['pnpm', 'npm', 'yarn'] as const) {
    it(`finds the ${shape} workspace root by walking up from an app`, async () => {
      const root = await workspace(shape)
      const found = await detectWorkspaceRoot(path.join(root, 'apps/web'), root)

      expect(found.root).toBe(root)
      expect(found.declaredBy).toBe(shape === 'pnpm' ? 'pnpm-workspace.yaml' : 'package.json (workspaces)')
      expect(found.packages.map((p) => p.path).sort()).toEqual(['apps/admin', 'apps/web', 'packages/ui'])
      // The library declares no build script — it is not an app driftwatch can measure.
      expect(found.packages.filter((p) => p.buildable).map((p) => p.path).sort()).toEqual(['apps/admin', 'apps/web'])
    })
  }

  it('a standalone project is not a workspace — no root, no apps', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'driftwatch-solo-'))
    temps.push(dir)
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'solo' }), 'utf8')
    const found = await detectWorkspaceRoot(dir, dir)
    expect(found.root).toBeNull()
  })

  it('parses the pnpm workspace file without a YAML dependency', () => {
    expect(parsePnpmWorkspace('packages:\n  - "apps/*"\n  - packages/*\n# comment\n')).toEqual(['apps/*', 'packages/*'])
    expect(parsePnpmWorkspace('catalog:\n  react: ^19\npackages:\n  - apps/*\n')).toEqual(['apps/*'])
  })
})

describe('package manager — evidence in priority order, never a guess', () => {
  it('prefers the root packageManager field over the lockfile kind', async () => {
    const root = await workspace('pnpm', { declaredPm: true })
    const profile = await detectProject({ cwd: path.join(root, 'apps/web') })
    expect(profile.packageManager).toBe('pnpm')
    expect(profile.evidence.some((e) => e.detail?.includes('packageManager: "pnpm@9.0.0"'))).toBe(true)
  })

  for (const [shape, expected] of [['pnpm', 'pnpm'], ['npm', 'npm'], ['yarn', 'yarn']] as const) {
    it(`falls to the root lockfile kind for ${shape}, and reads the ROOT lockfile (§5.1)`, async () => {
      const root = await workspace(shape)
      const profile = await detectProject({ cwd: path.join(root, 'apps/web') })
      expect(profile.packageManager).toBe(expected)
      expect(profile.lockfile).toBe(shape === 'pnpm' ? 'pnpm-lock.yaml' : shape === 'yarn' ? 'yarn.lock' : 'package-lock.json')
      expect(profile.workspaceRoot).toBe(root)
      expect(profile.pathInWorkspace).toBe('apps/web')
    })
  }

  it('workspace:* deps with NO evidence is an error carrying its fix, never an attempt', async () => {
    // A workspace declaration with no lockfile and no packageManager field: npm would be a guess,
    // and npm cannot resolve workspace:* at all — the jinni failure, refused before it runs.
    const dir = await mkdtemp(path.join(tmpdir(), 'driftwatch-noevidence-'))
    temps.push(dir)
    await mkdir(path.join(dir, 'apps/web'), { recursive: true })
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'r', workspaces: ['apps/*'] }), 'utf8')
    await writeFile(
      path.join(dir, 'apps/web/package.json'),
      JSON.stringify({ name: 'w', scripts: { build: 'x' }, dependencies: { ui: 'workspace:*' } }),
      'utf8',
    )

    const profile = await detectProject({ cwd: path.join(dir, 'apps/web') })
    const warning = profile.warnings.find((w) => w.includes('workspace:*'))
    expect(warning).toBeDefined()
    expect(warning).toContain('package_manager: pnpm') // the exact line to paste
    expect(warning).toContain('will not guess')
  })
})

describe('choosing the app — explicit or refused, never silent', () => {
  it('refuses at the workspace root when several apps are buildable, listing them', async () => {
    const root = await workspace('pnpm')
    const selection = await selectApp({ cwd: root })

    expect(selection.refusal).toContain('2 buildable packages')
    expect(selection.refusal).toContain('apps/admin')
    expect(selection.refusal).toContain('apps/web')
    expect(selection.refusal).toContain('driftwatch run --app apps/admin')
    expect(selection.refusal).toContain('app: apps/admin')
  })

  it('--app picks one; an unknown app is refused with the real list', async () => {
    const root = await workspace('pnpm')
    const chosen = await selectApp({ cwd: root, app: 'apps/web' })
    expect(chosen.refusal).toBeNull()
    expect(chosen.profile.projectRoot).toBe(path.join(root, 'apps/web'))

    const wrong = await selectApp({ cwd: root, app: 'apps/nope' })
    expect(wrong.refusal).toContain('is not a package of this workspace')
    expect(wrong.refusal).toContain('apps/web')
  })

  it('standing inside an app needs no choice at all', async () => {
    const root = await workspace('pnpm')
    const selection = await selectApp({ cwd: path.join(root, 'apps/web') })
    expect(selection.refusal).toBeNull()
    expect(selection.profile.pathInWorkspace).toBe('apps/web')
  })

  it('run refuses rather than measuring a guessed app', async () => {
    const root = await workspace('pnpm')
    await exec('git', ['init', '-q', '-b', 'main'], { cwd: root })
    await exec('git', ['-C', root, 'config', 'user.email', 't@t'])
    await exec('git', ['-C', root, 'config', 'user.name', 't'])
    await exec('git', ['-C', root, 'add', '-A'])
    await exec('git', ['-C', root, 'commit', '-q', '-m', 'init'])

    await expect(runDriftwatch({ cwd: root, serve: false, browser: false })).rejects.toThrow(
      /buildable packages/,
    )
  })
})

describe('measuring one app of a workspace', () => {
  it('the measurement copy holds the WHOLE workspace; install targets the root, build the app', async () => {
    const root = await workspace('pnpm')
    // node_modules at the root and in the app — the pnpm shape: one real store, per-package links.
    await mkdir(path.join(root, 'node_modules/.pnpm/next@15/node_modules/next'), { recursive: true })
    await writeFile(path.join(root, 'node_modules/.pnpm/next@15/node_modules/next/index.js'), 'x', 'utf8')
    await mkdir(path.join(root, 'apps/web/node_modules'), { recursive: true })
    await symlink('../../../node_modules/.pnpm/next@15/node_modules/next', path.join(root, 'apps/web/node_modules/next'))

    const profile = (await selectApp({ cwd: root, app: 'apps/web' })).profile
    const copy = await createWorkingTreeWorkspace(profile)
    try {
      // dir = the app (where build and serve run); installDir = the workspace root.
      expect(copy.dir.endsWith(path.join('apps', 'web'))).toBe(true)
      expect(copy.installDir).toBe(path.dirname(path.dirname(copy.dir)))

      // The whole workspace came along — the other app and the shared package are present, which
      // is what `workspace:*` resolution needs (spec §9a).
      expect(await exists(path.join(copy.installDir, 'apps/admin/package.json'))).toBe(true)
      expect(await exists(path.join(copy.installDir, 'packages/ui/package.json'))).toBe(true)
      expect(await exists(path.join(copy.installDir, 'pnpm-workspace.yaml'))).toBe(true)

      // The node_modules forest is cloned, and the app's RELATIVE symlink still resolves inside
      // the copy — copying only the app dir is exactly how the jinni trial dangled every link.
      expect(await exists(path.join(copy.installDir, 'node_modules/.pnpm'))).toBe(true)
      expect(await exists(path.join(copy.dir, 'node_modules/next/index.js'))).toBe(true)
    } finally {
      await copy.cleanup()
    }
  })

  // The npm shape for the end-to-end: npm is a real binary on every machine, while pnpm and yarn
  // arrive through corepack, which resolves its version from the nearest package.json and cannot
  // be relied on inside a synthetic fixture. Detection for all three shapes is covered above; what
  // this test proves is the MEASUREMENT path — copy the workspace, install at the root, build and
  // weigh one app.
  it('measures the chosen app end to end and weighs only that app\'s output', async () => {
    const root = await workspace('npm')
    // Dependencies present on both sides → the lockfile rule clones instead of installing, so the
    // measurement exercises the workspace copy without needing a real registry.
    await mkdir(path.join(root, 'node_modules/pkg'), { recursive: true })
    await writeFile(path.join(root, 'node_modules/pkg/index.js'), 'x', 'utf8')
    await mkdir(path.join(root, 'apps/web/node_modules'), { recursive: true })
    await writeFile(path.join(root, 'apps/web/node_modules/marker.js'), 'x', 'utf8')

    await exec('git', ['init', '-q', '-b', 'main'], { cwd: root })
    await exec('git', ['-C', root, 'config', 'user.email', 't@t'])
    await exec('git', ['-C', root, 'config', 'user.name', 't'])
    await writeFile(path.join(root, '.gitignore'), 'node_modules/\n.next/\n.perf/\n', 'utf8')
    await exec('git', ['-C', root, 'add', '-A'])
    await exec('git', ['-C', root, 'commit', '-q', '-m', 'init'])

    const result = await runDriftwatch({ cwd: root, app: 'apps/web', serve: false, browser: false })

    expect(result.project.root).toBe(path.join(root, 'apps/web'))
    expect(result.project.pathInRepo).toBe('apps/web')
    const bundle = result.current.metrics.find((m) => m.id === 'client_bundle_size')!
    expect(bundle.status).toBe('measured')
    // apps/web weighs ~4KB, apps/admin ~20 bytes: the number proves WHICH app was weighed, and
    // that the other app's output never leaked into it.
    if (bundle.status !== 'measured') throw new Error('unreachable')
    expect(bundle.value).toBeGreaterThan(4000)
    expect(bundle.value).toBeLessThan(4200)
  }, 300_000)
})

async function exists(p: string): Promise<boolean> {
  return access(p).then(() => true, () => false)
}
