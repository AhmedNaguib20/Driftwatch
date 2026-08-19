import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  MIN_TREND_POINTS,
  assessDrift,
  buildTimelines,
  emptyIndex,
  identityDiff,
} from '../src/core/index.js'
import type { IndexEntry, IndexFile, ProtocolIdentity } from '../src/core/index.js'

function protocol(overrides: Partial<ProtocolIdentity> = {}): ProtocolIdentity {
  return {
    nodeVersion: 'v24.18.0',
    platform: 'linux',
    arch: 'x64',
    browser: 'chrome/151.0.7922.108',
    hostLabels: ['os:Linux'],
    driftwatchVersion: '0.5.0',
    ...overrides,
  }
}

let counter = 0
function entry(
  metrics: Record<string, number>,
  proto: ProtocolIdentity = protocol(),
  unitFor: (id: string) => 'ms' | 'bytes' = (id) => (id.includes('size') ? 'bytes' : 'ms'),
): IndexEntry {
  counter += 1
  const sha = String(counter).padStart(2, '0').repeat(20).slice(0, 40)
  return {
    sha,
    shortSha: sha.slice(0, 12),
    timestamp: `2026-08-${String(counter).padStart(2, '0')}T00:00:00.000Z`,
    branch: 'main',
    metrics: Object.fromEntries(
      Object.entries(metrics).map(([id, value]) => [id, { value, unit: unitFor(id) }]),
    ),
    protocol: proto,
  }
}

function index(entries: IndexEntry[]): IndexFile {
  return { ...emptyIndex(), entries }
}

describe('segmentation — §5.1 for time-series', () => {
  const FIELD_CASES: [string, Partial<ProtocolIdentity>, RegExp][] = [
    ['node version', { nodeVersion: 'v26.0.0' }, /node: v24\.18\.0 → v26\.0\.0/],
    ['platform/arch', { arch: 'arm64' }, /platform: linux\/x64 → linux\/arm64/],
    ['browser build', { browser: 'chrome/151.0.7922.140' }, /browser: chrome\/151\.0\.7922\.108 → chrome\/151\.0\.7922\.140/],
    ['host labels', { hostLabels: ['os:macOS'] }, /hostLabels: os:Linux → os:macOS/],
    ['driftwatch version', { driftwatchVersion: '0.6.0' }, /driftwatch: 0\.5\.0 → 0\.6\.0/],
  ]

  for (const [name, change, pattern] of FIELD_CASES) {
    it(`breaks the timeline on a ${name} change, naming the fields`, () => {
      const timelines = buildTimelines(
        index([
          entry({ build_time: 9000 }),
          entry({ build_time: 9100 }),
          entry({ build_time: 9050 }, protocol(change)),
        ]),
      )
      const t = timelines.find((x) => x.id === 'build_time')!
      expect(t.segments).toHaveLength(2)
      expect(t.segments[0]!.points).toHaveLength(2)
      expect(t.segments[1]!.points).toHaveLength(1)
      expect(t.breaks).toHaveLength(1)
      expect(t.breaks[0]!.changes.join(' | ')).toMatch(pattern)
    })
  }

  it('one line only within identical protocols — no breaks', () => {
    const timelines = buildTimelines(
      index([entry({ build_time: 9000 }), entry({ build_time: 9100 }), entry({ build_time: 9200 })]),
    )
    expect(timelines[0]!.segments).toHaveLength(1)
    expect(timelines[0]!.breaks).toHaveLength(0)
  })

  it('tolerates sparse and entirely empty entries (the real branch has one)', () => {
    const timelines = buildTimelines(
      index([
        entry({}), // the empty first live entry
        entry({ build_time: 9000, bundle_size: 100000 }),
        entry({ build_time: 9100 }), // bundle missing here
        entry({ bundle_size: 101000 }),
      ]),
    )
    const build = timelines.find((t) => t.id === 'build_time')!
    const bundle = timelines.find((t) => t.id === 'bundle_size')!
    expect(build.segments[0]!.points.map((p) => p.value)).toEqual([9000, 9100])
    expect(bundle.segments[0]!.points.map((p) => p.value)).toEqual([100000, 101000])
  })

  it('a protocol flip-and-back makes three segments, not two', () => {
    const timelines = buildTimelines(
      index([
        entry({ build_time: 1000 }),
        entry({ build_time: 1010 }, protocol({ nodeVersion: 'v26.0.0' })),
        entry({ build_time: 1020 }),
      ]),
    )
    expect(timelines[0]!.segments).toHaveLength(3)
    expect(timelines[0]!.breaks).toHaveLength(2)
  })
})

