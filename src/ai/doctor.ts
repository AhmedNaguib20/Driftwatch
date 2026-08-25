import { DEEP_BUDGET_TOKENS, TRIAGE_BUDGET_TOKENS } from './analyse/budget.js'
import { DEEP_MAX_OUTPUT, TRIAGE_MAX_OUTPUT } from './analyse/run-analysis.js'
import { estimateCostUsd } from './providers/pricing.js'
import { createProvider } from './providers/index.js'
import { ProviderError } from './providers/index.js'
import type { DoctorCheck } from '../core/index.js'

/**
 * The provider half of `driftwatch doctor` — the checks that need the network.
 *
 * **One call, several facts.** Reachability, the served model and a real token count all come
 * from a single minimal completion rather than three probes: it is the cheapest honest way to
 * answer "would an analysis work right now?", and every number it reports was actually measured.
 *
 * This module is imported only after a key has been found, so a keyless `doctor` never loads the
 * AI module graph (hard rule 6).
 */

const MINIMAL_CALL = {
  system: 'You are a health check. Reply with JSON only.',
  user: 'Reply with exactly {"ok":true} and nothing else.',
  /** Generous enough that a chatty model is not truncated into a false failure. */
  maxOutputTokens: 64,
  temperature: 0,
  timeoutMs: 20_000,
}

export interface ProviderCheckOptions {
  readonly provider: string
  readonly model: string
  readonly key: string
  readonly fetchImpl?: typeof fetch
}

export async function providerChecks(options: ProviderCheckOptions): Promise<DoctorCheck[]> {
  const { provider, model } = options
  let client
  try {
    client = createProvider({
      provider,
      model,
      apiKey: options.key,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    })
  } catch (error) {
    return [
      {
        id: 'provider',
        label: 'provider',
        state: 'fail',
        detail: (error as Error).message,
        fix: 'Set `provider:` in perf.yml to one of the supported vendors.',
      },
    ]
  }

  try {
    const response = await client.chat(MINIMAL_CALL)
    return [
      { id: 'provider', label: 'provider', state: 'ok', detail: `${provider} reachable, key accepted` },
      servedModelCheck(model, response.model),
      {
        id: 'call',
        label: 'minimal call',
        state: 'ok',
        detail: `succeeded — ${response.tokens.input} in / ${response.tokens.output} out, ${money(
          estimateCostUsd(provider, response.model, response.tokens),
        )}`,
      },
      typicalCostCheck(provider, response.model),
    ]
  } catch (error) {
    return [failureFrom(error, provider), typicalCostCheck(provider, model)]
  }
}

/**
 * The served model can differ from the one asked for — an alias resolving to whatever the vendor
 * currently points it at. We learned this at M6, when `deepseek-chat` was served as
 * `deepseek-v4-flash`: prompts tuned against one model were being graded against another, and
 * nothing said so. Reported as a warn, never a failure: it works, it is just not what was asked.
 */
function servedModelCheck(requested: string, served: string): DoctorCheck {
  if (served === requested) {
    return { id: 'model', label: 'model', state: 'ok', detail: `${requested} exists and served the call` }
  }
  return {
    id: 'model',
    label: 'model',
    state: 'warn',
    detail: `requested "${requested}", served by "${served}" — an alias, and the served model is what your analysis and its cost will actually be`,
    fix: `Pin it if that matters:  model: ${served}   (in perf.yml)`,
  }
}

/**
 * What a real analysis costs, stated as a ceiling from the constants that actually bound it —
 * the two context budgets and the two output caps (spec §9e). Not a guessed "typical": a bound
 * the code enforces, plus the largest figure the eval set has actually measured.
 */
function typicalCostCheck(provider: string, model: string): DoctorCheck {
  const ceiling = estimateCostUsd(provider, model, {
    input: TRIAGE_BUDGET_TOKENS + DEEP_BUDGET_TOKENS,
    output: TRIAGE_MAX_OUTPUT + DEEP_MAX_OUTPUT,
  })
  const basis = `context budgets ${TRIAGE_BUDGET_TOKENS.toLocaleString()} + ${DEEP_BUDGET_TOKENS.toLocaleString()} in, output caps ${TRIAGE_MAX_OUTPUT.toLocaleString()} + ${DEEP_MAX_OUTPUT.toLocaleString()} out`
  return {
    id: 'cost',
    label: 'analysis cost',
    state: 'info',
    detail:
      ceiling === null
        ? `unknown for ${model} — driftwatch has no published price for it, and will report "cost unknown" rather than a guess`
        : `at most ${money(ceiling)} per analysed regression (${basis}); the largest eval case, a 31-file diff, measured $0.0130`,
  }
}

function failureFrom(error: unknown, provider: string): DoctorCheck {
  const kind = error instanceof ProviderError ? error.kind : 'http'
  const message = error instanceof Error ? error.message.split('\n')[0]! : String(error)

  // A response that arrived and was merely unparseable still proves reachability and a served
  // model — the opposite of a connectivity problem, and reporting it as one would send the user
  // to their firewall over a chatty model.
  if (kind === 'malformed' || kind === 'truncated') {
    return {
      id: 'provider',
      label: 'provider',
      state: 'warn',
      detail: `${provider} reachable and the key was accepted, but the health-check reply was not clean JSON (${message})`,
    }
  }

  return {
    id: 'provider',
    label: 'provider',
    state: 'fail',
    detail: `${provider} call failed (${kind}): ${message}`,
    // Named errors with their own stanzas are step D; until then the provider's own words plus
    // where to look beats a stanza that guesses which failure this was.
    fix: [
      'The message above is the provider\'s own. Check, in this order:',
      '',
      '  · the key is valid and has credit',
      '  · the model name in perf.yml is one your account can call',
      '  · the machine can reach the provider (proxy, firewall, offline)',
      '',
      'DRIFTWATCH_DEBUG_WIRE=1 prints what crossed the wire, with the key never among it.',
    ].join('\n'),
  }
}

/** A real charge below the displayed precision reads as free at $0.0000, which it is not. */
function money(usd: number | null): string {
  if (usd === null) return 'cost unknown'
  if (usd > 0 && usd < 0.0001) return 'under $0.0001'
  return `$${usd.toFixed(4)}`
}
