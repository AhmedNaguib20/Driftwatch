import { describe, expect, it } from 'vitest'

import { renderAlerts } from '../src/cli/render-alerts.js'
import {
  ALERT_CUMULATIVE_PERCENT,
  ALERT_MIN_POINTS,
  ALERT_RESOLVE_PERCENT,
  ALERT_WORSEN_STEP_PERCENT,
  applyState,
  assessAlerts,
  buildTimelines,
  emptyAlertState,
  emptyIndex,
  nextState,
  shouldAlert,
} from '../src/core/index.js'
import type { AlertRecord, AlertState, IndexEntry, IndexFile, ProtocolIdentity } from '../src/core/index.js'

/**
 * M10 step 1 — the alert decision. An alert costs someone's attention; a dashboard row costs
 * nothing, so every test here asks the same question from a different side: is this something the
 * PR flow structurally could not have seen?
 */

function protocol(overrides: Partial<ProtocolIdentity> = {}): ProtocolIdentity {
  return {
    nodeVersion: 'v24.18.0',
    platform: 'linux',
    arch: 'x64',
    browser: 'chrome/151.0.7922.108',
    hostLabels: ['os:Linux'],
    driftwatchVersion: '0.6.0',
    ...overrides,
  }
}

let counter = 0
function entry(metrics: Record<string, number>, proto: ProtocolIdentity = protocol()): IndexEntry {
  counter += 1
  const sha = String(counter).padStart(3, '0').repeat(14).slice(0, 40)
  return {
    sha,
    shortSha: sha.slice(0, 12),
    // Strictly increasing: without parent links, ordering falls back to dates — and a clock that
    // wraps at 60 silently reorders history (it did, once, in this very file).
    timestamp: new Date(Date.UTC(2026, 0, 1) + counter * 3_600_000).toISOString(),
    branch: 'main',
    metrics: Object.fromEntries(
      Object.entries(metrics).map(([id, value]) => [id, { value, unit: id.includes('size') ? 'bytes' : 'ms' } as const]),
    ),
    protocol: proto,
  }
}

function index(entries: IndexEntry[]): IndexFile {
  return { ...emptyIndex(), entries }
}

/** A run of points for one metric, each `stepPercent` above the last. */
function ramp(id: string, start: number, steps: number, stepPercent: number, proto = protocol()): IndexEntry[] {
  const entries: IndexEntry[] = [entry({ [id]: start }, proto)]
  let value = start
  for (let i = 0; i < steps; i += 1) {
    value = Math.round(value * (1 + stepPercent / 100))
    entries.push(entry({ [id]: value }, proto))
  }
  return entries
}

/** Points whose step percentages are given explicitly — for shapes, not ramps. */
function shape(start: number, percents: readonly number[]): IndexEntry[] {
  const entries = [entry({ client_bundle_size: start })]
  let value = start
  for (const percent of percents) {
    value = Math.round(value * (1 + percent / 100))
    entries.push(entry({ client_bundle_size: value }))
  }
  return entries
}

const timelineFor = (entries: IndexEntry[], id = 'client_bundle_size') =>
  buildTimelines(index(entries)).find((t) => t.id === id)!

const conditionFor = (entries: IndexEntry[], id = 'client_bundle_size') => shouldAlert(timelineFor(entries, id))

