import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { classifyFailure, conditionStanza, createProvider, ProviderError } from '../src/ai/providers/index.js'
import type { NamedCondition } from '../src/ai/providers/index.js'
import { providerChecks } from '../src/ai/doctor.js'
import { runAnalysis } from '../src/ai/analyse/run-analysis.js'
import type { ResultJson } from '../src/core/index.js'

/**
 * Named provider errors (spec §9e step D) — one table, two consumers.
 *
 * The property that matters most is the last describe block: `doctor` and a run that fails
 * mid-analysis must produce the SAME named condition and the SAME remedy for the same failure. A
 * user who ran doctor yesterday and hit the failure today should not have to work out that they
 * are the same event.
 */

const KEY = 'sk-secret-nobody-should-see-0000'
const CONTEXT = { provider: 'deepseek', model: 'deepseek-chat', keySourceLabel: 'the DEEPSEEK_API_KEY environment variable' }

const classify = (status: number, body: unknown, extra: { retryAfter?: string } = {}) =>
  classifyFailure({
    provider: 'deepseek',
    status,
    body: typeof body === 'string' ? body : JSON.stringify(body),
    model: 'deepseek-chat',
    ...extra,
  })

describe('the error map', () => {
  it('401 is an invalid key, and the stanza says where the key came from', () => {
    const named = classify(401, { error: { message: 'Authentication Fails' } })
    expect(named.condition).toBe('invalid_key')
    expect(named.providerText).toBe('Authentication Fails')

    const stanza = conditionStanza(named, CONTEXT)
    expect(stanza).toContain('DEEPSEEK_API_KEY')
    expect(stanza).toContain('platform.deepseek.com/api_keys')
    expect(stanza).toContain('export DRIFTWATCH_API_KEY=')
  })

  it('402 is no credit — the one that cost us a day of M6 acceptance', () => {
    const named = classify(402, { error: { message: 'Insufficient Balance' } })
    expect(named.condition).toBe('no_credit')

    const stanza = conditionStanza(named, CONTEXT)
    // The exact page, not "check your account".
    expect(stanza).toContain('platform.deepseek.com/top_up')
    // And the reassurance that matters to a keyless-tier product.
    expect(stanza).toContain('Measurement is unaffected')
  })

  it('the same fact from OpenAI wears a different status and still lands on no_credit', () => {
    // OpenAI reports an empty balance as 429 + insufficient_quota. Provider-specific detection,
    // provider-agnostic name (§7.1).
    const named = classifyFailure({
      provider: 'openai',
      status: 429,
      body: JSON.stringify({ error: { message: 'You exceeded your current quota', code: 'insufficient_quota' } }),
      model: 'gpt-4o-mini',
    })
    expect(named.condition).toBe('no_credit')
  })

  it('429 is rate limiting, and carries retry-after when the provider gives one', () => {
    const withHeader = classify(429, { error: { message: 'Too Many Requests' } }, { retryAfter: '30' })
    expect(withHeader.condition).toBe('rate_limited')
    expect(withHeader.retryAfterSeconds).toBe(30)
    expect(conditionStanza(withHeader, CONTEXT)).toContain('30s')

    const without = classify(429, { error: { message: 'Too Many Requests' } })
    expect(without.retryAfterSeconds).toBeUndefined()
    expect(conditionStanza(without, CONTEXT)).toContain('did not say how long')
  })

  it('an unserved model is named, whatever status the vendor chose', () => {
    for (const status of [400, 404]) {
      const named = classify(status, { error: { message: 'Model Not Exist' } })
      expect(named.condition, String(status)).toBe('unknown_model')
    }
    expect(conditionStanza(classify(404, { error: { message: 'model does not exist' } }), CONTEXT)).toContain(
      'model: <a model your account serves>',
    )
  })

  it('anything else carries the provider\'s own words rather than inventing a category', () => {
    const named = classify(503, { error: { message: 'Upstream gateway exploded' } })

    expect(named.condition).toBe('unknown')
    expect(named.providerText).toBe('Upstream gateway exploded')
    expect(named.summary).toContain('HTTP 503')
    expect(conditionStanza(named, CONTEXT)).toContain('rather than guessing at a category')
  })

  it('survives a body that is not JSON at all', () => {
    const named = classify(502, '<html>Bad Gateway</html>')
    expect(named.condition).toBe('unknown')
    expect(named.providerText).toContain('Bad Gateway')
  })
})

describe('the transport attaches the condition', () => {
  const failing = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    createProvider({
      provider: 'deepseek',
      model: 'deepseek-chat',
      apiKey: KEY,
      fetchImpl: (async () =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })) as unknown as typeof fetch,
    })

  it('throws a ProviderError carrying the named condition, never the key', async () => {
    const error = await failing(402, { error: { message: 'Insufficient Balance' } })
      .chat({ system: 's', user: 'u', maxOutputTokens: 16, temperature: 0, timeoutMs: 5_000 })
      .then(() => null, (e: unknown) => e as ProviderError)

    expect(error).toBeInstanceOf(ProviderError)
    expect(error!.named?.condition).toBe('no_credit')
    expect(error!.message).toContain('Insufficient Balance')
    expect(JSON.stringify(error)).not.toContain(KEY)
    expect(error!.message).not.toContain(KEY)
  })
})

describe('both consumers say the same thing about the same failure', () => {
  const NO_CREDIT = { error: { message: 'Insufficient Balance' } }
  const fetchImpl = (async () =>
    new Response(JSON.stringify(NO_CREDIT), { status: 402, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch

  it('doctor and a mid-run failure produce the same condition and the same remedy', async () => {
    const label = 'the DEEPSEEK_API_KEY environment variable'

    // Consumer 1: diagnosis time.
    const checks = await providerChecks({
      provider: 'deepseek',
      model: 'deepseek-chat',
      key: KEY,
      keySourceLabel: label,
      fetchImpl,
    })
    const doctorCheck = checks.find((c) => c.id === 'provider')!

    // Consumer 2: the same failure hit halfway through a real run.
    const provider = createProvider({ provider: 'deepseek', model: 'deepseek-chat', apiKey: KEY, fetchImpl })
    const raw = await readFile(path.join(import.meta.dirname, 'golden', 'result-v1.json'), 'utf8')
    const result = JSON.parse(raw.replaceAll('<driftwatch-version>', '0.6.0')) as ResultJson
    const diffData = {
      diff: [
        {
          path: 'lib/posts.ts',
          insertions: 25,
          deletions: 2,
          binary: false,
          untracked: false,
          patch: 'diff --git a/lib/posts.ts b/lib/posts.ts\n+changed\n',
        },
      ],
      lockfileSummaries: [],
    }
    const analysis = await runAnalysis(result, diffData, provider, () => {}, label)

    expect(doctorCheck.state).toBe('fail')
    expect(analysis.outcome).toBe('skipped')
    if (analysis.outcome !== 'skipped') return

    // Same words, both places.
    const expected = conditionStanza(
      { condition: 'no_credit', summary: '', providerText: 'Insufficient Balance' } as NamedCondition,
      { provider: 'deepseek', model: 'deepseek-chat', keySourceLabel: label },
    )
    expect(doctorCheck.fix).toBe(expected)
    expect(analysis.fix).toBe(expected)
    expect(analysis.reason).toContain('Insufficient Balance')

    // And the run degrades rather than failing: the measurement verdict is not this module's to
    // touch, which is why analysis reports `skipped` instead of throwing.
    expect(analysis.reason).toContain('failed')
  })
})
