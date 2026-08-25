import pc from 'picocolors'
import {
  buildStamp,
  configFromProfile,
  describeKeySource,
  detectProject,
  keyChecks,
  loadConfig,
  reportFrom,
  resolveAiKey,
} from '../core/index.js'
import type { CheckState, DoctorCheck, DoctorReport } from '../core/index.js'

/**
 * `driftwatch doctor` — "would AI analysis work right now, and if not, what exactly is wrong?"
 *
 * It reports; it never fixes and never writes. The exit code is the part worth stating plainly:
 * **0 when everything checked is healthy AND 0 when there is simply no key.** A user who never
 * wanted the AI tier must never see a red doctor — the free tier is not a degraded state, and a
 * diagnostic that calls it one is telling them they have a problem they do not have. 1 is
 * reserved for something the user CONFIGURED and that is broken.
 */
export async function doctorCommand(flags: { json: boolean; cwd: string }): Promise<void> {
  const profile = await detectProject({ cwd: flags.cwd })
  const config = await loadConfig(profile.projectRoot, configFromProfile(profile))

  const resolved = await resolveAiKey({ provider: config.provider, key_command: config.key_command })
  const checks: DoctorCheck[] = keyChecks(resolved, config.provider)

  // The AI module graph is loaded only once a key exists — the same rule that makes `--no-ai`
  // provable at the module level, applied to the diagnostic that talks about it.
  if (resolved.key) {
    const { providerChecks } = await import('../ai/doctor.js')
    checks.push(
      ...(await providerChecks({
        provider: config.provider,
        model: config.model,
        key: resolved.key,
        keySourceLabel: describeKeySource(resolved.source, { redactCommand: true }),
      })),
    )
  }

  const report = reportFrom(checks, resolved.key !== null)

  if (flags.json) {
    console.log(JSON.stringify({ ...report, build: buildStamp() }, null, 2))
  } else {
    console.log(render(report))
  }
  process.exitCode = report.exitCode
}

export function render(report: DoctorReport): string {
  const lines: string[] = [pc.bold('driftwatch doctor'), pc.dim(buildStamp()), '']
  const width = Math.max(...report.checks.map((c) => c.label.length))

  for (const check of report.checks) {
    lines.push(`  ${badge(check.state)} ${pad(check.label, width)}  ${check.detail}`)
    // A fix is printed wherever one exists — including the no-key case, where the "fix" is the
    // description of a free tier that is working correctly.
    if (check.fix) {
      lines.push('')
      for (const line of check.fix.split('\n')) lines.push(pc.dim(`       ${line}`))
      lines.push('')
    }
  }

  lines.push('')
  lines.push(closing(report))
  return lines.join('\n')
}

function closing(report: DoctorReport): string {
  if (report.exitCode === 1) {
    return pc.red('  something you configured is not working — the lines marked ✗ say what.')
  }
  if (!report.tierEnabled) {
    return pc.green('  measurement is ready. The AI tier is off, which is a choice, not a fault.')
  }
  const warned = report.checks.some((c) => c.state === 'warn')
  return warned
    ? pc.yellow('  the AI tier will run. Read the ! lines — nothing is broken, but something is not what you asked for.')
    : pc.green('  the AI tier is ready.')
}

function badge(state: CheckState): string {
  switch (state) {
    case 'ok':
      return pc.green('✓')
    case 'warn':
      return pc.yellow('!')
    case 'fail':
      return pc.red('✗')
    case 'info':
      return pc.dim('·')
  }
}

function pad(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - text.length))
}
