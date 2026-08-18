/**
 * Value formatting for the PR comment. Deliberately local to this adapter: core emits JSON only
 * and every surface renders it (spec §3.1) — the CLI's terminal formatting and this markdown
 * formatting are separate products that will diverge.
 */

export function formatValue(value: number | null, unit: 'ms' | 'bytes' | null): string {
  if (value === null) return '—'
  if (unit === 'ms') return formatMs(value)
  if (unit === 'bytes') return formatBytes(value)
  return String(value)
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`
  const minutes = Math.floor(ms / 60_000)
  return `${minutes}m ${((ms - minutes * 60_000) / 1000).toFixed(0)}s`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

export function formatPercent(percent: number): string {
  return `${percent > 0 ? '+' : ''}${percent.toFixed(1)}%`
}

/** The number always shows; the word is calibrated, never inflated (same bands as the CLI). */
export function confidenceLabel(confidence: number): string {
  const pct = `${Math.round(confidence * 100)}%`
  if (confidence >= 0.9) return `${pct} (high)`
  if (confidence >= 0.7) return `${pct} (likely)`
  if (confidence >= 0.5) return `${pct} (possible)`
  return `${pct} (low — a lead, not a conclusion)`
}

export function formatTokens(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`
}