describe('the alert decision — what a PR could not have seen', () => {
  it('the founding case: 14 commits of +0.8% each, no single one reportable', () => {
    // 13 steps of +0.8% compound to ~+10.9%. Every step is under the 2% reporting floor, so no PR
    // run ever showed a row for it, and no threshold was ever crossed.
    const condition = conditionFor(ramp('client_bundle_size', 2_200_000, 13, 0.8))

    expect(condition.qualifies).toBe(true)
    expect(condition.window!.points).toHaveLength(14)
    expect(condition.window!.cumulativePercent).toBeGreaterThan(ALERT_CUMULATIVE_PERCENT)
    expect(Math.abs(condition.window!.largestStep.percent)).toBeLessThan(2)
  })

  it('a single step is a regression, not a drift — the PR flow already owns it', () => {
    // One +12% commit, then flat. The step crossed the PR threshold, so the window starts AFTER
    // it: what remains for alerting to talk about is flat.
    const condition = conditionFor(shape(2_200_000, [12, 0.004, -0.002, 0.003, -0.001]))

    expect(condition.qualifies).toBe(false)
    expect(condition.window!.startedAfter).not.toBeNull()
    expect(condition.decline!.reason).toBe('under-threshold')
  })

  it('a quiet step that is most of the movement is still a step, not a drift', () => {
    // Only reachable when a team RAISES `threshold` in perf.yml: at the 5% default, the window
    // trim already guarantees no step can be half of a cumulative that had to reach 10%.
    const condition = shouldAlert(timelineFor(shape(2_000_000, [9, 0.4, 0.4, 0.4, 0.4, 0.4])), {
      prThresholdPercent: 10,
    })

    expect(condition.qualifies).toBe(false)
    expect(condition.decline!.reason).toBe('step-change')
    expect(condition.decline!.detail).toMatch(/accounts for \d+% of the movement/)
  })

  it('a sawtooth is not a tendency, even when it ends well above the line', () => {
    // Ends ~+13% but spends more than three times that much movement getting there: net share
    // 0.30. Every step stays under the PR threshold, so the window keeps all of them.
    const condition = conditionFor(shape(2_000_000, [4.5, -3.5, 4.5, -3.5, 4.5, -3.5, 4.5, 4.5, -3.5, 4.5]))

    expect(condition.window!.cumulativePercent).toBeGreaterThan(ALERT_CUMULATIVE_PERCENT)
    expect(condition.qualifies).toBe(false)
    expect(condition.decline!.reason).toBe('not-sustained')
    expect(condition.decline!.detail).toMatch(/30% of the movement went one way/)
  })

  it('never alerts across a protocol break — the run restarts at the break', () => {
    const before = ramp('client_bundle_size', 2_200_000, 13, 0.8)
    // A node bump, not a browser bump: Chrome is not an input to a bundle's byte count, so it no
    // longer breaks this line at all (spec §9b).
    const after = ramp('client_bundle_size', 2_450_000, 2, 0.8, protocol({ nodeVersion: 'v26.0.0' }))
    const condition = conditionFor([...before, ...after])

    expect(condition.qualifies).toBe(false)
    expect(condition.decline!.reason).toBe('insufficient-points')
    expect(condition.window!.points).toHaveLength(3)
  })

  it('timing classes are never alerted, whatever they do', () => {
    const condition = shouldAlert(timelineFor(ramp('build_time', 40_000, 13, 0.8), 'build_time'), {})

    expect(condition.qualifies).toBe(false)
    expect(condition.decline!.reason).toBe('not-licensed')
    expect(condition.decline!.detail).toMatch(/machine variance/)
  })

  it(`a run shorter than ${ALERT_MIN_POINTS} points is not yet a tendency`, () => {
    const condition = conditionFor(ramp('client_bundle_size', 2_200_000, 3, 4))

    expect(condition.qualifies).toBe(false)
    expect(condition.decline!.reason).toBe('insufficient-points')
  })

  it('a downward drift is good news, not an alert — and a flat wobble is neither', () => {
    const down = conditionFor(ramp('client_bundle_size', 2_200_000, 13, -1.2))
    expect(down.decline!.reason).toBe('improving')

    const flat = conditionFor(shape(2_200_000, [0.002, -0.003, 0.001, -0.002, 0.001]))
    expect(flat.decline!.reason).toBe('under-threshold')
    expect(flat.decline!.detail).not.toMatch(/improvement/)
  })
})

