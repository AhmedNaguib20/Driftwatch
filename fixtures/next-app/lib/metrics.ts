export type Sample = { day: string; buildTime: number; bundleKb: number }

/** Deterministic pseudo-data — the fixture must build identically on every run (observation PR). */
export function series(points = 24): Sample[] {
  const out: Sample[] = []
  for (let i = 0; i < points; i += 1) {
    const wobble = Math.sin(i / 3) * 4
    out.push({
      day: `D${String(i + 1).padStart(2, '0')}`,
      buildTime: Number((32 + wobble + i * 0.35).toFixed(2)),
      bundleKb: Number((412 + wobble * 2 + i * 1.1).toFixed(1)),
    })
  }
  return out
}
