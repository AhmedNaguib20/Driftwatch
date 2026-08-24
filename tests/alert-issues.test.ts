import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  applyState,
  assessAlerts,
  buildTimelines,
  emptyAlertState,
  emptyIndex,
  nextState,
  shouldAlert,
} from '../src/core/index.js'
import type { AlertEvent, AlertState, BuildIdentity, IndexEntry, IndexFile, ProtocolIdentity } from '../src/core/index.js'
import { SURFACE_KIND, deliverAlertEvent } from '../src/adapters/github/alert-issues.js'
import { publishAlerts } from '../src/adapters/github/publish-alerts.js'
import {
  renderAlertIssue,
  renderResolvedComment,
  renderSupersededComment,
  renderWidenedComment,
} from '../src/adapters/github/render-alert-issue.js'
import type { GithubClient } from '../src/adapters/github/api-client.js'

/**
 * The alert issue lifecycle — the M10 product surface.
 *
 * Four transitions, and the fifth case that matters most: silence. An alert nobody can trust is
 * one that might be quiet because it is broken, so the quiet path is asserted as hard as the
 * loud ones — zero API calls, and a line that says what was looked at.
 */

const BUILD: BuildIdentity = { version: '0.0.0-test', entry: 'dist', builtAt: '2026-08-24T00:00:00.000Z' }
const TARGET = { owner: 'acme', repo: 'app' }

function protocol(overrides: Partial<ProtocolIdentity> = {}): ProtocolIdentity {
  return {
    nodeVersion: 'v24.18.0',
    platform: 'linux',
    arch: 'x64',
    browser: 'chrome/151.0.7922.77',
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
    timestamp: new Date(Date.UTC(2026, 5, 1) + counter * 86_400_000).toISOString(),
    branch: 'main',
    metrics: Object.fromEntries(
      Object.entries(metrics).map(([id, value]) => [id, { value, unit: id.includes('size') ? 'bytes' : 'ms' } as const]),
    ),
    protocol: proto,
  }
}

const index = (entries: IndexEntry[]): IndexFile => ({ ...emptyIndex(), entries })

function ramp(start: number, steps: number, stepPercent: number, proto = protocol()): IndexEntry[] {
  const entries = [entry({ client_bundle_size: start }, proto)]
  let value = start
  for (let i = 0; i < steps; i += 1) {
    value = Math.round(value * (1 + stepPercent / 100))
    entries.push(entry({ client_bundle_size: value }, proto))
  }
  return entries
}

const NOW = '2026-08-24T09:00:00.000Z'
const fireEvent = (entries: IndexEntry[], prior: AlertState = emptyAlertState()) =>
  assessAlerts(index(entries), prior, { now: NOW }).events.find((e) => e.kind === 'fire')!

/** Records every call; returns whatever the queued responses say. */
function fakeClient(responses: Record<string, unknown> = {}): {
  client: GithubClient
  calls: { method: string; path: string; body?: unknown }[]
} {
  const calls: { method: string; path: string; body?: unknown }[] = []
  const client: GithubClient = {
    async request(method, path, body) {
      calls.push({ method, path, body })
      const key = `${method} ${path}`
      const canned = responses[key]
      if (canned instanceof Error) throw canned
      return { status: 200, json: canned ?? { number: 42, html_url: 'https://github.com/acme/app/issues/42' } }
    },
  }
  return { client, calls }
}

