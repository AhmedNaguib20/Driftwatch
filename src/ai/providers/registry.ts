import { openAiCompatibleProvider } from './openai-compatible.js'
import type { Provider } from './types.js'

/**
 * Provider construction and key resolution.
 *
 * The key comes from DRIFTWATCH_API_KEY and nowhere else — never perf.yml (it gets committed),
 * never written to disk, never serialized into the result JSON (hard rule 6, BYOK). Absence of a
 * key is a normal state, not an error: the caller renders a one-line hint and moves on.
 */

export const API_KEY_ENV = 'DRIFTWATCH_API_KEY'

export function resolveApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const key = env[API_KEY_ENV]?.trim()
  return key ? key : null
}

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
