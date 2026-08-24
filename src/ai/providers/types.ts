/**
 * The provider boundary. Everything above it — prompts, triage/deep staging, rendering — speaks
 * these types only; nothing outside src/ai/providers/ knows which vendor ran (spec §7.1). A
 * provider is a JSON-completion transport: prompts in, strict-JSON text + token usage out.
 * Prompt content deliberately does NOT live here — a prompt tuned to one provider's quirks is
 * lock-in disguised as a saving.
 */

export interface ChatRequest {
  readonly system: string
  readonly user: string
  /** Hard cap on the response length. */
  readonly maxOutputTokens: number
  /** 0 for analysis: we want the model's best single answer, not variety. */
  readonly temperature: number
  readonly timeoutMs: number
}

export interface ChatResponse {
  readonly text: string
  readonly tokens: TokenUsage
  /** The model that actually served the call, as the API reports it. */
  readonly model: string
  /**
   * True when the API stopped because the OUTPUT CAP was reached (`finish_reason: "length"`) —
   * a transport fact, reported by the provider, never inferred from the text. It is the whole
   * distinction M9 exists for: a model that cannot format JSON is a different failure from a
   * model we did not give room to finish.
   */
  readonly truncated: boolean
}

export interface TokenUsage {
  readonly input: number
  readonly output: number
}

export interface Provider {
  /** Vendor id, e.g. 'deepseek'. Recorded in the result JSON so a reader knows what analysed. */
  readonly name: string
  readonly model: string
  /** One completion, JSON output mode enforced where the API supports it. Throws ProviderError. */
  chat(request: ChatRequest): Promise<ChatResponse>
}

export type ProviderErrorKind = 'auth' | 'http' | 'network' | 'timeout' | 'malformed' | 'truncated'

/**
 * Every provider failure surfaces as one of these — the analysis layer turns them into an
 * honest `skipped` with the reason, never a crashed run (errors never abort, CLAUDE.md).
 */
export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    /**
     * What the failed call cost. A call that failed still spent money and still used a prompt
     * version; discarding both hides the spend AND the provenance (spec v50). Absent only when
     * the failure happened before any tokens were billed (auth, network, timeout).
     */
    readonly tokens?: TokenUsage,
    readonly model?: string,
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}