describe('the four transitions, rendered', () => {
  const drifting = ramp(2_200_000, 13, 0.8)
  const golden = (name: string) => path.join(import.meta.dirname, 'golden', name)
  const check = async (name: string, rendered: string) => {
    if (process.env.UPDATE_GOLDEN === '1') await writeFile(golden(name), rendered + '\n', 'utf8')
    expect(rendered + '\n').toBe(await readFile(golden(name), 'utf8'))
  }

  it('opened: the issue states the claim, its arithmetic, and what it is not', async () => {
    const event = fireEvent(drifting)
    if (event.kind !== 'fire') throw new Error('expected a fire')
    const { title, body } = renderAlertIssue(event.payload, BUILD)

    expect(title).toBe('client bundle size has drifted +10.9% over 14 commits')
    await check('alert-issue-opened.md', body)
  })

  it('widened: says what changed since it last spoke, on the same issue', async () => {
    const first = assessAlerts(index(drifting), emptyAlertState(), { now: NOW })
    const worse = [...drifting, ...ramp(drifting.at(-1)!.metrics.client_bundle_size!.value, 12, 0.9).slice(1)]
    const event = fireEvent(worse, first.state)
    if (event.kind !== 'fire') throw new Error('expected a fire')

    expect(event.reason).toBe('worsened')
    await check('alert-comment-widened.md', renderWidenedComment(event.payload, event.previousPercent!, BUILD))
  })

  it('resolved: the retreat is a measurement from where the alert was raised', async () => {
    const first = assessAlerts(index(drifting), emptyAlertState(), { now: NOW })
    const recovered = [...drifting, entry({ client_bundle_size: 2_250_000 })]
    const event = assessAlerts(index(recovered), first.state, { now: NOW }).events.find((e) => e.kind === 'resolved')
    if (event?.kind !== 'resolved') throw new Error('expected a resolution')

    await check('alert-comment-resolved.md', renderResolvedComment(event, BUILD))
  })

  it('superseded: never claims a recovery, and says so in those words', async () => {
    const first = assessAlerts(index(drifting), emptyAlertState(), { now: NOW })
    const afterBreak = [...drifting, ...ramp(2_450_000, 2, 0.1, protocol({ nodeVersion: 'v26.0.0' }))]
    const event = assessAlerts(index(afterBreak), first.state, { now: NOW }).events.find(
      (e) => e.kind === 'superseded',
    )
    if (event?.kind !== 'superseded') throw new Error('expected a supersede')

    const body = renderSupersededComment(event, BUILD)
    expect(body).toMatch(/no measurement showing the drift came back down, and none showing it persists/)
    // Every single occurrence of the word is negated: there is no sentence in which this issue
    // says it was resolved.
    expect(body).not.toMatch(/(?<!not )resolved/)
    await check('alert-comment-superseded.md', body)
  })
})

describe('the issue mechanics', () => {
  const drifting = ramp(2_200_000, 13, 0.8)

  it('a new alert opens exactly one issue, and records where it went', async () => {
    const { client, calls } = fakeClient()
    const delivered = await deliverAlertEvent(client, TARGET, fireEvent(drifting))

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /repos/acme/app/issues'])
    expect(delivered?.action).toBe('opened')
    expect(delivered?.record?.surface).toEqual({ kind: SURFACE_KIND, ref: '42' })
  })

  it('a widened alert comments on the issue it already opened — never a second one', async () => {
    const opened = await deliverAlertEvent(fakeClient().client, TARGET, fireEvent(drifting))
    const stored = nextState(emptyAlertState(), [{ ...(opened!.event as AlertEvent & { kind: 'fire' }), record: opened!.record! }])

    const worse = [...drifting, ...ramp(drifting.at(-1)!.metrics.client_bundle_size!.value, 12, 0.9).slice(1)]
    const { client, calls } = fakeClient()
    const delivered = await deliverAlertEvent(client, TARGET, fireEvent(worse, stored))

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /repos/acme/app/issues/42/comments',
      'PATCH /repos/acme/app/issues/42',
    ])
    expect(calls[1]!.body).toEqual({ title: 'client bundle size has drifted +23.5% over 26 commits' })
    expect(delivered?.action).toBe('widened')
  })

  it('a resolution comments and closes, and the record stops being open', async () => {
    const opened = await deliverAlertEvent(fakeClient().client, TARGET, fireEvent(drifting))
    const stored = nextState(emptyAlertState(), [{ ...(opened!.event as AlertEvent & { kind: 'fire' }), record: opened!.record! }])

    const recovered = [...drifting, entry({ client_bundle_size: 2_250_000 })]
    const assessment = assessAlerts(index(recovered), stored, { now: NOW })
    const { client, calls } = fakeClient()
    const delivered = await deliverAlertEvent(client, TARGET, assessment.events.find((e) => e.kind === 'resolved')!)
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /repos/acme/app/issues/42/comments',
      'PATCH /repos/acme/app/issues/42',
    ])
    expect(calls[1]!.body).toEqual({ state: 'closed' })
    expect(delivered?.record).toBeNull()
  })

  it('an issue a human deleted is not an error — a fresh one is opened', async () => {
    const opened = await deliverAlertEvent(fakeClient().client, TARGET, fireEvent(drifting))
    const stored = nextState(emptyAlertState(), [{ ...(opened!.event as AlertEvent & { kind: 'fire' }), record: opened!.record! }])

    const worse = [...drifting, ...ramp(drifting.at(-1)!.metrics.client_bundle_size!.value, 12, 0.9).slice(1)]
    const gone = Object.assign(new Error('Not Found'), { status: 404 })
    const { client, calls } = fakeClient({ 'POST /repos/acme/app/issues/42/comments': gone })
    const delivered = await deliverAlertEvent(client, TARGET, fireEvent(worse, stored))

    expect(calls.map((c) => c.path)).toEqual(['/repos/acme/app/issues/42/comments', '/repos/acme/app/issues'])
    expect(delivered?.action).toBe('opened')
  })
})

