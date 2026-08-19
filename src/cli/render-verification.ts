import pc from 'picocolors'
import type { ResultJson, VerificationReport } from '../core/index.js'
import { formatValue } from './format.js'

/** The verification block, after analysis: measured proof (or honest failure) of the AI's diff. */
export function renderVerification(verification: VerificationReport): string {
  const lines: string[] = ['']

  switch (verification.outcome) {
    case 'skipped':
      return '' // gates not met — nothing was attempted, nothing to report
    case 'not-applicable':
      return `\n${pc.yellow('fix not verified:')} ${verification.reason}`
    case 'refused':
      return `\n${pc.yellow('fix verification refused (§5.1):')} ${verification.reason}`
    case 'build-broken':
      return [
        '',
        pc.red('fix verified: BUILD BROKEN — the suggested diff does not build.'),
        pc.dim(`  ${(verification.reason ?? '').split('\n').slice(0, 8).join('\n  ')}`),
      ].join('\n')
    case 'restored':
    case 'partial':
    case 'no-recovery': {
      const badge =
        verification.outcome === 'restored'
          ? pc.green('restored')
          : verification.outcome === 'partial'
            ? pc.yellow('partial recovery')
            : pc.red('no recovery')
      lines.push(pc.bold(`fix verified (measured, same invocation): ${badge}`))
      for (const m of verification.metrics) {
        const verdict =
          m.verdict === 'restored' ? pc.green('restored') : m.verdict === 'partial' ? pc.yellow('partial') : pc.red('no recovery')
        const base = m.base !== null ? formatValue(m.base, m.unit) : '—'
        lines.push(
          `  ${m.label}: ${formatValue(m.current, m.unit)} → ${formatValue(m.fixed, m.unit)} (base ${base}) — ${verdict}`,
        )
      }
      lines.push(pc.dim(`  verification cost ${(verification.elapsedMs / 1000).toFixed(1)}s`))
      return lines.join('\n')
    }
  }
}

export function verificationEligible(result: ResultJson): boolean {
  return (
    result.verdict === 'regression' &&
    result.analysis?.outcome === 'analysed' &&
    result.analysis.fix.kind === 'diff'
  )
}
