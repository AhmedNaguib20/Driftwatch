import { ProviderError } from './types.js'
import type { ChatRequest, ChatResponse, Provider } from './types.js'

/**
 * One client for every OpenAI-compatible chat-completions API — DeepSeek and OpenAI both speak
 * it (spec §7.1), so the vendor difference reduces to a base URL, a model name, and a key.
 *
 * The API key travels in the Authorization header and exists only here and in the caller's env.
 * It is never logged, never serialized, never part of any thrown message (hard rule 6).
 */

export interface OpenAiCompatibleOptions {
  readonly name: string
  readonly baseUrl: string
  readonly model: string
  readonly apiKey: string
  /** Injectable for tests — unit tests must never touch the network. */
  readonly fetchImpl?: typeof fetch
}

export function openAiCompatibleProvider(options: OpenAiCompatibleOptions): Provider {
  const doFetch = options.fetchImpl ?? fetch

  return {
    name: options.name,
    model: options.model,

    async chat(request: ChatRequest): Promise<ChatResponse> {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), request.timeoutMs)

      let response: Response
      try {
        response = await doFetch(`${options.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify({
            model: options.model,
            messages: [
              { role: 'system', content: request.system },
              { role: 'user', content: request.user },
            ],
            response_format: { type: 'json_object' },
            max_tokens: request.maxOutputTokens,
            temperature: request.temperature,
            stream: false,
          }),
          signal: controller.signal,
        })
      } catch (error) {
        if (controller.signal.aborted) {
          throw new ProviderError('timeout', `${options.name} did not respond within ${request.timeoutMs}ms`)
        }
        throw new ProviderError('network', `could not reach ${options.name}: ${(error as Error).message}`)
      } finally {
        clearTimeout(timer)
      }

      if (response.status === 401 || response.status === 403) {
        throw new ProviderError('auth', `${options.name} rejected the API key (HTTP ${response.status})`)
      }
      if (!response.ok) {
        const body = (await response.text().catch(() => '')).slice(0, 300)
        throw new ProviderError('http', `${options.name} returned HTTP ${response.status}${body ? `: ${body}` : ''}`)
      }

      const payload = (await response.json().catch(() => null)) as CompletionsPayload | null
      const text = payload?.choices?.[0]?.message?.content
      if (typeof text !== 'string' || text.length === 0) {
        throw new ProviderError('malformed', `${options.name} returned a response with no message content`)
      }

      return {
        text,
        model: payload?.model ?? options.model,
        tokens: {
          input: payload?.usage?.prompt_tokens ?? 0,
          output: payload?.usage?.completion_tokens ?? 0,
        },
        // OpenAI-compatible APIs report "length" when the response hit maxOutputTokens.
        truncated: payload?.choices?.[0]?.finish_reason === 'length',
      }
    },
  }
}

interface CompletionsPayload {
  model?: string
  choices?: { message?: { content?: string }; finish_reason?: string }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}
