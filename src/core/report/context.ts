import type { BaselinePlan } from '../baseline/plan.js'

/**
 * Verdict-softening context (spec §9a decision 2).
 *
 * A comparison answers "did THIS change move the numbers?" — an attribution. Attribution needs a
 * licence, exactly as movement does against drift (§10): the numbers are measured either way, but
 * naming this change as their cause requires that nothing ELSE plausibly explains them.
 *
 * Two conditions void that licence, and the real-world trial had both at once: a base 143
 * commits and
 * two months behind, and a lockfile differing by 395 lines. The old output still said
 * "regression +6.5%" with the dependency change as a footnote under the table. It should have
 * said: here are the numbers, and here is why they are not this branch's fault to claim.
 */

/** A base this far behind stops being "what this branch changed against". */
export const STALE_BASE_COMMITS = 50
export const STALE_BASE_DAYS = 14

export interface SofteningCondition {
  readonly kind: 'stale-base' | 'dependencies-differ'
  /** Shown verbatim — states the fact, then what to do about it. */
  readonly text: string
}

export interface ContextInput {
  readonly plan: BaselinePlan
  /** Commits the current branch has that the base does not. */
  readonly commitsAhead: number | null
  /** Age of the base commit in days at measurement time. */
  readonly baseAgeDays: number | null
  /** The branch this project most likely integrates into, when it is not the base. */
  readonly likelyIntegrationTarget: string | null
}

export function softeningConditions(input: ContextInput): SofteningCondition[] {
  const conditions: SofteningCondition[] = []
  if (!input.plan.available) return conditions

  const { commitsAhead, baseAgeDays } = input
  const farBehind = (commitsAhead ?? 0) > STALE_BASE_COMMITS || (baseAgeDays ?? 0) > STALE_BASE_DAYS
  if (farBehind) {
    const parts: string[] = []
    if (commitsAhead !== null) parts.push(`${commitsAhead} commits ahead of it`)
    if (baseAgeDays !== null) parts.push(`the base commit is ${baseAgeDays} day(s) old`)
    const target = input.likelyIntegrationTarget
    conditions.push({
      kind: 'stale-base',
      text:
        `the base \`${input.plan.baseRef}\` is far behind this branch (${parts.join('; ')}), so a delta ` +
        `measures months of other people's work as much as this change` +
        (target
          ? `. This project's branches appear to integrate into \`${target}\` — compare against that instead:\n\n    driftwatch run --base ${target}`
          : `. Compare against the branch this work merges into:\n\n    driftwatch run --base <that-branch>`),
    })
  }

  if (input.plan.dependenciesChanged === true) {
    conditions.push({
      kind: 'dependencies-differ',
      text:
        'the lockfile differs between the two sides, so the two builds resolved different ' +
        'dependency trees — any delta includes whatever those packages changed. Align the ' +
        'dependencies (or compare against a base with the same lockfile) to attribute a delta to ' +
        'the code alone.',
    })
  }

  return conditions
}

/** The one-line summary the verdict carries; the full conditions render underneath it. */
export function softeningSummary(conditions: readonly SofteningCondition[]): string {
  const names = conditions.map((c) => (c.kind === 'stale-base' ? 'the base is stale' : 'dependencies differ'))
  return `${names.join(' and ')} — the numbers below are measured and stand; what they cannot do is name this change as the cause`
}
