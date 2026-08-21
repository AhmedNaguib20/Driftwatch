/**
 * Detect-time warnings that carry their own fix (spec §9a). Named here rather than inlined so the
 * exact text is greppable from a failing run and testable as a contract.
 */

export const WORKSPACE_PROTOCOL_WARNING = [
  'This package declares `workspace:*` dependencies, but no lockfile, `packageManager` field or',
  'workspace file says which package manager owns it — and npm (the fallback) cannot resolve that',
  'protocol at all. Driftwatch will not guess into a guaranteed failure. Name the manager in',
  'perf.yml:',
  '',
  '    package_manager: pnpm',
].join('\n')

/** A workspace with more than one buildable package: the choice must be the user's, never ours. */
export function multiAppRefusal(apps: readonly string[], configPath: string | null): string {
  return [
    `This workspace has ${apps.length} buildable packages, so driftwatch does not know which one to measure:`,
    '',
    ...apps.map((a) => `    ${a}`),
    '',
    'Pick one per run:',
    '',
    `    driftwatch run --app ${apps[0]}`,
    '',
    `or set it once in ${configPath ?? 'perf.yml'}:`,
    '',
    `    app: ${apps[0]}`,
  ].join('\n')
}
