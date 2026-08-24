/**
 * Per-class protocol relevance (spec §9b, DECIDED at M10 step 1).
 *
 * **The rule: a protocol identity field is relevant to a metric class if it can be a CAUSAL INPUT
 * to producing that number.** Declared explicitly per class, with its reasoning, defaulting to
 * relevant — silence means relevant, so a new field or a new metric is conservative by default.
 *
 * Why this exists: identity was global per entry, so a Chrome patch bump split EVERY metric's
 * timeline — including `client_bundle_size`, which no browser has any part in producing. On the
 * real perf-data branch that was 4 of 5 breaks, cutting byte runs into 3- and 7-point fragments
 * that can never reach an alertable length.
 *
 * **This is not the relaxation refused at M5.** That one asked an EMPIRICAL question with no
 * spread data behind it — do Chrome build-level differences change how a page renders? (Answer:
 * possibly, so identity stayed strict and the workflow pins Chrome instead.) This asks a CAUSAL
 * one — is Chrome an input to `next build`? It is not present at all. Where Chrome *is* the
 * instrument, identity stays exactly as strict as it was.
 *
 * Relevance follows measurement PROVENANCE, not units. `transfer_size:*` is a byte count and is
 * still browser-relevant, because Lighthouse driving Chrome is what produced it.
 */

export type IdentityField = 'node' | 'platform' | 'browser' | 'hostLabels' | 'driftwatch'

interface ClassRelevance {
  readonly name: string
  readonly matches: (id: string) => boolean
  /** What actually produces the number — the provenance the judgement rests on. */
  readonly collector: string
  /** Fields that cannot be causal inputs, each with the reason. Everything else is relevant. */
  readonly irrelevant: readonly { readonly field: IdentityField; readonly why: string }[]
}

const NO_BROWSER_IN_SIGHT = {
  field: 'browser' as const,
  why: 'no browser takes part in producing this number — it is not started, not consulted, and not on the path',
}

const CLASSES: readonly ClassRelevance[] = [
  {
    name: 'install_time',
    matches: (id) => id === 'install_time',
    collector: 'the package manager installing from a lockfile (src/core/measure/install.ts)',
    irrelevant: [NO_BROWSER_IN_SIGHT],
  },
  {
    name: 'build_time',
    matches: (id) => id === 'build_time',
    collector: "the project's own build command, timed (src/core/measure/build.ts)",
    irrelevant: [NO_BROWSER_IN_SIGHT],
  },
  {
    name: 'byte counts of build output',
    // `bundle_size` is the pre-M8 id for the same weighing step (all of .next, before the split).
    // Declared here rather than left to the default because its provenance is known, and leaving
    // it out would keep a year of history fragmented by upgrades that never touched it.
    matches: (id) => id === 'client_bundle_size' || id === 'build_output_size' || id === 'bundle_size',
    collector: 'weighing the directories the build emitted (src/core/measure/bundle.ts)',
    irrelevant: [NO_BROWSER_IN_SIGHT],
  },
  {
    name: 'route_latency',
    matches: (id) => id.startsWith('route_latency:'),
    collector: 'sequential HTTP requests to the booted app — node fetch, no browser (src/core/measure/route-latency.ts)',
    irrelevant: [NO_BROWSER_IN_SIGHT],
  },
  {
    name: 'browser metrics',
    matches: (id) =>
      id.startsWith('lcp:') || id.startsWith('fcp:') || id.startsWith('tbt:') || id.startsWith('transfer_size:'),
    collector: 'Lighthouse driving Chrome (src/core/measure/lighthouse.ts)',
    // Nothing is exempt here: the browser IS the instrument. transfer_size is a byte count and
    // still belongs in this group — provenance decides, not units.
    irrelevant: [],
  },
]

/** True when `field` can be a causal input to `metricId`. Unknown ids: everything is relevant. */
export function isFieldRelevant(field: IdentityField, metricId: string): boolean {
  const cls = CLASSES.find((c) => c.matches(metricId))
  if (!cls) return true
  return !cls.irrelevant.some((entry) => entry.field === field)
}

/** The declared reason a field is not relevant — for surfaces that explain themselves. */
export function irrelevanceReason(field: IdentityField, metricId: string): string | null {
  const cls = CLASSES.find((c) => c.matches(metricId))
  return cls?.irrelevant.find((entry) => entry.field === field)?.why ?? null
}

/** Provenance: what produced this metric class. Null for ids we have no declaration for. */
export function collectorOf(metricId: string): string | null {
  return CLASSES.find((c) => c.matches(metricId))?.collector ?? null
}
