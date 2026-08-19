/** Dashboard-local formatting + escaping. Per-surface rendering: the CLI and the dashboard each
 * render the contract their own way (spec §3.1); values match the CLI's units by convention. */

export function formatValue(value: number, unit: 'ms' | 'bytes'): string {
  return unit === 'ms' ? formatMs(value) : formatBytes(value)
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

/** Every string that reaches markup goes through this — ids, annotations, host labels. */
export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** For the JSON data island: `</script>`-proof without altering the parsed value. */
export function escapeJsonForScript(json: string): string {
  return json.replaceAll('</', '<\\/')
}
