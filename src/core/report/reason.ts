/**
 * Rendering a skip reason (spec §9a — failure legibility).
 *
 * Reasons are multi-line by convention: the first line summarises, the last line is the most
 * specific thing the failing tool said. The jinni trial showed why that ordering matters — the
 * terminal rendered the FIRST line, which was *"install exited with code 1; last output:"*: a
 * sentence that promises content and then delivers none, while the actual error
 * (`EUNSUPPORTEDPROTOCOL`) sat unread in the JSON.
 *
 * Rules, in order:
 *  1. show the LAST non-empty line — the specific one;
 *  2. never show a line that promises content it cannot deliver (a trailing colon);
 *  3. when detail was dropped, say where the rest is — a reader must never have to GUESS that
 *     the answer exists somewhere else.
 */

export interface RenderedReason {
  /** The single line to show. */
  readonly text: string
  /** True when the reason held more than this line — the caller points at the full text. */
  readonly truncated: boolean
}

export function summariseReason(reason: string): RenderedReason {
  const lines = reason.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
  if (lines.length === 0) return { text: 'not collected', truncated: false }

  let text = lines.at(-1)!
  // Rule 2: a trailing colon promises a continuation that this rendering cannot show.
  if (text.endsWith(':')) {
    const trimmed = text.replace(/[;,]?\s*[^;,]*:$/, '').trim()
    text = trimmed.length > 0 ? trimmed : text.slice(0, -1)
  }
  return { text, truncated: lines.length > 1 }
}

/** The one-line form with its pointer, e.g. "…EUNSUPPORTEDPROTOCOL (full error: --json)". */
export function summariseReasonWith(reason: string, where: string): string {
  const { text, truncated } = summariseReason(reason)
  return truncated ? `${text} (${where})` : text
}
