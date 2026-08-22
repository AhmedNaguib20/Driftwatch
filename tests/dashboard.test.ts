import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  assessDrift,
  buildTimelines,
  emptyIndex,
  renderDashboard,
} from '../src/core/index.js'
import type { IndexEntry, IndexFile, ProtocolIdentity } from '../src/core/index.js'

function protocol(overrides: Partial<ProtocolIdentity> = {}): ProtocolIdentity {
  return {
    nodeVersion: 'v24.18.0', platform: 'linux', arch: 'x64',
    browser: 'chrome/151.0.7922.108', hostLabels: ['os:Linux'], driftwatchVersion: '0.5.0',
    ...overrides,
  }
}

let counter = 0
function entry(metrics: Record<string, number>, proto = protocol()): IndexEntry {
  counter += 1
  const sha = String(counter).padStart(2, '0').repeat(20).slice(0, 40)
  return {
    sha, shortSha: sha.slice(0, 12),
    timestamp: `2026-08-${String(counter).padStart(2, '0')}T00:00:00.000Z`,
    branch: 'main',
    metrics: Object.fromEntries(Object.entries(metrics).map(([id, value]) => [id, { value, unit: id.includes('size') ? 'bytes' as const : 'ms' as const }])),
    protocol: proto,
  }
}

function render(index: IndexFile): string {
  const reports = buildTimelines(index).map((timeline) => ({ timeline, drift: assessDrift(timeline) }))
  return renderDashboard({ reports, index, generatedAt: '2026-08-19T12:00:00.000Z', sourceLabel: 'main' })
}

function mixedIndex(): IndexFile {
  counter = 0
  return {
    ...emptyIndex(),
    entries: [
      entry({}), // the real branch's empty first entry
      entry({ build_time: 30000, client_bundle_size: 2313028, 'route_latency:/live': 15, 'lcp:/': 1880 }),
      entry({ build_time: 30240, client_bundle_size: 2313100, 'lcp:/': 1890 }), // route missing → gap
      entry({ build_time: 30480, client_bundle_size: 2313150, 'route_latency:/live': 14, 'lcp:/': 1885 }),
      entry({ build_time: 31600, client_bundle_size: 2410000, 'route_latency:/live': 15, 'lcp:/': 1930 }, protocol({ browser: 'chrome/151.0.7922.140' })),
      entry({ build_time: 31700, client_bundle_size: 2410400, 'route_latency:/live': 15, 'lcp:/': 1928 }, protocol({ browser: 'chrome/151.0.7922.140' })),
    ],
  }
}

describe('replayed points and movement emphasis (M7)', () => {
  it('replayed points render hollow with the two-dates tooltip; movement commits get the ring', () => {
    counter = 0
    const a: IndexEntry = { ...entry({ client_bundle_size: 100_000 }), committedAt: '2026-06-01T00:00:00Z', parentSha: null, replayed: true }
    const b: IndexEntry = { ...entry({ client_bundle_size: 145_000 }), committedAt: '2026-06-02T00:00:00Z', parentSha: a.sha, replayed: true }
    const live = entry({ client_bundle_size: 145_200, build_time: 30_000 })
    const html = render({ ...emptyIndex(), entries: [live, a, b] })

    expect(html).toContain('class="dot dot-replayed"')
    expect(html).toContain('replayed — measured 2026-08-01T00:00:00.000Z, committed 2026-06-01T00:00:00Z')
    // b is where bundle_size moved (+45%): the subtle emphasis ring + the tooltip line.
    expect(html).toContain('class="move"')
    expect(html).toContain('moved beyond noise at this commit')
    // Doctrine (spec §10): wall-clock cards carry the caption instead of rings.
    expect(html).toContain('◌ movements not judged — cross-time-gap timing')
    // The live point keeps the filled dot and the plain tooltip.
    expect(html).toContain('class="dot"')
  })
})

