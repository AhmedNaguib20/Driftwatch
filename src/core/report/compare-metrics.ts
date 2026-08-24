import type { MetricId } from '../detect/types.js'
import { hostLabelsFromEnv } from '../measure/protocol.js'
import type { MetricResult } from '../measure/types.js'
import type { MetricComparison, MetricVerdict } from './types.js'

/**
 * Per-metric comparison and verdicts.
 *
 * Two lines, two jobs (config-schema.ts): the noise floor decides whether a delta is REPORTED at
 * all; the threshold decides whether a reported regression drives the run verdict. A delta under
 * the floor is not shown even in the JSON — hard rule 4 applies to the contract, not just the
 * terminal.
 */

/** Every metric is a cost: more milliseconds, more bytes — higher is worse. */
const FIXED_ORDER: readonly MetricId[] = ['install_time', 'build_time', 'client_bundle_size', 'build_output_size']

/** Fixed metrics first, then per-route classes in a stable class order — deterministic table. */
const ROUTE_CLASS_ORDER = ['route_latency:', 'lcp:', 'tbt:', 'fcp:', 'transfer_size:'] as const

function orderedIds(base: readonly MetricResult[], current: readonly MetricResult[]): MetricId[] {
  const present = new Set<MetricId>([...base, ...current].map((m) => m.id))
  const fixed = FIXED_ORDER.filter((id) => present.has(id))
  const classes = ROUTE_CLASS_ORDER.flatMap((prefix) =>
    [...present].filter((id) => id.startsWith(prefix)).sort(),
  )
  return [...fixed, ...classes]
}

/**
 * Per-class absolute quanta — each metric class carries its own instrument resolution (spec §5
 * quantum table; code constants, never config). A single global quantum would gut whichever class
 * it wasn't calibrated for: 100ms would suppress a 4ms route regressing 25x. Bases are measured,
 * never guessed:
 *
 *  - build_time 100ms: process spawn jitters 5-10ms, package managers add tens more.
 *  - route_latency 5ms: observed ±1ms sequential-fetch noise, x5.
 *  - lcp/fcp 25ms local / 200ms CI: ≤7ms spread across boots locally; shared runners swung
 *    −9.7%…+17.8% on byte-identical trees (measured, M6 acceptance).
 *  - tbt 50ms local / 100ms CI: ±2ms locally; +83% observed on identical code on a runner.
 *  - transfer_size 1KB (bytes): ±2 bytes observed; ≥1KB is a real asset change.
 *  - client_bundle_size / build_output_size 1KB (bytes): the same instrument as transfer_size —
 *    a byte count of a built tree, deterministic to within a couple of bytes across runs. NOTE
 *    the binding constraint for these is the 2% RELATIVE floor, not this quantum: on a 9.6 MB
 *    client bundle 2% is ~197 KB, so the 140 KB lodash regression M2/M6 were built around scores
 *    1.42% and reports as "no change". Raising that is a hard-rule-4 decision, not a code one.
 *
 * Browser-timing quanta are environment-conditional (spec §5, decided M6 acceptance): the
 * quantum is the instrument's resolution, and the machine is part of the instrument — shared CI
 * runners are a coarser instrument for browser timings. Host class comes from
 * DRIFTWATCH_HOST_LABELS (present = CI), the same labels the protocol records, so cross-class
 * comparisons are already refused before quanta ever matter.
 */
export function quantumFor(id: MetricId, unit: 'ms' | 'bytes' | null, ciHost: boolean = isCiHost()): number {
  if (unit === 'bytes') {
    // Every byte class is the same deterministic instrument; 1KB is the resolution below which a
    // difference is bookkeeping (manifest hashes, timestamps) rather than shipped content.
    return isFloorExempt(id) ? 1024 : 0
  }
  if (id.startsWith('route_latency:')) return 5
  if (id.startsWith('lcp:') || id.startsWith('fcp:')) return ciHost ? 200 : 25
  if (id.startsWith('tbt:')) return ciHost ? 100 : 50
  return 100
}

/**
 * The deterministic byte classes, exempt from the 2% RELATIVE floor and gated by their 1KB
 * quantum alone (spec §5, decided M8 step 4).
 *
 * Why: the floor is a NOISE rule, and these carry no noise — ±2 bytes observed, and the whole
 * recorded history of this repo drifts under 0.01%. Keeping it made the tool blind to its own
 * founding case: on a 9.6 MB client bundle, 2% is ~197 KB, so the 140 KB lodash regression that
 * M2 and M6 were built around scores 1.42% and reported "no change". A rule that hides the
 * founding example on any large app is mis-scoped, not conservative.
 *
 * This predicate is the single definition — comparison, drift and movement all read it, because
 * a floor rule that holds in one surface and not another is two rules.
 */
export function isFloorExempt(id: MetricId): boolean {
  return id === 'client_bundle_size' || id === 'build_output_size' || id.startsWith('transfer_size:')
}

/** CI = DRIFTWATCH_HOST_LABELS present; local = absent (spec §5). */
export function isCiHost(env: NodeJS.ProcessEnv = process.env): boolean {
  return hostLabelsFromEnv(env).length > 0
}

export interface CompareOptions {
  readonly noiseFloorPercent: number
  readonly thresholdPercent: number
  /** Non-empty ⇒ protocols mismatch ⇒ every metric is not_comparable (§5.1). */
  readonly protocolMismatches: readonly string[]
}