describe('drift detection', () => {
  it('under 3 points is not a trend — insufficient-data, cumulative withheld', () => {
    const [t] = buildTimelines(index([entry({ build_time: 9000 }), entry({ build_time: 12000 })]))
    const report = assessDrift(t!)
    expect(report.verdict).toBe('insufficient-data')
    expect(report.cumulative).toBeNull()
    expect(report.segmentPoints).toBe(2)
    expect(MIN_TREND_POINTS).toBe(3)
  })

  it('accumulates sub-floor steps into a reported drift — the whole point', () => {
    // 14 commits, each +0.8% (under the 2% floor) — cumulative ≈ +11%.
    const entries = []
    let value = 30000
    for (let i = 0; i < 14; i += 1) {
      entries.push(entry({ build_time: Math.round(value) }))
      value *= 1.008
    }
    const [t] = buildTimelines(index(entries))
    const report = assessDrift(t!)
    expect(report.verdict).toBe('drifting-up')
    expect(report.cumulative!.percent).toBeGreaterThan(10)
    expect(report.cumulative!.percent).toBeLessThan(12)
  })

  it('downward drift is drifting-down — improvements are improvements', () => {
    const [t] = buildTimelines(
      index([entry({ build_time: 10000 }), entry({ build_time: 9500 }), entry({ build_time: 9000 })]),
    )
    expect(assessDrift(t!).verdict).toBe('drifting-down')
    expect(assessDrift(t!).cumulative!.percent).toBe(-10)
  })

  it('judges against the class floor: under 2% cumulative is stable', () => {
    const [t] = buildTimelines(
      index([entry({ build_time: 10000 }), entry({ build_time: 10050 }), entry({ build_time: 10150 })]),
    )
    expect(assessDrift(t!).verdict).toBe('stable') // +1.5%
  })

  it('judges against the class quantum: a 4ms route drifting +50% is under 5ms and stable', () => {
    const [t] = buildTimelines(
      index([
        entry({ 'route_latency:/live': 4 }),
        entry({ 'route_latency:/live': 5 }),
        entry({ 'route_latency:/live': 6 }),
      ]),
    )
    expect(assessDrift(t!).verdict).toBe('stable') // +2ms < 5ms quantum despite +50%
  })

  it('route drift beyond the quantum reports', () => {
    const [t] = buildTimelines(
      index([
        entry({ 'route_latency:/live': 4 }),
        entry({ 'route_latency:/live': 8 }),
        entry({ 'route_latency:/live': 12 }),
      ]),
    )
    const report = assessDrift(t!)
    expect(report.verdict).toBe('drifting-up')
    expect(report.cumulative).toEqual({ absolute: 8, percent: 200 })
  })

  it('drift never crosses a protocol break — only the latest segment is judged', () => {
    const [t] = buildTimelines(
      index([
        entry({ build_time: 9000 }),
        entry({ build_time: 9100 }),
        entry({ build_time: 30000 }, protocol({ nodeVersion: 'v26.0.0' })), // slower machine class
        entry({ build_time: 30100 }, protocol({ nodeVersion: 'v26.0.0' })),
        entry({ build_time: 30200 }, protocol({ nodeVersion: 'v26.0.0' })),
      ]),
    )
    const report = assessDrift(t!)
    expect(report.segmentPoints).toBe(3)
    expect(report.segmentStart!.value).toBe(30000)
    expect(report.verdict).toBe('stable') // +0.67% within the segment; the 3.3x jump is a BREAK, not drift
    expect(report.breaks).toHaveLength(1)
  })

  it('transfer_size uses its 1KB quantum', () => {
    const [t] = buildTimelines(
      index([
        entry({ 'transfer_size:/': 231000 }),
        entry({ 'transfer_size:/': 235000 }),
        entry({ 'transfer_size:/': 238000 }),
      ]),
    )
    const report = assessDrift(t!)
    expect(report.verdict).toBe('drifting-up') // +7000B ≥ 1KB and +3.0% ≥ 2%
  })
})

describe('golden timeline', () => {
  it('the full structure over a mixed index matches its golden file', async () => {
    counter = 100
    const mixed = index([
      entry({}),
      entry({ build_time: 30000, bundle_size: 2313028, 'route_latency:/live': 15 }),
      entry({ build_time: 30240, bundle_size: 2313030, 'route_latency:/live': 14 }),
      entry({ build_time: 30480, 'route_latency:/live': 16 }, protocol({ browser: 'chrome/151.0.7922.140' })),
      entry({ build_time: 30900, bundle_size: 2410000, 'route_latency:/live': 15 }, protocol({ browser: 'chrome/151.0.7922.140' })),
      entry({ build_time: 31200, bundle_size: 2410500, 'route_latency:/live': 15 }, protocol({ browser: 'chrome/151.0.7922.140' })),
    ])
    const rendered =
      JSON.stringify(
        buildTimelines(mixed).map((t) => ({ timeline: t, drift: assessDrift(t) })),
        null,
        2,
      ) + '\n'

    const golden = path.join(import.meta.dirname, 'golden', 'trend-timelines.json')
    if (process.env.UPDATE_GOLDEN === '1') await writeFile(golden, rendered, 'utf8')
    expect(rendered).toBe(await readFile(golden, 'utf8'))
  })
})

describe('identityDiff', () => {
  it('names every changed field and nothing else', () => {
    const diffs = identityDiff(
      protocol(),
      protocol({ browser: 'chrome/151.0.7922.140', driftwatchVersion: '0.6.0' }),
    )
    expect(diffs).toEqual([
      'browser: chrome/151.0.7922.108 → chrome/151.0.7922.140',
      'driftwatch: 0.5.0 → 0.6.0',
    ])
  })
})

describe('benchmarkIndex — normalization data, never identity', () => {
  it('a wildly different benchmarkIndex does NOT split a segment', () => {
    const a = entry({ build_time: 20000 })
    const b = { ...entry({ build_time: 33000 }), benchmarkIndex: 900 }
    const c = { ...entry({ build_time: 20500 }), benchmarkIndex: 2600 }
    const [t] = buildTimelines(index([a, b, c]))
    expect(t!.segments).toHaveLength(1) // same protocol identity throughout
    expect(t!.breaks).toHaveLength(0)
  })
})
