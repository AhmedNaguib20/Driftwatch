/** Value formatting for the terminal table. Human units; the JSON keeps raw ms/bytes. */

export function formatValue(value: number | null, unit: 'ms' | 'bytes' | null): string {
  if (value === null) return '\u2014'
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

/**
 * Total, for the same reason as the adapter's copy. In-process the CLI never crossed a JSON
 * boundary, so the one-sided-metric bug reached here as Infinity rather than null and printed
 * "+Infinity%" instead of throwing — wrong quietly rather than loudly, which is worse. Core no
 * longer produces either, and this renders an em dash if anything ever does.
 */
export function formatPercent(percent: number | null | undefined): string {
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return '—'
  const sign = percent > 0 ? '+' : ''
  return `${sign}${percent.toFixed(1)}%`
}

const ANSI_PATTERN = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g')

/** ANSI-aware padding so colored cells still align. */
export function padVisible(text: string, width: number): string {
  const visible = visibleLength(text)
  return visible >= width ? text : text + ' '.repeat(width - visible)
}

export function visibleLength(text: string): number {
  return text.replace(ANSI_PATTERN, '').length
}
