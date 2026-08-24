import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

import { AI_KEY_ENV, CAPABILITIES, capabilitiesOf, requiresAiTier } from '../src/core/index.js'

/**
 * The keyless guarantee (spec §9e): **driftwatch measures for free and forever without any API
 * key, and every keyless surface is complete — not degraded, not nagging.**
 *
 * That is the promise being sold, so it is tested the way hard rule 2 is tested: by running the
 * real binary with the whole key surface scrubbed from the environment and asserting on what
 * comes out. The strong form is not "it works without a key" but "**it does not mention the tier
 * at all**" — a complete tool, not a complete tool with an advertisement stapled to every run.
 *
 * Exactly one situation earns a mention: a regression that analysis could have explained.
 */

const exec = promisify(execFile)
const repoRoot = path.resolve(import.meta.dirname, '..')
const temps: string[] = []

afterEach(async () => {
  await Promise.all(temps.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

/** Every key the tool could ever read, and the per-provider names users already have set. */
const KEY_VARS = [AI_KEY_ENV, 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']

function scrubbed(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const name of KEY_VARS) delete env[name]
  return env
}

/** Anything that would tell a keyless user about a tier they did not ask for. */
const TIER_TALK = /api.?key|DRIFTWATCH_API_KEY|DEEPSEEK|OPENAI|ANTHROPIC|BYOK|\bAI\b|analysis|analyse/i

async function tinyRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'driftwatch-keyless-'))
  temps.push(dir)
  const write = async (rel: string, contents: string) => {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true })
    await writeFile(path.join(dir, rel), contents, 'utf8')
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
  // Byte classes only. A 50ms build measured twice under parallel test load can swing past the
  // threshold and produce a REAL regression — which would then legitimately print the single
  // mention and fail a silence assertion for the right reason. Bytes are deterministic (the same
  // doctrine that licenses movement attribution), so the verdict here is controlled by the test.
  await write('perf.yml', 'detect: nextjs\nmeasure: [client_bundle_size]\n')
  await write('.gitignore', 'node_modules/\n.next/\n.perf/\n')
  await exec('git', ['-C', dir, 'add', '-A'])
  await exec('git', ['-C', dir, 'commit', '-q', '-m', 'base'])
  await write('node_modules/pkg/index.js', 'dep')
  return dir
}

/** Fattens the build output past every threshold — a regression analysis could have explained. */
async function makeRegression(dir: string): Promise<void> {
  await writeFile(
    path.join(dir, 'build.js'),
    `const fs=require('fs');fs.mkdirSync('.next/static',{recursive:true});fs.writeFileSync('.next/static/app.js','x'.repeat(400000))`,
    'utf8',
  )
}

/** `out` is everything a user sees; `stdout` alone is the machine contract. */
async function cli(args: string[]): Promise<{ out: string; stdout: string; code: number }> {
  try {
    const { stdout, stderr } = await exec('node', [path.join(repoRoot, 'dist', 'cli', 'index.js'), ...args], {
      env: scrubbed(),
      maxBuffer: 64 * 1024 * 1024,
    })
    return { out: stdout + stderr, stdout, code: 0 }
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string }
    return { out: (e.stdout ?? '') + (e.stderr ?? ''), stdout: e.stdout ?? '', code: e.code ?? 1 }
  }
}

describe('the feature matrix is one source of truth', () => {
  it('declares a tier for every capability, and answers which need a key', () => {
    expect(CAPABILITIES.length).toBeGreaterThan(0)
    for (const capability of CAPABILITIES) {
      expect(['measurement', 'ai']).toContain(capability.tier)
      // An AI-tier capability must justify itself: "needs a key" is a claim, not a category.
      if (capability.tier === 'ai') expect(capability.why, capability.id).toBeTruthy()
    }
    expect(requiresAiTier('measure')).toBe(false)
    expect(requiresAiTier('analysis')).toBe(true)
    expect(requiresAiTier('auto-fix')).toBe(true)
    expect(capabilitiesOf('measurement').map((c) => c.id)).toContain('trend')
  })

  it('never places measurement, trends or the PR surfaces behind the key', () => {
    const free = capabilitiesOf('measurement').map((c) => c.id)
    for (const id of ['measure', 'pr-surfaces', 'record', 'trend']) expect(free).toContain(id)
  })
})

