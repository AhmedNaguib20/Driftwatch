import type { DriftReport } from '../drift.js'
import type { IndexFile } from '../index-file.js'
import { findMovements } from '../movement.js'
import { orderEntries } from '../order.js'
import type { MetricTimeline } from '../timeline.js'
import { renderChart } from './chart.js'
import { escapeHtml, escapeJsonForScript, formatValue } from './format.js'

/**
 * The static dashboard (spec §6.3): ONE self-contained HTML file. Zero network requests — no CDN,
 * no external fonts, no fetch: the data is embedded at generation time, which also makes every
 * dashboard an honest snapshot. Renders the step-2 {timeline, drift} structures verbatim; no
 * recomputation happens in the browser (there is no script at all beyond the inert data island).
 */

export interface DashboardInput {
  readonly reports: readonly { readonly timeline: MetricTimeline; readonly drift: DriftReport }[]
  readonly index: Pick<IndexFile, 'entries'>
  /** Injected so generation is byte-stable for golden tests. */
  readonly generatedAt: string
  readonly sourceLabel: string | null
}

const KEY_ORDER = ['build_time', 'bundle_size', 'install_time']

export function renderDashboard(input: DashboardInput): string {
  // History order, not append order (M7): x-positions and "latest" follow commit topology.
  const entries = orderEntries(input.index.entries)
  const entryShas = entries.map((e) => e.sha)
  const entryIndexOf = (sha: string) => Math.max(0, entryShas.indexOf(sha))
  const ordered = orderReports(input.reports)

  // Movement emphasis (M7): the same floor+quanta machinery, computed once for every card.
  const movedAt = new Map(
    findMovements({ tool: 'driftwatch', schemaVersion: 1, entries: input.index.entries }).map(
      (m) => [m.id, new Set(m.movements.map((mv) => mv.toSha))],
    ),
  )
  const cards = ordered
    .map(({ timeline, drift }) =>
      renderCard(timeline, drift, entryIndexOf, entryShas.length, movedAt.get(timeline.id) ?? new Set()),
    )
    .join('\n')

  const latest = entries.at(-1) ?? null
  const latestProtocol = latest?.protocol ?? null
  const dataIsland = escapeJsonForScript(
    JSON.stringify({ generatedAt: input.generatedAt, reports: input.reports }),
  )

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Driftwatch — trend</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <h1>Driftwatch <span class="dim">— where has ${escapeHtml(input.sourceLabel ?? 'this project')} been going?</span></h1>
  <p class="dim">${input.index.entries.length} recorded commit(s) · data through ${escapeHtml(input.generatedAt)} · trend language is <em>drift</em>, never a verdict</p>
</header>
${latestProtocol ? protocolLegend(latestProtocol, latest?.benchmarkIndex ?? null) : ''}
<main>
${cards}
</main>
<footer class="dim">Segments are separated at protocol breaks — no line is ever drawn across one (§5.1). Gaps in a line are entries where this metric was not measured; they are never interpolated.</footer>
<script type="application/json" id="driftwatch-data">${dataIsland}</script>
</body>
</html>
`
}

function orderReports(
  reports: readonly { timeline: MetricTimeline; drift: DriftReport }[],
): { timeline: MetricTimeline; drift: DriftReport }[] {
  const byId = new Map(reports.map((r) => [r.timeline.id, r]))
  const out: { timeline: MetricTimeline; drift: DriftReport }[] = []
  for (const id of KEY_ORDER) {
    const r = byId.get(id)
    if (r) out.push(r)
  }
  const routesOf = (prefix: string) =>
    [...byId.keys()].filter((id) => id.startsWith(prefix)).sort()
  for (const id of routesOf('route_latency:')) out.push(byId.get(id)!)
  const lhRoutes = [...new Set(
    [...byId.keys()]
      .filter((id) => /^(lcp|tbt|fcp|transfer_size):/.test(id))
      .map((id) => id.split(':').slice(1).join(':')),
  )].sort()
  for (const route of lhRoutes) {
    for (const kind of ['lcp', 'tbt', 'fcp', 'transfer_size']) {
      const r = byId.get(`${kind}:${route}`)
      if (r) out.push(r)
    }
  }
  for (const r of reports) if (!out.includes(r)) out.push(r)
  return out
}

function renderCard(
  timeline: MetricTimeline,
  drift: DriftReport,
  entryIndexOf: (sha: string) => number,
  entryCount: number,
  movedAt: ReadonlySet<string>,
): string {
  const chip = driftChip(drift)
  const latest = drift.latest ? formatValue(drift.latest.value, drift.unit) : '—'
  const breaks =
    timeline.breaks.length > 0
      ? `<p class="breaks">⚡ ${timeline.breaks
          .map((b) => escapeHtml(`${b.beforeSha.slice(0, 7)} → ${b.afterSha.slice(0, 7)}: ${b.changes.join(' | ')}`))
          .join('<br>⚡ ')}</p>`
      : ''
  return `<section class="card">
  <div class="card-head">
    <h2>${escapeHtml(timeline.id)}</h2>
    <span class="current">${escapeHtml(latest)}</span>
    ${chip}
  </div>
  ${renderChart(timeline, drift, entryIndexOf, entryCount, movedAt)}
  ${breaks}
</section>`
}

/** Status colors never carry meaning alone: every chip is icon + words (drift, not a verdict). */
function driftChip(drift: DriftReport): string {
  switch (drift.verdict) {
    case 'insufficient-data':
      return `<span class="chip chip-muted">◌ insufficient data (${drift.segmentPoints} of 3 points)</span>`
    case 'stable':
      return `<span class="chip chip-muted">— stable over ${drift.segmentPoints} points</span>`
    case 'drifting-up':
      return `<span class="chip chip-up">▲ drifted +${drift.cumulative!.percent.toFixed(1)}% over ${drift.segmentPoints} points</span>`
    case 'drifting-down':
      return `<span class="chip chip-down">▼ improved ${drift.cumulative!.percent.toFixed(1)}% over ${drift.segmentPoints} points</span>`
  }
}

function protocolLegend(
  protocol: {
    nodeVersion: string
    platform: string
    arch: string
    browser: string
    hostLabels: readonly string[]
    driftwatchVersion: string
  },
  benchmarkIndex: number | null,
): string {
  const items: [string, string][] = [
    ['node', protocol.nodeVersion],
    ['platform', `${protocol.platform}/${protocol.arch}`],
    ['browser', protocol.browser],
    ['host', protocol.hostLabels.length > 0 ? protocol.hostLabels.join(', ') : '(unlabelled)'],
    ['driftwatch', protocol.driftwatchVersion],
  ]
  const benchmark =
    benchmarkIndex !== null
      ? ` <span class="pill"><b>benchmark</b> ${escapeHtml(String(benchmarkIndex))} <span class="dim">(machine speed — informational, never splits segments)</span></span>`
      : ''
  return `<aside class="protocol"><span class="dim">current protocol</span> ${items
    .map(([k, v]) => `<span class="pill"><b>${escapeHtml(k)}</b> ${escapeHtml(v)}</span>`)
    .join(' ')}<span class="dim"> — a change in any of these starts a new segment</span>${benchmark}</aside>`
}

/** Palette per the dataviz reference instance: single series hue, status chips, selected dark steps. */
const CSS = `
:root {
  color-scheme: light;
  --surface: #fcfcfb; --card: #ffffff; --text: #0b0b0b; --text-2: #52514e; --muted: #8a8984;
  --line: #2a78d6; --grid: #e7e6e2; --border: #e2e1dc;
  --up-bg: #fdf1d7; --up-fg: #7a5200; --down-bg: #e3f4e3; --down-fg: #0a5c0a;
  --break: #8a8984;
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --surface: #1a1a19; --card: #232322; --text: #ffffff; --text-2: #c3c2b7; --muted: #85847d;
    --line: #3987e5; --grid: #33332f; --border: #3a3935;
    --up-bg: #3d2f10; --up-fg: #fab219; --down-bg: #10310f; --down-fg: #4cc24c;
    --break: #85847d;
  }
}
* { box-sizing: border-box; }
body { margin: 0 auto; max-width: 760px; padding: 28px 20px 60px; background: var(--surface); color: var(--text);
  font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
h1 { font-size: 20px; margin: 0 0 4px; } h2 { font-size: 13px; margin: 0; font-weight: 600; }
.dim { color: var(--text-2); font-weight: 400; }
header p { margin: 0 0 14px; font-size: 12.5px; }
.protocol { display: block; font-size: 12px; margin-bottom: 18px; line-height: 2; }
.pill { border: 1px solid var(--border); border-radius: 999px; padding: 2px 8px; white-space: nowrap; }
.pill b { font-weight: 600; }
.card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px 8px; margin-bottom: 14px; }
.card-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 4px; flex-wrap: wrap; }
.current { font-size: 16px; font-weight: 700; font-variant-numeric: tabular-nums; }
.chip { font-size: 11.5px; border-radius: 999px; padding: 2px 9px; margin-left: auto; }
.chip-muted { color: var(--text-2); border: 1px solid var(--border); }
.chip-up { background: var(--up-bg); color: var(--up-fg); }
.chip-down { background: var(--down-bg); color: var(--down-fg); }
.breaks { font-size: 11.5px; color: var(--text-2); margin: 4px 0 4px; }
svg { display: block; width: 100%; height: auto; }
.grid { stroke: var(--grid); stroke-width: 1; }
.tick { fill: var(--text-2); font-size: 10px; font-family: inherit; }
.latest { fill: var(--text); font-size: 10.5px; font-weight: 600; font-family: inherit; }
.line { fill: none; stroke: var(--line); stroke-width: 2; stroke-linejoin: round; }
.dot { fill: var(--line); }
.dot-replayed { fill: var(--card); stroke: var(--line); stroke-width: 1.5; }
.move { fill: none; stroke: var(--line); stroke-width: 1; opacity: 0.45; }
.hit { fill: transparent; }
.break line { stroke: var(--break); stroke-width: 1.5; stroke-dasharray: 3 4; }
footer { margin-top: 24px; font-size: 11.5px; }
`