describe('dashboard generation', () => {
  it('is byte-stable: fixed input → the golden HTML', async () => {
    const html = render(mixedIndex())
    const golden = path.join(import.meta.dirname, 'golden', 'dashboard.html')
    if (process.env.UPDATE_GOLDEN === '1') await writeFile(golden, html, 'utf8')
    expect(html).toBe(await readFile(golden, 'utf8'))
    expect(render(mixedIndex())).toBe(html) // and deterministic across calls
  })

  it('makes zero network requests: no external refs of any kind', async () => {
    const html = render(mixedIndex())
    // No URL with a scheme anywhere (the SVGs are inline and carry no xmlns).
    expect(html).not.toMatch(/https?:\/\//)
    expect(html).not.toMatch(/<link/i)
    expect(html).not.toMatch(/<script\s+src/i)
    expect(html).not.toMatch(/@import/)
    expect(html).not.toMatch(/url\(/)
    expect(html).not.toMatch(/@font-face/)
  })

  it('renders §5.1: separate polylines per segment, a break marker naming the fields', () => {
    const html = render(mixedIndex())
    const buildCard = html.slice(html.indexOf('<h2>build_time</h2>'))
    const svg = buildCard.slice(0, buildCard.indexOf('</svg>'))
    // Two segments (browser change) → two polylines for build_time.
    expect([...svg.matchAll(/<polyline/g)]).toHaveLength(2)
    expect(svg).toContain('protocol break')
    expect(svg).toContain('browser: chrome/151.0.7922.108 → chrome/151.0.7922.140')
  })

  it('sparse gaps split the line — never interpolated', () => {
    const html = render(mixedIndex())
    const card = html.slice(html.indexOf('<h2>route_latency:/live</h2>'))
    const svg = card.slice(0, card.indexOf('</svg>'))
    // Segment 1 has points at entries 1 and 3 with entry 2 missing → no polyline joins them
    // (single-point runs draw dots only); segment 2 (entries 4,5) draws one polyline.
    expect([...svg.matchAll(/<polyline/g)]).toHaveLength(1)
    expect([...svg.matchAll(/<circle class="dot"/g)].length).toBe(4)
  })

  it('drift chips speak drift language with the number only when it exists', () => {
    const html = render(mixedIndex())
    expect(html).not.toMatch(/regression/i)
    expect(html).toContain('insufficient data') // the post-break 2-point segments

    counter = 0
    const drifting = render({
      ...emptyIndex(),
      entries: [
        entry({ build_time: 30000, client_bundle_size: 100000 }),
        entry({ build_time: 31500, client_bundle_size: 99000 }),
        entry({ build_time: 33500, client_bundle_size: 97000 }),
      ],
    })
    expect(drifting).toContain('▲ drifted +11.7% over 3 points')
    expect(drifting).toContain('▼ improved -3.0% over 3 points')
    expect(drifting).not.toMatch(/regression/i)
  })

  it('escapes hostile content in every context — markup and the JSON island', () => {
    counter = 0
    const hostile = {
      ...emptyIndex(),
      entries: [
        entry({ 'route_latency:/<script>alert(1)</script>': 10 }, protocol({ hostLabels: ['x"><img src=x onerror=alert(2)>', '</script><script>alert(3)</script>'] })),
        entry({ 'route_latency:/<script>alert(1)</script>': 11 }, protocol({ hostLabels: ['x"><img src=x onerror=alert(2)>', '</script><script>alert(3)</script>'] })),
        entry({ 'route_latency:/<script>alert(1)</script>': 12 }, protocol({ browser: '</script><b>' })),
      ],
    }
    const html = render(hostile)
    // Exactly one closing </script> in the whole document: the data island's own terminator —
    // nothing embedded can break out of the island or open an executable script outside it.
    expect([...html.matchAll(/<\/script>/g)]).toHaveLength(1)
    const outsideIsland = html.replace(/<script type="application\/json"[\s\S]*?<\/script>/, '')
    expect(outsideIsland).not.toContain('<script')
    expect(outsideIsland).not.toContain('<img') // raw tag injection
    // hostile text survives as visible, inert, escaped content — quote and angles included:
    expect(outsideIsland).toContain('x&quot;&gt;&lt;img src=x onerror=alert(2)&gt;')
    // The island still parses back to the real values.
    const island = /<script type="application\/json" id="driftwatch-data">([\s\S]*?)<\/script>/.exec(html)![1]!
    const parsed = JSON.parse(island)
    expect(JSON.stringify(parsed)).toContain('alert(1)') // data intact, markup safe
  })

  it('handles the real-branch shape: empty entry + single points, insufficient data everywhere', () => {
    counter = 0
    const html = render({ ...emptyIndex(), entries: [entry({}), entry({ build_time: 30613 })] })
    expect(html).toContain('insufficient data (1 of 3 points)')
    expect(html).toContain('30.61 s')
  })
})
