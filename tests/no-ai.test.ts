import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const exec = promisify(execFile)
const repoRoot = path.resolve(import.meta.dirname, '..')
const temps: string[] = []

afterEach(async () => {
  await Promise.all(temps.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

/**
 * `--no-ai` must be a fully offline run (hard rule 6) — proven at the module-graph level, not
 * just "no network": a Node loader hook records every resolved module URL; the assertion is that
 * nothing under dist/ai/ was ever loaded.
 */

async function spyDir(): Promise<{ dir: string; register: string; log: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'driftwatch-spy-'))
  temps.push(dir)
  const log = path.join(dir, 'loaded.log')
  const hooks = path.join(dir, 'hooks.mjs')
  const register = path.join(dir, 'register.mjs')
  await writeFile(
    hooks,
    `import { appendFileSync } from 'node:fs'
export async function resolve(specifier, context, next) {
  const result = await next(specifier, context)
  if (result.url && result.url.includes('/dist/ai/')) {
    appendFileSync(process.env.DRIFTWATCH_SPY_LOG, result.url + '\\n')
  }
  return result
}
`,
    'utf8',
  )
  await writeFile(
    register,
    `import { register } from 'node:module'
register('${hooks.replace(/\\/g, '/')}', import.meta.url)
`,
    'utf8',
  )
  return { dir, register, log }
}

/** Tiny repo with a fast build and a committed regression-free state. */
async function tinyRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'driftwatch-noai-'))
  temps.push(dir)
  const write = async (rel: string, c: string) => {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true })
    await writeFile(path.join(dir, rel), c, 'utf8')
  }
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  await exec('git', ['-C', dir, 'config', 'user.email', 't@t'])
  await exec('git', ['-C', dir, 'config', 'user.name', 't'])
  await write('package.json', JSON.stringify({ name: 'p', scripts: { build: 'node build.js' } }))
  await write('next.config.mjs', 'export default {}\n')
  await write(
    'build.js',
    `const fs=require('fs');fs.mkdirSync('.next/static',{recursive:true});fs.writeFileSync('.next/static/app.js','x'.repeat(5000))`,
  )
  await write('package-lock.json', JSON.stringify({ name: 'p', lockfileVersion: 3, requires: true, packages: { '': { name: 'p' } } }))
  await write('.gitignore', 'node_modules/\n.next/\n.perf/\nperf.yml\n')
  await exec('git', ['-C', dir, 'add', '-A'])
  await exec('git', ['-C', dir, 'commit', '-q', '-m', 'base'])
  await write('node_modules/pkg/index.js', 'dep')
  return dir
}

async function runCli(
  args: string[],
  env: Record<string, string | undefined>,
  register: string,
  log: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await exec(
      'node',
      ['--import', register, path.join(repoRoot, 'dist', 'cli', 'index.js'), ...args],
      {
        env: { ...process.env, DRIFTWATCH_SPY_LOG: log, ...env },
        maxBuffer: 64 * 1024 * 1024,
      },
    )
    return { stdout, stderr, code: 0 }
  } catch (error) {
    // stderr is the whole point when the exit code is wrong — never swallow it (spec v44).
    const e = error as { code?: number; stdout?: string; stderr?: string }
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 }
  }
}

describe('--no-ai is provably offline', () => {
  it('the spy detects ai module loads (control — the instrument works)', async () => {
    const { register, log } = await spyDir()
    await exec(
      'node',
      ['--import', register, '-e', `await import(${JSON.stringify(path.join(repoRoot, 'dist', 'ai', 'index.js'))})`],
      { env: { ...process.env, DRIFTWATCH_SPY_LOG: log } },
    )
    const loaded = await readFile(log, 'utf8')
    expect(loaded).toContain('/dist/ai/')
  }, 30_000)

  it('a --no-ai run with a REGRESSION never loads the ai graph, and reports outcome disabled', async () => {
    const dir = await tinyRepo()
    const { register, log } = await spyDir()

    // Create a real regression: fatten the build output well past the threshold.
    await writeFile(
      path.join(dir, 'build.js'),
      `const fs=require('fs');fs.mkdirSync('.next/static',{recursive:true});fs.writeFileSync('.next/static/app.js','x'.repeat(300000))`,
      'utf8',
    )

    const { stdout, stderr, code } = await runCli(
      ['run', '--no-ai', '--json', '--cwd', dir],
      { DRIFTWATCH_API_KEY: 'sk-set-but-must-not-matter' },
      register,
      log,
    )

    expect(code, stderr).toBe(0)
    const result = JSON.parse(stdout)
    expect(result.verdict).toBe('regression')
    expect(result.analysis).toEqual({ outcome: 'disabled' })

    const loaded = await readFile(log, 'utf8').catch(() => '')
    expect(loaded).toBe('')
  }, 120_000)

  it('DRIFTWATCH_NO_AI=1 behaves identically to the flag', async () => {
    const dir = await tinyRepo()
    const { register, log } = await spyDir()

    const { stdout, stderr, code } = await runCli(
      ['run', '--json', '--cwd', dir],
      { DRIFTWATCH_NO_AI: '1', DRIFTWATCH_API_KEY: 'sk-irrelevant' },
      register,
      log,
    )

    expect(code, stderr).toBe(0)
    expect(JSON.parse(stdout).analysis).toEqual({ outcome: 'disabled' })
    expect(await readFile(log, 'utf8').catch(() => '')).toBe('')
  }, 120_000)

  it('a missing key on a regression reports no_key without loading the ai graph', async () => {
    const dir = await tinyRepo()
    const { register, log } = await spyDir()
    await writeFile(
      path.join(dir, 'build.js'),
      `const fs=require('fs');fs.mkdirSync('.next/static',{recursive:true});fs.writeFileSync('.next/static/app.js','x'.repeat(300000))`,
      'utf8',
    )

    const { stdout, stderr, code } = await runCli(
      ['run', '--json', '--cwd', dir],
      { DRIFTWATCH_API_KEY: undefined },
      register,
      log,
    )

    expect(code, stderr).toBe(0)
    const result = JSON.parse(stdout)
    expect(result.verdict).toBe('regression')
    expect(result.analysis).toEqual({ outcome: 'no_key' })
    expect(await readFile(log, 'utf8').catch(() => '')).toBe('')
  }, 120_000)
})

describe('static import hygiene', () => {
  it('no module outside dist/ai statically imports from dist/ai', async () => {
    const offenders: string[] = []
    async function scan(dir: string): Promise<void> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (full.includes(`${path.sep}ai`)) continue
          await scan(full)
          continue
        }
        if (!entry.name.endsWith('.js')) continue
        const source = await readFile(full, 'utf8')
        // Static ESM import of an ai path — dynamic `import('../ai/...')` is the allowed entry.
        if (/^import\s[^;]*from\s+['"][^'"]*\/ai\//m.test(source)) {
          offenders.push(full)
        }
      }
    }
    await scan(path.join(repoRoot, 'dist'))
    expect(offenders).toEqual([])
  })
})
