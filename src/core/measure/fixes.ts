import type { ProjectProfile } from '../detect/types.js'
import { formatCommand } from './run-command.js'

/**
 * Fix stanzas for measurement failures (spec §9a: *every failure carries its own fix*).
 *
 * The M3/M6 error stanzas ship the exact YAML or command to paste; the measurement path shipped
 * nothing. These are the failures the jinni trial actually hit, each answered with a command or a
 * config line — never advice. A remedy we cannot name is omitted rather than padded with
 * "check your setup" (fabricated helpfulness is rule 3 in reverse).
 */

/** The install failed. The package manager's own words already printed; name the likely cause. */
export function installFixHint(profile: ProjectProfile, errorTail: string): string | undefined {
  const command = profile.commands.install ? formatCommand(profile.commands.install) : 'the install command'

  // The jinni case: npm cannot resolve pnpm/yarn workspace: protocol deps.
  if (/EUNSUPPORTEDPROTOCOL|Unsupported URL Type "workspace:"/i.test(errorTail)) {
    return [
      `\`${command}\` cannot resolve \`workspace:*\` dependencies — those exist only inside a`,
      'pnpm/yarn workspace, and driftwatch measured this app on its own.',
      'This project looks like a monorepo package. Point driftwatch at the workspace root, or',
      'set the package manager explicitly in perf.yml:',
      '',
      '    package_manager: pnpm',
    ].join('\n')
  }
  if (/ERR_PNPM_NO_LOCKFILE|--frozen-lockfile/i.test(errorTail)) {
    return [
      `\`${command}\` refuses to install without a matching lockfile.`,
      'Commit the lockfile, or drop the frozen flag for this project in perf.yml:',
      '',
      '    install: pnpm install --no-frozen-lockfile',
    ].join('\n')
  }
  if (/EACCES|permission denied/i.test(errorTail)) {
    return 'The install could not write to its cache directory — check the permissions on your package manager cache, then re-run.'
  }
  if (/ENOTFOUND|ETIMEDOUT|network|ECONNREFUSED/i.test(errorTail)) {
    return 'The install could not reach the registry. Driftwatch needs one install per side; re-run when the network is back, or pre-install and re-run so the existing node_modules is cloned instead.'
  }
  return undefined
}

/** node_modules absent and no install was possible. */
export const DEPS_MISSING_FIX =
  'Install dependencies in the project first (driftwatch clones an existing node_modules into the\nmeasurement copy, which is faster and avoids a network round-trip), or let it install by removing\n`--no-install` from the run.'

/** The build produced nothing to weigh. */
export function buildOutputFix(profile: ProjectProfile): string {
  const build = profile.commands.build ? formatCommand(profile.commands.build) : 'your build command'
  const dirs = profile.buildOutputDirs.length > 0 ? profile.buildOutputDirs.join(', ') : '.next'
  return [
    `The build must succeed before there is anything to weigh. Reproduce it exactly as driftwatch runs it:`,
    '',
    `    ${build}`,
    '',
    `Driftwatch weighs ${dirs} after a cold build; the failure above is the build's own output.`,
  ].join('\n')
}

/** No server to boot: the Layer 2a metrics all depend on a successful build. */
export const NO_SERVER_FIX =
  'Route and browser metrics need the built app running. Fix the build above and they return\nautomatically; to measure build and bundle only, run with `--no-serve`.'

/**
 * User-facing name for a measurement workspace. "workspace" is OUR word and collides head-on with
 * the monorepo meaning (pnpm/yarn workspaces) — in a monorepo, "dependencies are not installed in
 * the workspace" reads as a claim about the user's repo (spec §9a). Internal identifiers keep the
 * old name; every string a user reads uses these.
 */
export function describeWorkspace(kind: 'copy' | 'worktree'): string {
  return kind === 'worktree' ? 'base checkout (temp worktree)' : 'measurement copy'
}
