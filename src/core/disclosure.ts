/**
 * Where analysis data goes, and the one line that says so wherever a reader actually is.
 *
 * This lives in core, not in `ai/`, for a reason that is easy to get wrong: the PR comment and
 * `doctor` both state it, and if they imported it from `ai/` they would drag the AI module graph
 * into a keyless render — the exact thing hard rule 6 exists to prevent. The README's full
 * disclosure is generated in `ai/disclosure.ts`, which is only ever loaded to write docs.
 *
 * Named plainly, jurisdiction included. Flagged at M2 as a real adoption blocker; being coy about
 * it would be the wrong kind of tact, and the reader is entitled to decide for themselves.
 */

export interface Destination {
  readonly provider: string
  readonly who: string
}

export const DESTINATIONS: readonly Destination[] = [
  { provider: 'deepseek', who: 'DeepSeek (Hangzhou DeepSeek Artificial Intelligence Co., a Chinese company)' },
  { provider: 'openai', who: 'OpenAI (a US company)' },
  { provider: 'anthropic', who: 'Anthropic (a US company)' },
]

export function destinationOf(provider: string): string {
  return DESTINATIONS.find((d) => d.provider === provider)?.who ?? provider
}

/** One line for the surfaces the reader is on: the PR comment and `doctor`. */
export function disclosureLine(provider: string): string {
  // Present tense on purpose: the same sentence is printed by `doctor` before anything is sent
  // and by the PR comment after it was. One claim, true in both places.
  return (
    `Analysis sends the diff and measurements to ${destinationOf(provider)}; nothing else leaves the machine, ` +
    'and the per-run `contextManifest` in the result JSON lists exactly what was included.'
  )
}
