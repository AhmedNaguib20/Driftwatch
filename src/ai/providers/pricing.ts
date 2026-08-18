import type { TokenUsage } from './types.js'

/**
 * Published per-million-token prices, used ONLY to show the user an estimated cost — BYOK means
 * they are paying it (spec §11). Estimates, labelled as such: prices drift, caching discounts
 * are not modelled. Unknown models render as "cost unknown", never a guessed number (rule 3).
 * Pricing is vendor detail and stays inside providers/ (spec §7.1).
 */
const USD_PER_MILLION: Record<string, { input: number; output: number }> = {
  // DeepSeek bills time-of-day rates (off-peak is half); these are PEAK cache-miss rates — the
  // upper bound, so the estimate can only overstate. Source: api-docs.deepseek.com, 2026-08-19.
  'deepseek:deepseek-v4-flash': { input: 0.44, output: 1.32 },
  'deepseek:deepseek-v4-pro': { input: 1.32, output: 3.96 },
  // Alias ids, in case the API reports the alias rather than the served model.
  'deepseek:deepseek-chat': { input: 0.44, output: 1.32 },
  'deepseek:deepseek-reasoner': { input: 1.32, output: 3.96 },
  'openai:gpt-4o-mini': { input: 0.15, output: 0.6 },
}

export function estimateCostUsd(provider: string, model: string, tokens: TokenUsage): number | null {
  const rates = USD_PER_MILLION[`${provider}:${model}`]
  if (!rates) return null
  return (tokens.input * rates.input + tokens.output * rates.output) / 1_000_000
}
