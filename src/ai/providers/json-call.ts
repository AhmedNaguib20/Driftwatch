import { ProviderError } from './types.js'
import type { ChatRequest, Provider, TokenUsage } from './types.js'

/**
 * A validated JSON completion: call, parse, validate — one retry, then an honest failure.
 *
 * TWO different failures, two different retries (M9). A model that returned malformed JSON gets
 * the CORRECTIVE retry: shown its own output and what was wrong with it. A response the API cut
 * off at the output cap (`finish_reason: "length"`) gets a RAISED-CAP retry instead — re-sending
 * the identical request would produce the identical truncation, so it is never done. If the
 * doubled cap truncates too, the failure is named as truncation with both numbers, never as
 * "invalid JSON": one means the model cannot format, the other means we did not give it room.
 *
 * Transport-level and provider-agnostic: no prompt content lives here.
 */

/** How much more room the second attempt gets. One doubling, not a search. */
const TRUNCATION_RETRY_FACTOR = 2

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
  if (firstAttempt.ok && !first.truncated) {
    return { value: firstAttempt.value, tokens: first.tokens, model: first.model, retried: false }
  }

  // Truncation is decided by the API, before the parser gets an opinion: a cut-off response is
  // usually ALSO unparseable, and reporting it as "invalid JSON" is what hid this failure for two
  // milestones. The retry differs accordingly — more room, not more scolding.
  const second = first.truncated
    ? await provider.chat({ ...request, maxOutputTokens: request.maxOutputTokens * TRUNCATION_RETRY_FACTOR })
    : await provider.chat({
        ...request,
        user:
          `${request.user}\n\n` +
          `Your previous response was rejected: ${firstAttempt.ok ? 'unknown' : firstAttempt.problem}\n` +
          `Previous response:\n${first.text.slice(0, 2000)}\n\n` +
          `Respond again with ONLY the corrected JSON object.`,
      })

  const tokens = {
    input: first.tokens.input + second.tokens.input,
    output: first.tokens.output + second.tokens.output,
  }

  const secondAttempt = parseAndValidate(second.text, validate)
  if (secondAttempt.ok && !second.truncated) {
    return { value: secondAttempt.value, tokens, model: second.model, retried: true }
  }

  if (second.truncated) {
    const cap = first.truncated ? request.maxOutputTokens * TRUNCATION_RETRY_FACTOR : request.maxOutputTokens
    throw new ProviderError(
      'truncated',
      `${provider.name} response truncated at ${second.tokens.output} tokens (cap ${cap})` +
        (first.truncated ? ` — already retried once with the cap raised from ${request.maxOutputTokens}` : '') +
        `. The model ran out of room, not out of ability: raise the stage's output cap.`,
      tokens,
      second.model,
    )
  }

  throw new ProviderError(
    'malformed',
    `${provider.name} returned invalid JSON twice — last problem: ${secondAttempt.ok ? 'unknown' : secondAttempt.problem}; ` +
      `last response started: ${JSON.stringify(second.text.slice(0, 200))}`,
    tokens,
    second.model,
  )
}

function parseAndValidate<T>(
  text: string,
  validate: Validator<T>,
): { ok: true; value: T } | { ok: false; problem: string } {
  const raw = extractJson(text)
  if (raw === undefined) {
    return { ok: false, problem: 'the response was not parseable JSON' }
  }
  return validate(raw)
}

/**
 * Models intermittently wrap JSON in markdown fences or prose despite json-mode — observed live
 * on the first M2 acceptance run. Tolerant extraction is provider-agnostic (any model does this):
 * try the raw text, then a \`\`\`json fence, then the outermost braces. The validator still
 * applies unchanged to whatever is extracted — tolerance in locating the JSON, never in its shape.
 */
function extractJson(text: string): unknown {
  const candidates = [text]

  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  if (fence?.[1]) candidates.push(fence[1])

  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1))

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch {
      /* next candidate */
    }
  }
  return undefined
}
