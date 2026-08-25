import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

import { keyChecks, reportFrom } from '../src/core/index.js'
import type { ResolvedKey } from '../src/core/index.js'
import { providerChecks } from '../src/ai/doctor.js'
import { render } from '../src/cli/doctor-command.js'

/**
 * `driftwatch doctor` (spec §9e step B). It reports; it never fixes and never writes.
 *
 * Two things are load-bearing and tested hardest:
 *  - **no key exits 0.** The free tier is not a degraded state, and a diagnostic that paints it
 *    red is telling a user they have a problem they do not have.
 *  - **nothing sensitive is printed**, ever: not the key, and not the vault path that names where
 *    the key lives — a diagnostic is the output most likely to end up pasted into an issue.
 */

const KEY = 'sk-secret-value-nobody-should-see-1234'
const VAULT = 'op read op://vault/deepseek/key'

const found = (source: ResolvedKey['source']): ResolvedKey => ({ key: KEY, source, problem: null })

/** An OpenAI-compatible reply, with the served model under our control. */
function fakeFetch(payload: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
}

const OK_PAYLOAD = (model: string) => ({
  model,
  choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 24, completion_tokens: 8 },
})

const runProvider = (fetchImpl: typeof fetch, model = 'deepseek-chat') =>
  providerChecks({ provider: 'deepseek', model, key: KEY, fetchImpl })

describe('the key checks', () => {
  it('no key is INFO, exits 0, and describes the free tier from the matrix', () => {
    const checks = keyChecks({ key: null, source: { kind: 'none' }, problem: null }, 'deepseek')
    const report = reportFrom(checks, false)

    expect(report.exitCode).toBe(0)
    expect(checks[0]!.state).toBe('info')
    // The list comes from tier.ts, not a second copy maintained here.
    expect(checks[0]!.fix).toContain('trends, dashboard, drift alerting')
    expect(checks[0]!.fix).toContain('DRIFTWATCH_API_KEY')

    const rendered = render(report)
    expect(rendered).toContain('a choice, not a fault')
    expect(rendered).not.toContain('✗')
    // Exactly one mention of how to turn the tier on.
    expect([...rendered.matchAll(/export DRIFTWATCH_API_KEY/g)]).toHaveLength(1)
  })

  it('a key found in the environment is ok, and names which variable', () => {
    const checks = keyChecks(found({ kind: 'env', name: 'DEEPSEEK_API_KEY' }), 'deepseek')

    expect(checks[0]!.state).toBe('ok')
    expect(checks[0]!.detail).toContain('DEEPSEEK_API_KEY')
    expect(reportFrom(checks, true).exitCode).toBe(0)
  })

  it('a CONFIGURED source that produced nothing FAILS — that is not the free tier', () => {
    const checks = keyChecks(
      { key: null, source: { kind: 'key_command', command: VAULT }, problem: 'key_command failed: not signed in' },
      'deepseek',
    )
    const report = reportFrom(checks, false)

    expect(checks[0]!.state).toBe('fail')
    expect(report.exitCode).toBe(1)
    // The command's own first line is what tells the user what to do.
    expect(checks[0]!.detail).toContain('not signed in')
    expect(checks[0]!.fix).toBeTruthy()
  })
})

describe('redaction', () => {
  it('never prints the key, and never prints the vault path', () => {
    const rendered = [
      render(reportFrom(keyChecks(found({ kind: 'key_command', command: VAULT }), 'deepseek'), true)),
      render(
        reportFrom(
          keyChecks(
            { key: null, source: { kind: 'key_command', command: VAULT }, problem: 'key_command failed: not signed in' },
            'deepseek',
          ),
          false,
        ),
      ),
    ].join('\n')

    expect(rendered).not.toContain(KEY)
    expect(rendered).not.toContain('op://')
    expect(rendered).not.toContain(VAULT)
    // It still says where the key came from — redaction is not silence.
    expect(rendered).toContain('key_command in perf.yml')
  })
})

