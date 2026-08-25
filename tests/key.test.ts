import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

import {
  AI_KEY_ENV,
  SelectionRefused,
  describeKeySource,
  literalKeyInConfig,
  loadConfig,
  looksLikeApiKey,
  maskKey,
  resolveAiKey,
} from '../src/core/index.js'

/**
 * Key handling (spec §9e step A). Two jobs: find the key where the user actually keeps it, and
 * refuse the one place it must never be.
 */

const temps: string[] = []
afterEach(async () => {
  await Promise.all(temps.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

async function projectWith(perfYml: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'driftwatch-key-'))
  temps.push(dir)
  await writeFile(path.join(dir, 'perf.yml'), perfYml, 'utf8')
  return dir
}

const CONFIG = { provider: 'deepseek', key_command: null }

describe('where the key comes from', () => {
  it('prefers the tool-specific variable over everything else', async () => {
    const resolved = await resolveAiKey(
      { provider: 'deepseek', key_command: 'echo from-command' },
      { [AI_KEY_ENV]: ' explicit ', DEEPSEEK_API_KEY: 'provider-one' },
    )

    expect(resolved.key).toBe('explicit')
    expect(resolved.source).toEqual({ kind: 'env', name: AI_KEY_ENV })
  })

  it('runs key_command when no tool variable is set — the password-manager path', async () => {
    const resolved = await resolveAiKey(
      { provider: 'deepseek', key_command: 'op read op://vault/ai/key' },
      { DEEPSEEK_API_KEY: 'provider-one' },
      async () => 'sk-from-vault\n',
    )

    // key_command beats the provider fallback: it names driftwatch's key, the fallback is
    // whatever the shell happened to have.
    expect(resolved.key).toBe('sk-from-vault')
    expect(resolved.source).toEqual({ kind: 'key_command', command: 'op read op://vault/ai/key' })
    expect(describeKeySource(resolved.source)).toContain('op read op://vault/ai/key')
  })

  it('falls back to a per-provider variable the user already had set', async () => {
    const deepseek = await resolveAiKey(CONFIG, { DEEPSEEK_API_KEY: 'ds' })
    expect(deepseek.key).toBe('ds')
    expect(deepseek.source).toEqual({ kind: 'env', name: 'DEEPSEEK_API_KEY' })

    // The fallback follows the CONFIGURED provider: an OpenAI key is not a DeepSeek key.
    const mismatched = await resolveAiKey(CONFIG, { OPENAI_API_KEY: 'oa' })
    expect(mismatched.key).toBeNull()

    const openai = await resolveAiKey({ provider: 'openai', key_command: null }, { OPENAI_API_KEY: 'oa' })
    expect(openai.key).toBe('oa')
  })

  it('no key anywhere is the free tier, not a problem', async () => {
    const resolved = await resolveAiKey(CONFIG, {})

    expect(resolved.key).toBeNull()
    expect(resolved.problem).toBeNull()
    expect(resolved.source).toEqual({ kind: 'none' })
  })

  it('a key_command that fails is a problem — the user asked for it and it broke', async () => {
    const failed = await resolveAiKey(
      { provider: 'deepseek', key_command: 'op read op://vault/ai/key' },
      {},
      async () => {
        throw new Error('[ERROR] not signed in\nrun `op signin`')
      },
    )

    expect(failed.key).toBeNull()
    // Distinct from no_key: a configured source that broke must be reported, and the command's
    // own first line is the useful part ("not signed in").
    expect(failed.problem).toContain('not signed in')

    const empty = await resolveAiKey({ provider: 'deepseek', key_command: 'true' }, {}, async () => '  \n')
    expect(empty.problem).toMatch(/no output/)
  })

  it('really runs a shell command', async () => {
    const resolved = await resolveAiKey({ provider: 'deepseek', key_command: 'printf sk-real-output' }, {})
    expect(resolved.key).toBe('sk-real-output')
  })
})

describe('a literal key in perf.yml is refused, not warned about', () => {
  it('refuses on a key-shaped value, whatever field it hides in', async () => {
    const dir = await projectWith('detect: nextjs\nmodel: sk-abcdef0123456789abcdef\n')

    await expect(loadConfig(dir)).rejects.toBeInstanceOf(SelectionRefused)
    await expect(loadConfig(dir)).rejects.toThrow(/refusing to run/)
  })

  it('refuses on a secret-shaped FIELD NAME even when the value looks like nothing', async () => {
    const dir = await projectWith('detect: nextjs\napi_key: hunter2\n')

    // We would rather refuse a harmless string than let one real key through for want of a prefix.
    await expect(loadConfig(dir)).rejects.toThrow(/perf\.yml is committed/)
  })

  it('says how to supply it properly, and to rotate the one that leaked', async () => {
    const dir = await projectWith('detect: nextjs\nkey_command: sk-abcdef0123456789abcdef\n')

    await expect(loadConfig(dir)).rejects.toThrow(/export DRIFTWATCH_API_KEY=/)
    await expect(loadConfig(dir)).rejects.toThrow(/op read op:\/\/vault/)
    await expect(loadConfig(dir)).rejects.toThrow(/treated as leaked/)
  })

  it('never prints the key it found', async () => {
    const dir = await projectWith('detect: nextjs\nprovider: sk-supersecretvalue123456\n')

    await expect(loadConfig(dir)).rejects.toThrow(/sk-sup…\d+ chars/)
    await expect(loadConfig(dir)).rejects.not.toThrow(/supersecretvalue123456/)
  })

  it('lets a real key_command through — a command is not a key', async () => {
    const dir = await projectWith('detect: nextjs\nkey_command: op read op://vault/ai/key\n')

    const config = await loadConfig(dir)
    expect(config.key_command).toBe('op read op://vault/ai/key')
  })

  it('knows a key from a command', () => {
    expect(looksLikeApiKey('sk-abcdef0123456789abcdef')).toBe(true)
    expect(looksLikeApiKey('sk-ant-api03-abcdef0123456789')).toBe(true)
    expect(looksLikeApiKey('op read op://vault/ai/key')).toBe(false)
    expect(looksLikeApiKey('deepseek-chat')).toBe(false)
    expect(looksLikeApiKey('nextjs')).toBe(false)
    expect(maskKey('sk-abcdef0123456789')).toBe('sk-abc…19 chars')
  })

  it('accepts a config with no secrets at all', () => {
    expect(literalKeyInConfig({ detect: 'nextjs', model: 'deepseek-chat', threshold: '5%' })).toBeNull()
  })
})

describe('the key never reaches disk', () => {
  const exec = promisify(execFile)

  it('is absent from the result JSON, and so is the vault path that produced it', async () => {
    // The result JSON is committed to the perf-data branch, which is public on most repos. What
    // must never reach it: the key itself, and the `key_command` TEXT — that string is a vault
    // path, and naming where a secret lives is its own kind of leak.
    //
    // `--no-ai` is not incidental. Without it this test depended on a timed build staying under
    // the threshold: when build_time noise crossed it the verdict became `regression`, analysis
    // ran, and a provider stanza legitimately appeared — which also meant the suite made a live
    // API call. An assertion that depends on which branch a timed run took is flaky by
    // construction (CLAUDE.md conventions); this asserts the invariant on both branches instead.
    const dir = await mkdtemp(path.join(tmpdir(), 'driftwatch-keyjson-'))
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
    await write('build.js', `const fs=require('fs');fs.mkdirSync('.next/static',{recursive:true});fs.writeFileSync('.next/static/app.js','x'.repeat(5000))`)
    await write('package-lock.json', JSON.stringify({ name: 'p', lockfileVersion: 3, requires: true, packages: { '': { name: 'p' } } }))
    await write('perf.yml', 'detect: nextjs\nkey_command: printf sk-secret-from-vault-123456 # op://vault/ai/key\n')
    await write('.gitignore', 'node_modules/\n.next/\n.perf/\n')
    await exec('git', ['-C', dir, 'add', '-A'])
    await exec('git', ['-C', dir, 'commit', '-q', '-m', 'base'])

    const cli = path.resolve(import.meta.dirname, '..', 'dist', 'cli', 'index.js')
    const env = { ...process.env }
    delete env[AI_KEY_ENV]
    const runJson = async () => {
      const { stdout } = await exec('node', [cli, 'run', '--cwd', dir, '--json', '--no-ai', '--no-serve', '--no-browser'], {
        env,
        maxBuffer: 64 * 1024 * 1024,
      })
      return stdout
    }

    // Both verdict branches, forced deterministically by BYTES rather than left to the clock.
    const clean = await runJson()
    await write('build.js', `const fs=require('fs');fs.mkdirSync('.next/static',{recursive:true});fs.writeFileSync('.next/static/app.js','x'.repeat(500000))`)
    const regressed = await runJson()

    // The overall verdict is NOT asserted on either run. On the clean side it depends on two
    // timed builds landing within the floor, which machine load moves — the same flaw this test
    // was already rewritten once to remove, left standing one layer down. What IS asserted is the
    // byte row, which is deterministic: 5 KB to 500 KB is a regression on any machine.
    const bundleRow = (json: string) =>
      JSON.parse(json).comparison.metrics.find((m: { id: string }) => m.id === 'client_bundle_size')
    expect(bundleRow(clean).verdict).toBe('no_change')
    expect(bundleRow(regressed).verdict).toBe('regressed')

    for (const [name, stdout] of [['clean', clean], ['regressed', regressed]] as const) {
      expect(stdout, name).not.toContain('sk-secret-from-vault')
      expect(stdout, name).not.toContain('op://')
      expect(stdout, name).not.toContain('printf sk-secret')
    }
  }, 180_000)
})