describe('keyless paths say nothing about the tier', () => {
  it('a clean run is complete and silent about AI', async () => {
    const dir = await tinyRepo()
    const { out, code } = await cli(['run', '--cwd', dir, '--no-serve', '--no-browser'])

    expect(code, out).toBe(0)
    expect(out).toContain('build time (cold)')
    expect(out).toContain('client bundle size')
    expect(out).not.toMatch(TIER_TALK)
  }, 120_000)

  it('record is complete and silent about AI', async () => {
    const dir = await tinyRepo()
    const { out, code } = await cli(['record', '--cwd', dir, '--no-serve', '--no-browser'])

    expect(code, out).toBe(0)
    expect(out).toContain('build time (cold)')
    expect(out).not.toMatch(TIER_TALK)
  }, 120_000)

  it('init, trend, alerts and dashboard are silent about AI', async () => {
    const dir = await tinyRepo()
    for (const args of [
      ['init', '--cwd', dir, '--json'],
      ['trend', '--cwd', dir, '--no-fetch'],
      ['alerts', '--cwd', dir, '--no-fetch'],
      ['dashboard', '--cwd', dir, '--no-fetch'],
    ]) {
      const { out, code } = await cli(args)
      expect(code, `${args[0]}: ${out}`).toBe(0)
      expect(out, args[0]).not.toMatch(TIER_TALK)
    }
  }, 120_000)

  it('the JSON contract still records that analysis did not apply — silence is for humans', async () => {
    const dir = await tinyRepo()
    const { stdout, code } = await cli(['run', '--cwd', dir, '--json', '--no-serve', '--no-browser'])

    expect(code).toBe(0)
    // A machine consumer can still tell "nothing to explain" from "we tried and it failed".
    expect(JSON.parse(stdout).analysis).toEqual({ outcome: 'not_applicable' })
  }, 120_000)
})

describe('the single mention', () => {
  it('appears exactly once on a regression, and says what the tier adds', async () => {
    const dir = await tinyRepo()
    await makeRegression(dir)
    const { out, code } = await cli(['run', '--cwd', dir, '--no-serve', '--no-browser'])

    expect(code, out).toBe(0)
    expect(out).toContain('performance regression')
    // Once: one instruction, one env var, in one place.
    expect([...out.matchAll(new RegExp(AI_KEY_ENV, 'g'))]).toHaveLength(1)
    expect(out).toContain('optional AI tier')
    expect(out).toContain('Analysis reads the diff')
    // And it frames the keyless state as the free tier, never as something broken.
    expect(out).not.toMatch(/error|failed|missing|misconfigur/i)
  }, 120_000)

  it('says the same thing about the fix tier rather than a second thing', async () => {
    const dir = await tinyRepo()
    await makeRegression(dir)
    await writeFile(path.join(dir, 'perf.yml'), 'detect: nextjs\nauto_fix: propose\n', 'utf8')
    const { out, code } = await cli(['run', '--cwd', dir, '--no-serve', '--no-browser'])

    expect(code, out).toBe(0)
    // auto_fix with no key is a clean, explained no-op: still ONE mention, now covering both.
    expect([...out.matchAll(new RegExp(AI_KEY_ENV, 'g'))]).toHaveLength(1)
    expect(out).toContain('measures before proposing it as a PR')
    expect(out).not.toMatch(/error|could not open|failed/i)
  }, 120_000)

  it('is absent again the moment the regression is gone', async () => {
    const dir = await tinyRepo()
    const { out } = await cli(['run', '--cwd', dir, '--no-serve', '--no-browser'])
    expect(out).not.toMatch(TIER_TALK)
  }, 120_000)
})

describe('the one command that does need the tier', () => {
  it('refuses with a remedy, not a stack trace', async () => {
    const { out, code } = await cli(['eval'])

    expect(code).toBe(1)
    expect(out).toContain('needs the AI tier')
    expect(out).toContain(`export ${AI_KEY_ENV}=`)
    // It also says what still works without one — a refusal that leaves the user oriented.
    expect(out).toMatch(/Measurement needs no key/)
    expect(out).not.toMatch(/at .*\.js:\d+|Error:/)
  }, 60_000)
})