describe('the sentence — the feature itself', () => {
  it('names the drift, the run, the values, and what the PR flow missed', () => {
    const condition = conditionFor(ramp('client_bundle_size', 2_200_000, 13, 0.8))
    const event = applyState(condition, null, { now: '2026-08-24T09:00:00.000Z' })

    expect(event.kind).toBe('fire')
    if (event.kind !== 'fire') return
    expect(event.payload.headline).toBe(
      'client bundle size drifted +10.91% over 14 commits (2.10 MB → 2.33 MB) — no single commit crossed the 5% threshold (largest +0.8%).',
    )
    // A tendency claim never names a culprit.
    expect(event.payload.headline).not.toMatch(/caused|because|blame/)
  })

  it('counts only measured points when commits sit unmeasured between them', () => {
    // Two commits recorded without this metric, in the MIDDLE of the run (entries order by date,
    // so a fixture that appends them afterwards is not the case it claims to be).
    const entries: IndexEntry[] = [entry({ client_bundle_size: 2_200_000 })]
    let value = 2_200_000
    for (let i = 0; i < 13; i += 1) {
      if (i === 6) entries.push(entry({ build_time: 40_000 }), entry({ build_time: 40_100 }))
      value = Math.round(value * 1.008)
      entries.push(entry({ client_bundle_size: value }))
    }
    const fired = assessAlerts(index(entries), emptyAlertState(), { now: '2026-08-24T09:00:00.000Z' }).events.find(
      (e) => e.kind === 'fire',
    )

    expect(fired?.kind === 'fire' && fired.payload.headline).toMatch(/over 14 measured points spanning 16 commits/)
  })
})

