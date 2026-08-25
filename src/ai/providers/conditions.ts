/**
 * Named provider failures — one table, two consumers (spec §9e step D).
 *
 * `doctor` reports these at diagnosis time and a run that hits one mid-analysis degrades with the
 * SAME words, because a user who ran doctor yesterday and hit the failure today must not have to
 * work out that they are the same thing.
 *
 * **The conditions are provider-agnostic; the detection is not.** DeepSeek signals an empty
 * balance with HTTP 402 and its own message; OpenAI uses 429 with an `insufficient_quota` code on
 * the same underlying fact. That difference is vendor detail and stays inside this directory
 * (§7.1) — everything above the boundary sees `no_credit`.
 *
 * The default carries the provider's own words verbatim rather than inventing a category. A
 * wrong name is worse than no name: it sends someone to their billing page over a proxy problem.
 */

export type ProviderCondition = 'invalid_key' | 'no_credit' | 'rate_limited' | 'unknown_model' | 'unknown'

export interface NamedCondition {
  readonly condition: ProviderCondition
  /** One provider-agnostic line — what happened, in the user's terms. */
  readonly summary: string
  /** The provider's own message, verbatim and untouched. Null when it said nothing useful. */
  readonly providerText: string | null
  /** From `Retry-After`, when the provider gave one. */
  readonly retryAfterSeconds?: number
}

export interface ClassifyInput {
  readonly provider: string
  readonly status: number
  /** Raw body text — parsed here rather than by the caller, since the shape is vendor-specific. */
  readonly body: string
  readonly model: string
  readonly retryAfter?: string | null
}

export function classifyFailure(input: ClassifyInput): NamedCondition {
  const text = messageFrom(input.body)
  const lower = `${text ?? ''} ${input.body}`.toLowerCase()

  if (input.status === 401 || input.status === 403) {
    return { condition: 'invalid_key', summary: `${input.provider} rejected the API key`, providerText: text }
  }

  // DeepSeek: HTTP 402 with "Insufficient Balance". OpenAI: 429 carrying insufficient_quota —
  // the same fact wearing a rate-limit status code, which is exactly why this mapping is
  // per-vendor and the name is not.
  if (input.status === 402 || lower.includes('insufficient_quota') || lower.includes('insufficient balance')) {
    return {
      condition: 'no_credit',
      summary: `${input.provider} accepted the key but the account has no credit`,
      providerText: text,
    }
  }

  if (input.status === 429) {
    const seconds = Number(input.retryAfter)
    return {
      condition: 'rate_limited',
      summary: `${input.provider} is rate limiting this key`,
      providerText: text,
      ...(Number.isFinite(seconds) && seconds > 0 ? { retryAfterSeconds: seconds } : {}),
    }
  }

  // A model that does not exist, or that this account cannot call. Vendors disagree on the status
  // (400 and 404 both occur), so the payload decides.
  // Vendors phrase this every way: "Model Not Exist" (DeepSeek), "The model `x` does not exist"
  // (OpenAI), "model not found". Matching the shapes rather than one vendor's sentence.
  if (
    lower.includes('model') &&
    (lower.includes('not found') || lower.includes('not exist') || lower.includes('unknown model') || lower.includes('invalid model') || lower.includes('no such model'))
  ) {
    return {
      condition: 'unknown_model',
      summary: `${input.provider} does not serve "${input.model}" for this account`,
      providerText: text,
    }
  }

  return {
    condition: 'unknown',
    summary: `${input.provider} returned HTTP ${input.status}`,
    providerText: text ?? (input.body.trim() ? input.body.trim().slice(0, 300) : null),
  }
}

export interface StanzaContext {
  readonly provider: string
  readonly model: string
  /**
   * Where the key came from, in words, supplied by the caller — core owns key resolution and this
   * layer never reads it. "the key from DEEPSEEK_API_KEY was rejected" and "your key_command's
   * output was rejected" are different debugging sessions.
   */
  readonly keySourceLabel: string | null
}

/** Billing and key pages, per vendor — the exact page, never "check your account". */
const CONSOLE: Record<string, { readonly keys: string; readonly billing: string }> = {
  deepseek: { keys: 'https://platform.deepseek.com/api_keys', billing: 'https://platform.deepseek.com/top_up' },
  openai: { keys: 'https://platform.openai.com/api-keys', billing: 'https://platform.openai.com/settings/organization/billing' },
}

/** The remedy for a named condition: what to do, never "check your setup". */
export function conditionStanza(named: NamedCondition, context: StanzaContext): string {
  const links = CONSOLE[context.provider]
  const from = context.keySourceLabel ? ` The key came from ${context.keySourceLabel}.` : ''

  switch (named.condition) {
    case 'invalid_key':
      return [
        `The key was refused, so it is wrong, revoked, or from a different account.${from}`,
        '',
        ...(links ? [`Issue a new one at ${links.keys}, then replace it where it comes from:`, ''] : ['Issue a new key, then replace it where it comes from:', '']),
        '    export DRIFTWATCH_API_KEY=<the new key>',
        '',
        'Treat the old one as compromised if it was ever committed or pasted anywhere.',
      ].join('\n')

    case 'no_credit':
      return [
        'The key is valid — the account simply has no balance, so no request will succeed until',
        'it is topped up. Measurement is unaffected and keeps working without a key at all.',
        '',
        ...(links ? [`    ${links.billing}`, ''] : []),
        'This one cost driftwatch a day of M6 acceptance before it was named.',
      ].join('\n')

    case 'rate_limited':
      return [
        named.retryAfterSeconds !== undefined
          ? `The provider asked for ${named.retryAfterSeconds}s before the next request.`
          : 'The provider did not say how long to wait.',
        '',
        'Driftwatch does not queue or retry across runs — re-run when it clears. If this happens',
        'on every push, the account\'s rate limit is below what your CI produces: raise the limit',
        'with the provider, or set `max_cost_per_run` and analyse fewer runs.',
      ].join('\n')

    case 'unknown_model':
      return [
        `"${context.model}" is not a model this account can call. It may be misspelled, retired,`,
        'or gated behind a tier your account does not have.',
        '',
        '    model: <a model your account serves>    # in perf.yml',
        '',
        '`driftwatch doctor` reports which model actually served a call, including when a name is',
        'an alias for something else.',
      ].join('\n')

    case 'unknown':
      return [
        'Driftwatch has no named remedy for this one, so it is passing on exactly what the',
        'provider said rather than guessing at a category.',
        '',
        'DRIFTWATCH_DEBUG_WIRE=1 prints what crossed the wire — the key is never among it.',
      ].join('\n')
  }
}

/** The vendor's message, dug out of whichever envelope it used. */
function messageFrom(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string; message?: string }
    const message =
      typeof parsed.error === 'string' ? parsed.error : (parsed.error?.message ?? parsed.message)
    return typeof message === 'string' && message.trim() ? message.trim() : null
  } catch {
    return body.trim() ? body.trim().slice(0, 300) : null
  }
}
