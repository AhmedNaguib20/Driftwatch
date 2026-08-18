import { ProviderError } from './types.js'
import type { ChatRequest, Provider, TokenUsage } from './types.js'

/**
 * A validated JSON completion: call, parse, validate — one corrective retry on malformed output,
 * then an honest failure. The validator returns the typed value or a string naming what is wrong;
 * on retry the model is shown its own output and that message. Transport-level and provider-
 * agnostic: no prompt content lives here.
 */

export interface JsonCallResult<T> {
  readonly value: T
  readonly tokens: TokenUsage
  readonly model: string
  readonly retried: boolean
}

export type Validator<T> = (raw: unknown) => { ok: true; value: T } | { ok: false; problem: string }

export async function jsonCall<T>(
  provider: Provider,
  request: ChatRequest,
  validate: Validator<T>,
): Promise<JsonCallResult<T>> {
  const first = await provider.chat(request)
  const firstAttempt = parseAndValidate(first.text, validate)
  if (firstAttempt.ok) {
    return { value: firstAttempt.value, tokens: first.tokens, model: first.model, retried: false }
  }

  const corrective: ChatRequest = {
    ...request,
    user:
      `${request.user}\n\n` +
      `Your previous response was rejected: ${firstAttempt.problem}\n` +
      `Previous response:\n${first.text.slice(0, 2000)}\n\n` +
      `Respond again with ONLY the corrected JSON object.`,
  }
  const second = await provider.chat(corrective)
  const tokens = {
    input: first.tokens.input + second.tokens.input,
    output: first.tokens.output + second.tokens.output,
  }

  const secondAttempt = parseAndValidate(second.text, validate)
  if (secondAttempt.ok) {
    return { value: secondAttempt.value, tokens, model: second.model, retried: true }
  }

  throw new ProviderError(
    'malformed',
    `${provider.name} returned invalid JSON twice — last problem: ${secondAttempt.problem}`,
  )
}

function parseAndValidate<T>(
  text: string,
  validate: Validator<T>,
): { ok: true; value: T } | { ok: false; problem: string } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, problem: 'the response was not parseable JSON' }
  }
  return validate(raw)
}
