import { describe, expect, it, vi } from 'vitest'

import {
  ProviderError,
  createProvider,
  jsonCall,
  openAiCompatibleProvider,
  resolveApiKey,
} from '../src/ai/providers/index.js'
import type { ChatRequest } from '../src/ai/providers/index.js'

const REQUEST: ChatRequest = {
  system: 'You are a test.',
  user: 'Return JSON.',
  maxOutputTokens: 100,
  temperature: 0,
  timeoutMs: 5000,
}

function okPayload(content: string, tokens = { prompt_tokens: 100, completion_tokens: 20 }) {
  return new Response(
    JSON.stringify({
      model: 'deepseek-chat',
      choices: [{ message: { content } }],
      usage: tokens,
    }),
    { status: 200 },
  )
}

function providerWith(fetchImpl: typeof fetch) {
  return openAiCompatibleProvider({
    name: 'deepseek',
    baseUrl: 'https://api.test',
    model: 'deepseek-chat',
    apiKey: 'sk-test-secret',
    fetchImpl,
  })
}

describe('openai-compatible client', () => {
  it('sends the request in OpenAI shape and reports token usage', async () => {
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.test/chat/completions')
      const body = JSON.parse(init!.body as string)
      expect(body.messages).toEqual([
        { role: 'system', content: 'You are a test.' },
        { role: 'user', content: 'Return JSON.' },
      ])
      expect(body.response_format).toEqual({ type: 'json_object' })
      expect(body.temperature).toBe(0)
      return okPayload('{"answer":42}')
    }) as unknown as typeof fetch

    const response = await providerWith(fetchImpl).chat(REQUEST)

    expect(response.text).toBe('{"answer":42}')
    expect(response.tokens).toEqual({ input: 100, output: 20 })
    expect(response.model).toBe('deepseek-chat')
  })

  it('keeps the API key in the auth header and out of the body', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const headers = init!.headers as Record<string, string>
      expect(headers.authorization).toBe('Bearer sk-test-secret')
      expect(init!.body as string).not.toContain('sk-test-secret')
      return okPayload('{}')
    }) as unknown as typeof fetch

    await providerWith(fetchImpl).chat(REQUEST)
  })

  it('surfaces auth failures as their own kind — and without the key in the message', async () => {
    const fetchImpl = vi.fn(async () => new Response('unauthorized', { status: 401 })) as unknown as typeof fetch

    const error = await providerWith(fetchImpl).chat(REQUEST).catch((e: ProviderError) => e)

    expect(error).toBeInstanceOf(ProviderError)
    expect((error as ProviderError).kind).toBe('auth')
    expect((error as ProviderError).message).not.toContain('sk-test-secret')
  })

  it('times out via abort and says how long it waited', async () => {
    const fetchImpl = vi.fn(
      (_url: string | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    ) as unknown as typeof fetch

    const provider = providerWith(fetchImpl)
    const error = await provider
      .chat({ ...REQUEST, timeoutMs: 50 })
      .catch((e: ProviderError) => e)

    expect((error as ProviderError).kind).toBe('timeout')
    expect((error as ProviderError).message).toMatch(/50ms/)
  })

  it('reports HTTP errors with a body snippet', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"error":"rate limited"}', { status: 429 })) as unknown as typeof fetch

    const error = await providerWith(fetchImpl).chat(REQUEST).catch((e: ProviderError) => e)

    expect((error as ProviderError).kind).toBe('http')
    expect((error as ProviderError).message).toMatch(/429/)
    expect((error as ProviderError).message).toMatch(/rate limited/)
  })

  it('flags an empty completion as malformed', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ choices: [] }), { status: 200 })) as unknown as typeof fetch

    const error = await providerWith(fetchImpl).chat(REQUEST).catch((e: ProviderError) => e)

    expect((error as ProviderError).kind).toBe('malformed')
  })
})

describe('jsonCall — validate + one corrective retry', () => {
  type Out = { answer: number }
  const validate = (raw: unknown) => {
    const record = raw as { answer?: unknown }
    return typeof record?.answer === 'number'
      ? ({ ok: true, value: record as Out } as const)
      : ({ ok: false, problem: 'missing numeric "answer"' } as const)
  }

  it('passes through valid JSON without retrying', async () => {
    const fetchImpl = vi.fn(async () => okPayload('{"answer": 7}')) as unknown as typeof fetch

    const result = await jsonCall(providerWith(fetchImpl), REQUEST, validate)

    expect(result.value.answer).toBe(7)
    expect(result.retried).toBe(false)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('retries once with the problem named, and sums token usage', async () => {
    let calls = 0
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      calls += 1
      if (calls === 1) return okPayload('not json at all')
      const body = JSON.parse(init!.body as string)
      expect(body.messages[1].content).toMatch(/was rejected: the response was not parseable JSON/)
      return okPayload('{"answer": 7}', { prompt_tokens: 150, completion_tokens: 30 })
    }) as unknown as typeof fetch

    const result = await jsonCall(providerWith(fetchImpl), REQUEST, validate)

    expect(result.value.answer).toBe(7)
    expect(result.retried).toBe(true)
    expect(result.tokens).toEqual({ input: 250, output: 50 })
  })

  it('fails honestly after the second malformed response', async () => {
    const fetchImpl = vi.fn(async () => okPayload('{"answer": "still wrong"}')) as unknown as typeof fetch

    const error = await jsonCall(providerWith(fetchImpl), REQUEST, validate).catch((e: ProviderError) => e)

    expect((error as ProviderError).kind).toBe('malformed')
    expect((error as ProviderError).message).toMatch(/missing numeric "answer"/)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})

describe('key resolution and provider registry', () => {
  it('reads DRIFTWATCH_API_KEY and nothing else', () => {
    expect(resolveApiKey({ DRIFTWATCH_API_KEY: ' sk-x ' })).toBe('sk-x')
    expect(resolveApiKey({ DEEPSEEK_API_KEY: 'sk-y' })).toBeNull()
    expect(resolveApiKey({})).toBeNull()
  })

  it('constructs known vendors and refuses unknown ones by name', () => {
    expect(createProvider({ provider: 'deepseek', model: 'm', apiKey: 'k' }).name).toBe('deepseek')
    expect(() => createProvider({ provider: 'grok', model: 'm', apiKey: 'k' })).toThrow(/deepseek, openai/)
  })
})
