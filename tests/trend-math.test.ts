import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  MIN_TREND_POINTS,
  assessDrift,
  buildTimelines,
  emptyIndex,
  findMovements,
  identityDiff,
  movementReport,
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

describe('history ordering (M7) — topology first, date fallback, append order for legacy', () => {
  const at = (e: IndexEntry, extra: Partial<IndexEntry>): IndexEntry => ({ ...e, ...extra })

  it('replay-appended older commits sort before newer live entries by commit date', () => {
    const newer = at(entry({ build_time: 310 }), { committedAt: '2026-08-10T00:00:00Z', parentSha: null })
    const older = at(entry({ build_time: 300 }), { committedAt: '2026-08-01T00:00:00Z', parentSha: null, replayed: true })
    // Append order: newer first (live), older appended later by replay.
    const [timeline] = buildTimelines(index([newer, older]))
    expect(timeline!.segments[0]!.points.map((p) => p.sha)).toEqual([older.sha, newer.sha])
  })

  it('parent linkage wins over a wrong date: the child never precedes its parent', () => {
    const parent = at(entry({ build_time: 300 }), { committedAt: '2026-08-05T00:00:00Z', parentSha: null })
    // Author date OLDER than the parent (rebases do this) — topology must still order it after.
    const child = at(entry({ build_time: 310 }), { committedAt: '2026-08-02T00:00:00Z', parentSha: parent.sha })
    const [timeline] = buildTimelines(index([child, parent]))
    expect(timeline!.segments[0]!.points.map((p) => p.sha)).toEqual([parent.sha, child.sha])
  })

  it('legacy entries (no commit fields) order stably: equal keys keep append order', () => {
    // Pre-M7 entries fall back to their measurement timestamp; live appends are chronological,
    // so ordering is the identity on real legacy data (the unchanged goldens prove that on the
    // real-branch shape). This pins the tie-break: identical keys never reorder.
    const same = '2026-08-01T00:00:00.000Z'
    const t1 = { ...entry({ build_time: 300 }), timestamp: same }
    const t2 = { ...entry({ build_time: 310 }), timestamp: same }
    const t3 = { ...entry({ build_time: 320 }), timestamp: same }
    const [timeline] = buildTimelines(index([t1, t2, t3]))
    expect(timeline!.segments[0]!.points.map((p) => p.sha)).toEqual([t1.sha, t2.sha, t3.sha])
  })

  it('a replay batch under one protocol is ONE segment by construction, distinct from live points', () => {
    const todayProto = protocol({ driftwatchVersion: '0.7.0' })
    const live = at(entry({ build_time: 320 }, protocol()), { committedAt: '2026-08-10T00:00:00Z', parentSha: null })
    const r1 = at(entry({ build_time: 300 }, todayProto), { committedAt: '2026-08-01T00:00:00Z', parentSha: null, replayed: true })
    const r2 = at(entry({ build_time: 305 }, todayProto), { committedAt: '2026-08-02T00:00:00Z', parentSha: r1.sha, replayed: true })
    const r3 = at(entry({ build_time: 310 }, todayProto), { committedAt: '2026-08-03T00:00:00Z', parentSha: r2.sha, replayed: true })

    const [timeline] = buildTimelines(index([live, r1, r2, r3]))
    // Replayed points: one clean segment (shared protocol), ordered by topology, BEFORE the live
    // point, separated from it by a protocol break — never joined across.
    expect(timeline!.segments).toHaveLength(2)
    expect(timeline!.segments[0]!.points.map((p) => p.sha)).toEqual([r1.sha, r2.sha, r3.sha])
    expect(timeline!.segments[1]!.points.map((p) => p.sha)).toEqual([live.sha])
    expect(timeline!.breaks[0]!.changes.join()).toContain('driftwatch')
  })
})

describe('movement report (M7) — where history actually changed', () => {
  const at = (e: IndexEntry, extra: Partial<IndexEntry>): IndexEntry => ({ ...e, ...extra })

  it('flags crossings of floor+quantum between adjacent points; improvements count with direction', () => {
    const a = entry({ bundle_size: 100_000 })
    const b = entry({ bundle_size: 140_000 }) // +40%
    const c = entry({ bundle_size: 100_500 }) // −28.2%

    const reports = findMovements(index([a, b, c]))
    expect(reports.map((r) => r.id)).toEqual(['bundle_size'])
    const moves = reports[0]!.movements
    expect(moves).toHaveLength(2)
    expect(moves[0]).toMatchObject({ fromSha: a.sha, toSha: b.sha, direction: 'up', deltaPercent: 40, gap: null })
    expect(moves[1]).toMatchObject({ fromSha: b.sha, toSha: c.sha, direction: 'down', gap: null })
  })

  // Spec §10 doctrine: attribution is licensed to deterministic byte classes in EVERY environment.
  // Wall-clock classes drift across the time gaps a movement spans — locally by thermals (observed:
  // build 9.94→12.47s over one 10-minute replay), on CI by the runner lottery.
  it('never attributes wall-clock classes, however large the jump — but names them as not judged', () => {
    const a = entry({ build_time: 30_000, 'route_latency:/live': 10, 'lcp:/': 1700, 'install_time': 4_000 })
    const b = entry({ build_time: 45_000, 'route_latency:/live': 40, 'lcp:/': 2600, 'install_time': 9_000 })

    expect(findMovements(index([a, b]))).toEqual([])
    const report = movementReport(index([a, b]))
    expect(report.moved).toEqual([])
    expect([...report.notJudged].sort()).toEqual(['build_time', 'install_time', 'lcp:/', 'route_latency:/live'])
  })

  it('transfer_size carries the licence too, under its own 1KB quantum', () => {
    const under = index([entry({ 'transfer_size:/': 231_000 }), entry({ 'transfer_size:/': 231_500 })])
    expect(findMovements(under)).toEqual([]) // +500B < 1KB
    const over = index([entry({ 'transfer_size:/': 231_000 }), entry({ 'transfer_size:/': 256_000 })])
    expect(findMovements(over)[0]?.movements).toHaveLength(1)
  })

  it('a byte delta under the 2% floor is not a movement (the innocent-commit case)', () => {
    // The live proof's innocent commits wobbled bundle_size by 5 bytes on 2.3MB.
    const a = entry({ bundle_size: 2_319_175 })
    const b = entry({ bundle_size: 2_319_170 })
    expect(findMovements(index([a, b]))).toEqual([])
  })

  it('never judges across a protocol break', () => {
    const a = entry({ bundle_size: 100_000 }, protocol({ nodeVersion: 'v20' }))
    const b = entry({ bundle_size: 150_000 }, protocol({ nodeVersion: 'v24' }))
    expect(findMovements(index([a, b]))).toEqual([])
  })

  it('an unmeasured interval names the gap instead of pinning one sha — unbuildable counted', () => {
    const a = at(entry({ bundle_size: 100_000 }), { committedAt: '2026-08-01T00:00:00Z', parentSha: null })
    const broken = at(entry({}), {
      committedAt: '2026-08-02T00:00:00Z', parentSha: a.sha, replayed: true,
      skipped: { reason: 'build failed' },
    })
    const c = at(entry({ bundle_size: 150_000 }), { committedAt: '2026-08-03T00:00:00Z', parentSha: broken.sha })

    const [report] = findMovements(index([a, broken, c]))
    expect(report!.movements[0]).toMatchObject({
      fromSha: a.sha,
      toSha: c.sha,
      gap: { commits: 1, unbuildable: 1 },
    })
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
