import type { MeasurementProtocol } from '../measure/types.js'

/**
 * Field-by-field protocol comparison — the §5.1 enforcement point's evidence.
 *
 * Two exclusions, both deliberate:
 *  - `workspace` kind: the base is always a 'worktree' and the current side a 'copy'. Both are
 *    temp directories built to the same layout; the kind difference is the design, not a mismatch.
 *  - `nodeModules` compares as fresh-install vs preinstalled: cloned/copied are two mechanisms
 *    for the same state (a pre-existing dependency tree), same normalization the cache hash uses.
 */
export function protocolMismatches(
  base: MeasurementProtocol,
  current: MeasurementProtocol,
): string[] {
  const mismatches: string[] = []

  const fields: [string, (p: MeasurementProtocol) => string][] = [
    ['protocolVersion', (p) => String(p.version)],
    ['cacheState', (p) => p.cacheState],
    ['installState', (p) => (p.nodeModules === 'fresh-install' ? 'fresh-install' : 'preinstalled')],
    ['gitMetadata', (p) => p.gitMetadata],
    ['nodeVersion', (p) => p.nodeVersion],
    ['platform', (p) => p.platform],
    ['arch', (p) => p.arch],
    ['buildCommand', (p) => p.buildCommand ?? '(none)'],
    ['buildSamples', (p) => String(p.buildSamples)],
    ['env', (p) => formatEnv(p.env)],
  ]

  for (const [name, pick] of fields) {
    const b = pick(base)
    const c = pick(current)
    if (b !== c) mismatches.push(`${name}: ${b} (base) vs ${c} (current)`)
  }

  return mismatches
}

function formatEnv(env: Readonly<Record<string, string>>): string {
  const entries = Object.entries(env).sort(([a], [b]) => (a < b ? -1 : 1))
  return entries.length === 0 ? '(none)' : entries.map(([k, v]) => `${k}=${v}`).join(',')
}