export function compareMetrics(
  base: readonly MetricResult[],
  current: readonly MetricResult[],
  options: CompareOptions,
): MetricComparison[] {
  return orderedIds(base, current).map((id) =>
    compareOne(
      base.find((m) => m.id === id) ?? null,
      current.find((m) => m.id === id) ?? null,
      id,
      options,
    ),
  )
}

function compareOne(
  base: MetricResult | null,
  current: MetricResult | null,
  id: MetricId,
  options: CompareOptions,
): MetricComparison {
  const label = current?.label ?? base?.label ?? id
  const shell = {
    id,
    label,
    unit: pickUnit(base, current),
    base: base?.status === 'measured' ? base.value : null,
    current: current?.status === 'measured' ? current.value : null,
  }

  const skipReason = skippedReason(base, current)
  if (skipReason) {
    // Policy exclusions (SSG, dynamic segments, user-disabled layers) are excluded on every side
    // that has the row; a failed measurement is not — only the latter gates the run verdict.
    const policyOnly = [base, current]
      .filter((m): m is MetricResult => m !== null)
      .every((m) => m.status === 'skipped' && m.excluded === true)
    // Carry the remedy through: whichever side knows the fix, the reader sees it once.
    const fix = [current, base].find(
      (m): m is MetricResult & { fix: string } => m?.status === 'skipped' && typeof m.fix === 'string',
    )?.fix
    return {
      ...shell,
      delta: null,
      verdict: 'skipped',
      exceedsThreshold: false,
      reason: skipReason,
      ...(fix ? { fix } : {}),
      ...(policyOnly ? { excluded: true } : {}),
    }
  }

  // §5.1 enforcement: mismatched protocols → no delta, ever. The exact fields are named so the
  // reader knows what to fix rather than just that something is off.
  if (options.protocolMismatches.length > 0) {
    return {
      ...shell,
      delta: null,
      verdict: 'not_comparable',
      exceedsThreshold: false,
      reason: `the two sides were measured under different protocols — ${options.protocolMismatches.join('; ')}`,
    }
  }

  // §5.1 sixth instance: within one invocation the base side installs first (cold package-manager
  // cache), current second (warm). When both sides measured a fresh install, the cache states
  // cannot be shown equal — values reported, delta refused.
  if (id === 'install_time') {
    return {
      ...shell,
      delta: null,
      verdict: 'not_comparable',
      exceedsThreshold: false,
      reason: 'package-manager cache state differs between sides (base installs first, cold; current second, warm)',
    }
  }

  const baseValue = shell.base!
  const currentValue = shell.current!

  if (baseValue === 0) {
    if (currentValue === 0) {
      return { ...shell, delta: null, verdict: 'no_change', exceedsThreshold: false, reason: 'both sides measured 0' }
    }
    return {
      ...shell,
      delta: null,
      verdict: 'not_comparable',
      exceedsThreshold: false,
      reason: 'baseline measured 0 — a percentage delta is undefined',
    }
  }

  const absolute = currentValue - baseValue
  const percent = (absolute / baseValue) * 100

  if (!isFloorExempt(id) && Math.abs(percent) < options.noiseFloorPercent) {
    return {
      ...shell,
      delta: null,
      verdict: 'no_change',
      exceedsThreshold: false,
      reason: `delta is under the ${options.noiseFloorPercent}% noise floor`,
    }
  }

  const quantum = quantumFor(id, shell.unit)
  if (quantum > 0 && Math.abs(absolute) < quantum) {
    return {
      ...shell,
      delta: null,
      verdict: 'no_change',
      exceedsThreshold: false,
      reason: `delta is under this metric class's ${quantum}${shell.unit === 'bytes' ? ' byte' : 'ms'} resolution`,
    }
  }

  const verdict: MetricVerdict = absolute > 0 ? 'regressed' : 'improved'
  return {
    ...shell,
    delta: { absolute, percent: round2(percent) },
    verdict,
    // The threshold applies to regressions only; improvements never need to clear a bar.
    exceedsThreshold: verdict === 'regressed' && Math.abs(percent) >= options.thresholdPercent,
    reason: null,
  }
}

/**
 * Both sides usually fail identically (same tree, same protocol) — say it once. When they differ,
 * each side gets its own line rather than a " | " run-on: reasons are multi-line by convention
 * (spec §9a) and interleaving them made the detail unreadable.
 */
function skippedReason(base: MetricResult | null, current: MetricResult | null): string | null {
  const skipOf = (m: MetricResult | null) => (m?.status === 'skipped' ? m.reason : null)
  const baseReason = skipOf(base)
  const currentReason = skipOf(current)

  // A side with no row at all did not FAIL — the metric simply does not exist there (a route
  // added on this branch, say). Saying it once, without a second "reason", is what keeps the
  // "(full error)" pointer honest: there is nothing further to show (spec §9a decision 4).
  if (base === null && currentReason !== null) return `${currentReason} (not present at base)`
  if (current === null && baseReason !== null) return `${baseReason} (present only at base)`
  if (base === null && current === null) return 'metric not collected on either side'

  if (baseReason !== null && currentReason !== null) {
    return baseReason === currentReason ? baseReason : `base: ${baseReason}\ncurrent: ${currentReason}`
  }
  // One side failed while the other measured — WHICH side is the reader's first question.
  if (baseReason !== null) return `base: ${baseReason}`
  return currentReason !== null ? `current: ${currentReason}` : null
}

function pickUnit(
  base: MetricResult | null,
  current: MetricResult | null,
): 'ms' | 'bytes' | null {
  if (current?.status === 'measured') return current.unit
  if (base?.status === 'measured') return base.unit
  return null
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
