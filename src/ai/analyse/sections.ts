/**
 * The section headings of an assembled analysis context — the *shape* of what is sent.
 *
 * They live here rather than inline in the renderer because the README's disclosure is GENERATED
 * from this list (spec §9e step E). A section added to a prompt context without a line in the
 * privacy disclosure is exactly the drift the generation exists to prevent, and a test asserts
 * the golden contexts contain these and only these.
 */

export interface ContextSection {
  readonly heading: string
  /** What a privacy-conscious reader needs to know about it, in one line. */
  readonly discloses: string
}

export const CONTEXT_SECTIONS: readonly ContextSection[] = [
  { heading: '## Measured verdict', discloses: 'the verdict this run reached' },
  { heading: '## Metrics', discloses: 'metric values for both sides, with their deltas' },
  {
    heading: '## Raw samples (medians are reported; judge the spread yourself)',
    discloses: 'the raw samples behind every median, so the model can judge the spread',
  },
  { heading: '## Measurement protocols', discloses: 'both measurement protocols (node, platform, browser, host labels)' },
  {
    heading: '## Detection evidence (how the tool knows what it knows)',
    discloses: 'the detection evidence trail — which file told the tool what',
  },
  {
    heading: '## Dependency changes (lockfile summary — raw lockfile patches are never sent)',
    discloses: 'a package-level summary of lockfile changes (added/removed/bumped, with versions)',
  },
  {
    heading: '## Diffstat (every changed file, base → working tree)',
    discloses: 'a diffstat of every changed file between the base commit and your working tree',
  },
  {
    heading: '## Patches (unified diff, base → working tree)',
    discloses: 'full patches for the most-relevant changed files, within a fixed token budget',
  },
]

/** The triage stage inlines small patches under its own heading; same content, smaller budget. */
export const TRIAGE_PATCH_HEADING = '## Patches of small diffs (unified diff, base → working tree)'
