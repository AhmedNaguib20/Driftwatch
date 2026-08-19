import type { DriftReport } from '../drift.js'
import type { MetricTimeline } from '../timeline.js'
import { escapeHtml, formatValue } from './format.js'

/**
 * One metric's chart: hand-rolled inline SVG, zero JS. §5.1 is the rendering brief:
 *  - segments are SEPARATE polylines — nothing is drawn across a protocol break;
 *  - breaks get a dashed vertical marker whose native <title> names the changed fields;
 *  - sparse gaps (entries where the metric is missing) split the line — never interpolated;
 *  - tooltips are native <title> on oversized hit circles (works offline, file://, no script).
 */

const W = 640
const H = 120
const PAD = { top: 10, right: 12, bottom: 8, left: 56 }

export function renderChart(
  timeline: MetricTimeline,
  drift: DriftReport,
  entryIndexOf: (sha: string) => number,
  entryCount: number,
): string {
  const points = timeline.segments.flatMap((s) => s.points)
  if (points.length === 0) return ''

  const values = points.map((p) => p.value)
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const span = hi - lo || Math.max(hi, 1) * 0.1
  const yLo = lo - span * 0.15
  const yHi = hi + span * 0.15

  const x = (sha: string) =>
    entryCount <= 1
      ? PAD.left + (W - PAD.left - PAD.right) / 2
      : PAD.left + ((W - PAD.left - PAD.right) * entryIndexOf(sha)) / (entryCount - 1)
  const y = (v: number) => PAD.top + (H - PAD.top - PAD.bottom) * (1 - (v - yLo) / (yHi - yLo))

  const parts: string[] = []

  // Y ticks: floor and ceiling of the observed range, quiet.
  for (const v of [lo, hi]) {
    const ty = y(v)
    parts.push(
      `<line class="grid" x1="${PAD.left}" y1="${ty.toFixed(1)}" x2="${W - PAD.right}" y2="${ty.toFixed(1)}"/>`,
      `<text class="tick" x="${PAD.left - 6}" y="${(ty + 3).toFixed(1)}" text-anchor="end">${escapeHtml(formatValue(v, timeline.unit))}</text>`,
    )
  }

  // Break markers between segments.
  for (const brk of timeline.breaks) {
    const before = entryIndexOf(brk.beforeSha)
    const after = entryIndexOf(brk.afterSha)
    const bx =
      entryCount <= 1
        ? PAD.left
        : PAD.left + ((W - PAD.left - PAD.right) * (before + after)) / 2 / (entryCount - 1)
    parts.push(
      `<g class="break"><line x1="${bx.toFixed(1)}" y1="${PAD.top}" x2="${bx.toFixed(1)}" y2="${H - PAD.bottom}"/>` +
        `<title>protocol break — no line is drawn across this (§5.1)\n${escapeHtml(brk.changes.join('\n'))}</title></g>`,
    )
  }

  // Segments: separate polylines, split again at sparse gaps.
  for (const segment of timeline.segments) {
    const runs: (typeof segment.points)[number][][] = []
    let run: (typeof segment.points)[number][] = []
    let prevIndex = -2
    for (const point of segment.points) {
      const idx = entryIndexOf(point.sha)
      if (run.length > 0 && idx - prevIndex > 1) {
        runs.push(run)
        run = []
      }
      run.push(point)
      prevIndex = idx
    }
    if (run.length > 0) runs.push(run)

    for (const r of runs) {
      if (r.length > 1) {
        const path = r.map((p) => `${x(p.sha).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ')
        parts.push(`<polyline class="line" points="${path}"/>`)
      }
      for (const p of r) {
        const cx = x(p.sha).toFixed(1)
        const cy = y(p.value).toFixed(1)
        parts.push(
          `<g><circle class="dot" cx="${cx}" cy="${cy}" r="3"/>` +
            `<circle class="hit" cx="${cx}" cy="${cy}" r="9"/>` +
            `<title>${escapeHtml(`${p.shortSha} · ${formatValue(p.value, timeline.unit)} · ${p.timestamp}`)}</title></g>`,
        )
      }
    }
  }

  // Selective direct label: the latest point only; flips to the left near the right edge.
  const last = points.at(-1)!
  const lastX = x(last.sha)
  const overflows = lastX + 60 > W - PAD.right
  parts.push(
    `<text class="latest" x="${(overflows ? lastX - 8 : lastX + 8).toFixed(1)}" y="${(y(last.value) - 8).toFixed(1)}"${overflows ? ' text-anchor="end"' : ''}>${escapeHtml(formatValue(last.value, timeline.unit))}</text>`,
  )

  void drift
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(timeline.id)} trend">${parts.join('')}</svg>`
}