describe('silence — the normal state, and the one that must be trustworthy', () => {
  it('a quiet assessment makes ZERO API calls and says why in one line', async () => {
    // A history that is going nowhere: five points, byte-identical give or take a few bytes.
    const quiet = index([
      entry({ client_bundle_size: 2_200_000, build_time: 30_000 }),
      entry({ client_bundle_size: 2_200_040, build_time: 30_200 }),
      entry({ client_bundle_size: 2_199_980, build_time: 29_900 }),
      entry({ client_bundle_size: 2_200_010, build_time: 30_100 }),
      entry({ client_bundle_size: 2_200_030, build_time: 30_050 }),
    ])
    const assessment = assessAlerts(quiet, emptyAlertState(), { now: NOW })

    let called = 0
    const outcome = await publishAlerts(assessment, emptyAlertState(), {
      ...TARGET,
      token: 'must-not-be-used',
      fetchImpl: (async () => {
        called += 1
        throw new Error('the quiet path must not touch the network')
      }) as unknown as typeof fetch,
    })

    expect(called).toBe(0)
    expect(outcome.delivered).toEqual([])
    expect(outcome.quiet).toBe(true)
    expect(outcome.log).toBe(
      'driftwatch alerts: quiet — nothing created, nothing commented ' +
        '(1 metric(s) assessed, none past the 10% line; 0 open condition(s); 1 never alerted (licence))',
    )
    // Nothing said ⇒ nothing recorded.
    expect(outcome.state).toEqual(emptyAlertState())
  })

  it('a held-open condition is silent too, and the line says it is being held', async () => {
    const drifting = ramp(2_200_000, 13, 0.8)
    const first = assessAlerts(index(drifting), emptyAlertState(), { now: NOW })
    const assessment = assessAlerts(index(drifting), first.state, { now: NOW })

    const outcome = await publishAlerts(assessment, first.state, { ...TARGET, token: 't' })

    expect(outcome.delivered).toEqual([])
    expect(outcome.log).toMatch(/quiet — nothing created, nothing commented/)
    expect(outcome.log).toMatch(/1 open condition\(s\), 1 held quiet/)
    expect(outcome.state).toEqual(first.state)
  })

  it('a failed publish records nothing, so the next run says it again', async () => {
    const drifting = ramp(2_200_000, 13, 0.8)
    const assessment = assessAlerts(index(drifting), emptyAlertState(), { now: NOW })

    const outcome = await publishAlerts(assessment, emptyAlertState(), {
      ...TARGET,
      token: 't',
      fetchImpl: (async () => {
        throw new Error('network down')
      }) as unknown as typeof fetch,
    })

    expect(outcome.delivered).toEqual([])
    expect(outcome.warnings.join(' ')).toMatch(/client_bundle_size/)
    expect(outcome.state).toEqual(emptyAlertState())
    expect(outcome.log).toMatch(/nothing recorded, so the next run will try again/)
  })

  it('without a token the decision still happens and nothing is invented', async () => {
    const drifting = ramp(2_200_000, 13, 0.8)
    const assessment = assessAlerts(index(drifting), emptyAlertState(), { now: NOW })

    const outcome = await publishAlerts(assessment, emptyAlertState(), TARGET)

    expect(outcome.delivered).toEqual([])
    expect(outcome.state).toEqual(emptyAlertState())
    expect(outcome.warnings[0]).toMatch(/GITHUB_TOKEN is not set/)
    expect(outcome.log).toMatch(/no token to say them with/)
  })
})

describe('applyState wiring the surface handle', () => {
  it('carries the handle forward when the same condition widens', () => {
    const drifting = ramp(2_200_000, 13, 0.8)
    const withSurface: AlertState = {
      ...emptyAlertState(),
      open: [
        {
          metric: 'client_bundle_size',
          firedAt: NOW,
          atSha: drifting.at(-1)!.sha,
          windowStartSha: drifting[0]!.sha,
          cumulativePercent: 10.91,
          points: 14,
          surface: { kind: SURFACE_KIND, ref: '42' },
        },
      ],
    }
    const worse = [...drifting, ...ramp(drifting.at(-1)!.metrics.client_bundle_size!.value, 12, 0.9).slice(1)]
    const condition = shouldAlert(buildTimelines(index(worse)).find((t) => t.id === 'client_bundle_size')!)
    const event = applyState(condition, withSurface.open[0]!, { now: NOW })

    expect(event.kind).toBe('fire')
    if (event.kind !== 'fire') return
    expect(event.record.surface).toEqual({ kind: SURFACE_KIND, ref: '42' })
  })
})
