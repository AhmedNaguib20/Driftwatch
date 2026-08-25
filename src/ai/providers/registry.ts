import { openAiCompatibleProvider } from './openai-compatible.js'
import type { Provider } from './types.js'

/**
 * Provider construction. The key ARRIVES here — it is never resolved here.
 *
 * `src/core/key.ts` owns resolution (env, `key_command`, per-provider fallbacks) and is the only
 * place that answers "is a key available?". This file used to answer it too, reading
 * DRIFTWATCH_API_KEY alone; after step A that answer was both duplicated and wrong (it returned
 * null for a user whose DEEPSEEK_API_KEY was set). Deleted rather than kept in sync: a second
 * answer to that question is how surfaces start disagreeing (spec §9c).
 */

export interface ProviderConfig {
  readonly provider: string
  readonly model: string
  readonly apiKey: string
  readonly fetchImpl?: typeof fetch
}

/** Vendors we can construct. Unknown names fail with the list — no silent fallback to a default. */
const VENDORS: Record<string, { baseUrl: string }> = {
  deepseek: { baseUrl: 'https://api.deepseek.com' },
  openai: { baseUrl: 'https://api.openai.com/v1' },
}

export function createProvider(config: ProviderConfig): Provider {
  const vendor = VENDORS[config.provider]
  if (!vendor) {
    throw new Error(
      `unknown AI provider "${config.provider}" — supported: ${Object.keys(VENDORS).join(', ')}`,
    )
  }
  return openAiCompatibleProvider({
    name: config.provider,
    baseUrl: vendor.baseUrl,
    model: config.model,
    apiKey: config.apiKey,
    fetchImpl: config.fetchImpl,
  })
}