describe('the provider checks — one minimal call, several facts', () => {
  it('reachable, model as requested, real tokens and a cost', async () => {
    const checks = await runProvider(fakeFetch(OK_PAYLOAD('deepseek-chat')))
    const by = (id: string) => checks.find((c) => c.id === id)!

    expect(by('provider').state).toBe('ok')
    expect(by('model').state).toBe('ok')
    expect(by('call').state).toBe('ok')
    expect(by('call').detail).toContain('24 in / 8 out')
    // A charge below the displayed precision is said in words: $0.0000 would read as free.
    expect(by('call').detail).toContain('under $0.0001')
    expect(reportFrom(checks, true).exitCode).toBe(0)
  })

  it('surfaces a served model that differs from the requested one', async () => {
    // The M6 lesson: `deepseek-chat` served as `deepseek-v4-flash`, silently.
    const checks = await runProvider(fakeFetch(OK_PAYLOAD('deepseek-v4-flash')), 'deepseek-chat')
    const model = checks.find((c) => c.id === 'model')!

    expect(model.state).toBe('warn')
    expect(model.detail).toContain('deepseek-chat')
    expect(model.detail).toContain('deepseek-v4-flash')
    expect(model.fix).toContain('model: deepseek-v4-flash')
    // A warning is not a failure: the tier works, it is just not what was asked for.
    expect(reportFrom(checks, true).exitCode).toBe(0)
  })

  it('an auth failure fails with the NAMED condition and its remedy (step D)', async () => {
    const checks = await runProvider(fakeFetch({ error: 'nope' }, 401))
    const provider = checks.find((c) => c.id === 'provider')!

    expect(provider.state).toBe('fail')
    expect(provider.detail).toContain('rejected the API key')
    // The remedy is the exact one, not advice: where to get a new key, and where to put it.
    expect(provider.fix).toContain('platform.deepseek.com/api_keys')
    expect(provider.fix).toContain('export DRIFTWATCH_API_KEY=')
    expect(reportFrom(checks, true).exitCode).toBe(1)
  })

  it('an unclassifiable failure still fails, with the provider\'s words and the wire flag', async () => {
    const checks = await runProvider(fakeFetch({ error: { message: 'gateway exploded' } }, 503))
    const provider = checks.find((c) => c.id === 'provider')!

    expect(provider.state).toBe('fail')
    expect(provider.detail).toContain('gateway exploded')
    expect(provider.fix).toContain('DRIFTWATCH_DEBUG_WIRE=1')
  })

  it('a reachable provider with an unparseable reply WARNS — it is not a connectivity problem', async () => {
    const checks = await runProvider(fakeFetch({ model: 'deepseek-chat', choices: [{ message: {} }] }))
    const provider = checks.find((c) => c.id === 'provider')!

    expect(provider.state).toBe('warn')
    expect(provider.detail).toContain('reachable')
    expect(reportFrom(checks, true).exitCode).toBe(0)
  })

  it('states the analysis cost as a ceiling with the constants it comes from', async () => {
    const cost = (await runProvider(fakeFetch(OK_PAYLOAD('deepseek-chat')))).find((c) => c.id === 'cost')!

    expect(cost.state).toBe('info')
    expect(cost.detail).toContain('at most')
    // The basis is named, not implied: budgets in, caps out.
    expect(cost.detail).toContain('8,000')
    expect(cost.detail).toContain('24,000')
    expect(cost.detail).toContain('3,200')
    expect(cost.detail).toContain('6,000')
    expect(cost.detail).toContain('31-file diff')
  })

  it('says "cost unknown" for a model it has no published price for, never a guess', async () => {
    const checks = await runProvider(fakeFetch(OK_PAYLOAD('some-new-model')), 'some-new-model')
    const cost = checks.find((c) => c.id === 'cost')!

    expect(cost.detail).toContain('cost unknown')
    expect(cost.detail).not.toMatch(/\$\d/)
  })

  it('still reports the cost ceiling when the call itself failed', async () => {
    const checks = await runProvider(fakeFetch({ error: 'nope' }, 500))

    expect(checks.find((c) => c.id === 'provider')!.state).toBe('fail')
    expect(checks.find((c) => c.id === 'cost')).toBeTruthy()
  })
})

describe('the command end to end (no network: there is no key)', () => {
  const exec = promisify(execFile)
  const temps: string[] = []
  afterEach(async () => {
    await Promise.all(temps.splice(0).map((d) => rm(d, { recursive: true, force: true })))
  })

  async function project(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'driftwatch-doctor-'))
    temps.push(dir)
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'p' }), 'utf8')
    await writeFile(path.join(dir, 'next.config.mjs'), 'export default {}\n', 'utf8')
    return dir
  }

  const cli = async (args: string[]) => {
    const env = { ...process.env }
    for (const name of ['DRIFTWATCH_API_KEY', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) {
      delete env[name]
    }
    try {
      const { stdout } = await exec('node', [path.join(import.meta.dirname, '..', 'dist', 'cli', 'index.js'), ...args], { env })
      return { stdout, code: 0 }
    } catch (error) {
      const e = error as { code?: number; stdout?: string }
      return { stdout: e.stdout ?? '', code: e.code ?? 1 }
    }
  }

  it('exits 0 with no key, and --json carries the same content', async () => {
    const dir = await project()

    const human = await cli(['doctor', '--cwd', dir])
    expect(human.code).toBe(0)

    const json = await cli(['doctor', '--cwd', dir, '--json'])
    expect(json.code).toBe(0)
    const report = JSON.parse(json.stdout)
    expect(report.tierEnabled).toBe(false)
    expect(report.exitCode).toBe(0)
    expect(report.checks[0].id).toBe('key')
    expect(report.checks[0].state).toBe('info')
    // Every output identifies its build (spec v50).
    expect(report.build).toMatch(/driftwatch v/)
  }, 60_000)
})
