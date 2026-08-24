/**
 * The feature matrix, as code (spec §9e, M11 step 1).
 *
 * **The promise being productised: driftwatch measures for free and forever without any API key.
 * AI explanation is an optional tier the user turns on with their own key.**
 *
 * That promise is only as good as its weakest surface, and the way it decays is by being encoded
 * twice — a renderer that assumes analysis is normal, a command that warns because a key is
 * absent, a README table that drifts from the code. So the matrix lives here once: every surface
 * asks this module, and the README is checked against it by a test.
 *
 * The rule for keyless surfaces is stronger than "it works": **it must not mention the tier at
 * all.** A user who never adds a key should see a complete tool, not a complete tool with an
 * advertisement stapled to every run. Exactly one situation earns a mention — a regression that
 * analysis could have explained — and it is stated once per surface, there.
 */

export type Tier = 'measurement' | 'ai'

export interface Capability {
  readonly id: string
  readonly label: string
  readonly tier: Tier
  /** For AI-tier capabilities: why a key is unavoidable, in the user's terms. */
  readonly why?: string
}

export const CAPABILITIES: readonly Capability[] = [
  { id: 'measure', label: 'measurement, comparison, verdicts, thresholds', tier: 'measurement' },
  { id: 'pr-surfaces', label: 'PR comment, CI check, step summary', tier: 'measurement' },
  { id: 'record', label: 'record, replay, movement report', tier: 'measurement' },
  { id: 'trend', label: 'trends, dashboard, drift alerting', tier: 'measurement' },
  {
    id: 'analysis',
    label: 'analysis (cause, confidence, evidence, suggested fix)',
    tier: 'ai',
    why: 'reading a diff and naming a cause is what the model does; there is nothing to measure it from',
  },
  {
    id: 'auto-fix',
    label: 'verified auto-fix PRs',
    tier: 'ai',
    why: 'a fix has to be suggested before it can be measured, and suggesting it is the analysis step',
  },
  {
    id: 'eval',
    label: '`driftwatch eval`',
    tier: 'ai',
    why: 'it grades live provider behaviour against the eval set',
  },
]

export function requiresAiTier(id: string): boolean {
  return CAPABILITIES.find((c) => c.id === id)?.tier === 'ai'
}

export function capabilitiesOf(tier: Tier): readonly Capability[] {
  return CAPABILITIES.filter((c) => c.tier === tier)
}

/** The one environment variable that turns the tier on. Key handling proper is M11 step 2. */
export const AI_KEY_ENV = 'DRIFTWATCH_API_KEY'

export function aiKeyPresent(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env[AI_KEY_ENV]?.trim())
}

/**
 * The single mention — the ONE thing every surface may say about the tier, and only on a
 * regression it could have explained.
 *
 * Returned as parts rather than prose so each surface can wear its own clothes (a dim terminal
 * stanza, an italic comment line) without inventing its own claim. `fixTier` is true when
 * `auto_fix: propose` is configured: the same key also unlocks the verified-fix PR, and saying
 * that in the same breath keeps it one mention rather than two.
 */
export interface TierMention {
  readonly what: string
  readonly how: string
}

export function tierMention(options: { readonly fixTier: boolean }): TierMention {
  const what = options.fixTier
    ? 'Analysis reads the diff, names the likely cause with its evidence, and suggests a fix — which driftwatch then measures before proposing it as a PR.'
    : 'Analysis reads the diff and names the likely cause, with a suggested fix.'
  return { what, how: `export ${AI_KEY_ENV}=<your DeepSeek or OpenAI key>` }
}