describe('state — an alert fires once per condition', () => {
  const drifting = ramp('client_bundle_size', 2_200_000, 13, 0.8)
  const fire = (entries: IndexEntry[], state: AlertState) =>
    assessAlerts(index(entries), state, { now: '2026-08-24T09:00:00.000Z' })

  /** More points continuing an existing run. */
  const tail = (existing: IndexEntry[], steps: number, stepPercent: number) =>
    ramp('client_bundle_size', existing.at(-1)!.metrics.client_bundle_size!.value, steps, stepPercent).slice(1)

  it('the same condition on the next scheduled run is silent', () => {
    const first = fire(drifting, emptyAlertState())
    expect(first.events.filter((e) => e.kind === 'fire')).toHaveLength(1)

    const second = fire(drifting, first.state)
    expect(second.events.filter((e) => e.kind === 'fire')).toHaveLength(0)
    const holding = second.events.find((e) => e.metric === 'client_bundle_size')
    expect(holding?.kind).toBe('holding')
    expect(holding?.kind === 'holding' && holding.detail).toMatch(/quiet until/)
  })

  it(`re-alerts only after another ${ALERT_WORSEN_STEP_PERCENT} points of drift`, () => {
    const first = fire(drifting, emptyAlertState())
    const alertedAt = first.state.open[0]!.cumulativePercent

    // Five more small steps is not enough to speak again...
    expect(fire([...drifting, ...tail(drifting, 5, 0.8)], first.state).events.filter((e) => e.kind === 'fire')).toHaveLength(0)

    // ...but crossing the next full step is.
    const again = fire([...drifting, ...tail(drifting, 12, 0.9)], first.state).events.find((e) => e.kind === 'fire')
    expect(again?.kind === 'fire' && again.reason).toBe('worsened')
    expect(again?.kind === 'fire' && again.payload.headline).toMatch(
      new RegExp(`drift widened to \\+\\d+(\\.\\d+)?% .*last alerted at \\+${alertedAt}%`),
    )
  })

  it(`resolves once when the drift retreats under ${ALERT_RESOLVE_PERCENT}%`, () => {
    const first = fire(drifting, emptyAlertState())
    const alertedAt = first.state.open[0]!.cumulativePercent
    const recovered = [...drifting, entry({ client_bundle_size: 2_250_000 })]

    const after = fire(recovered, first.state)
    const resolved = after.events.find((e) => e.metric === 'client_bundle_size')
    expect(resolved?.kind).toBe('resolved')
    // Measured from where the alert was RAISED, not from a window a later commit re-cut.
    expect(resolved?.kind === 'resolved' && resolved.sentence).toMatch(
      new RegExp(`retreated to \\+2\\.\\d+%, from the \\+${alertedAt}% alerted on 2026-08-24`),
    )

    // Said once: the record is gone, so the next run has nothing to say at all.
    expect(after.state.open).toHaveLength(0)
    expect(fire(recovered, after.state).events.find((e) => e.metric === 'client_bundle_size')?.kind).toBe('quiet')
  })

  it('holds an open alert that fell below the line but not to resolution', () => {
    const first = fire(drifting, emptyAlertState())
    const partial = [...drifting, entry({ client_bundle_size: 2_354_000 })] // ~+7%: below 10, above 5

    const event = fire(partial, first.state).events.find((e) => e.metric === 'client_bundle_size')
    expect(event?.kind).toBe('holding')
    expect(event?.kind === 'holding' && event.detail).toMatch(/stays open and stays quiet/)
  })

  it('closes as superseded — never as resolved — when the ground moves', () => {
    const first = fire(drifting, emptyAlertState())
    const afterBreak = [...drifting, ...ramp('client_bundle_size', 2_450_000, 2, 0.1, protocol({ nodeVersion: 'v26.0.0' }))]

    const event = fire(afterBreak, first.state).events.find((e) => e.metric === 'client_bundle_size')
    expect(event?.kind).toBe('superseded')
    expect(event?.kind === 'superseded' && event.detail).toMatch(/superseded, not resolved/)
    expect(fire(afterBreak, first.state).state.open).toHaveLength(0)
  })

  it('a metric that disappears from history closes its alert honestly', () => {
    const record: AlertRecord = {
      metric: 'client_bundle_size',
      firedAt: '2026-08-01T00:00:00.000Z',
      atSha: 'a'.repeat(40),
      windowStartSha: 'b'.repeat(40),
      cumulativePercent: 11.3,
      points: 14,
    }
    const state = nextState(emptyAlertState(), [
      { kind: 'fire', reason: 'new', metric: record.metric, payload: {} as never, record, supersedes: null },
    ])

    const event = assessAlerts(index([entry({ build_time: 40_000 })]), state, {
      now: '2026-08-24T09:00:00.000Z',
    }).events.find((e) => e.metric === 'client_bundle_size')

    expect(event?.kind).toBe('superseded')
    expect(event?.kind === 'superseded' && event.detail).toMatch(/no longer present/)
  })
})

describe('the terminal surface', () => {
  const drifting = ramp('client_bundle_size', 2_200_000, 13, 0.8)
  const now = '2026-08-24T09:00:00.000Z'

  it('an alert never renders beside a claim that there is nothing to say', () => {
    const fired = assessAlerts(index(drifting), emptyAlertState(), { now })
    const out = renderAlerts(fired, drifting.length, 'state: none')

    expect(out).toMatch(/client bundle size drifted \+10\.91%/)
    expect(out).not.toMatch(/nothing to alert/)
  })

  it('a resolution is something we said, so it does not render as silence either', () => {
    const first = assessAlerts(index(drifting), emptyAlertState(), { now })
    const recovered = [...drifting, entry({ client_bundle_size: 2_250_000 })]
    const out = renderAlerts(assessAlerts(index(recovered), first.state, { now }), recovered.length, 'state: none')

    expect(out).toMatch(/drift has retreated to/)
    expect(out).not.toMatch(/nothing to alert/)
  })

  it('names the metrics it looked at and declined, and why it never looks at timing', () => {
    const mixed = [...drifting, ...ramp('build_time', 40_000, 5, 3)]
    const out = renderAlerts(assessAlerts(index(mixed), emptyAlertState(), { now }), mixed.length, 'state: none')

    expect(out).toMatch(/never alerted — build time: drift in a timing class is not separable/)
  })
})
