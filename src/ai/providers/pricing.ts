import type { TokenUsage } from './types.js'

/**
 * Published per-million-token prices, used ONLY to show the user an estimated cost — BYOK means
 * they are paying it (spec §11). Estimates, labelled as such: prices drift, caching discounts
 * are not modelled. Unknown models render as "cost unknown", never a guessed number (rule 3).
 * Pricing is vendor detail and stays inside providers/ (spec §7.1).
 */
const USD_PER_MILLION: Record<string, { input: number; output: number }> = {
  'deepseek:deepseek-chat': { input: 0.27, output: 1.1 },
  'deepseek:deepseek-reasoner': { input: 0.55, output: 2.19 },
  'openai:gpt-4o-mini': { input: 0.15, output: 0.6 },
}

export function estimateCostUsd(provider: string, model: string, tokens: TokenUsage): number | null {
  const rates = USD_PER_MILLION[`${provider}:${model}`]
  if (!rates) return null
  return (tokens.input * rates.input + tokens.output * rates.output) / 1_000_000
}
