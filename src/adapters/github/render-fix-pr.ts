import type { ResultJson, VerificationReport } from '../../core/index.js'
import { confidenceLabel, formatValue } from './format.js'

export const FIX_PR_MARKER = '<!-- driftwatch:fix-pr -->'

/**
 * The fix PR's body IS the measured evidence. The diff itself is not duplicated here — it is
 * already the PR's Files Changed. Provenance is stated plainly: proposed by AI, verified by
 * measurement, same run.
 */
export function renderFixPrTitle(result: ResultJson, verification: VerificationReport): string {
  const worst = verification.metrics[0]
  const what = worst ? `${worst.label} ${formatValue(worst.current, worst.unit ?? 'bytes')} → ${formatValue(worst.fixed, worst.unit ?? 'bytes')}` : 'regression'
  return verification.outcome === 'partial'
    ? `perf: partially recovers ${what} (measured)`
    : `perf: restores ${what} (measured)`
}

export function renderFixPrBody(result: ResultJson, verification: VerificationReport): string {
  const lines: string[] = [FIX_PR_MARKER, '']

  lines.push(
    '**Proposed by AI analysis, verified by measurement in the same run.** This diff was applied to a fresh copy of the PR tree and measured through the identical pipeline before this PR was opened.',
  )
  lines.push('')

  const overall =
    verification.outcome === 'restored'
      ? '✅ **restored** — every regressed metric back within noise of the baseline'
      : '🟡 **partial recovery** — improved, not fully back to baseline'
  lines.push(overall)
  lines.push('')

  lines.push('| Metric | Base | This PR (regressed) | With this fix | Verdict |')
  lines.push('|---|---|---|---|---|')
  for (const m of verification.metrics) {
    const base = m.base !== null ? formatValue(m.base, m.unit ?? 'bytes') : '—'
    const verdict = m.verdict === 'restored' ? 'restored' : m.verdict === 'partial' ? 'partial' : 'no recovery'
    lines.push(
      `| ${m.label} | ${base} | ${formatValue(m.current, m.unit ?? 'bytes')} | ${formatValue(m.fixed, m.unit ?? 'bytes')} | ${verdict} |`,
    )
  }
  lines.push('')

  if (result.analysis?.outcome === 'analysed') {
    lines.push(`**Cause** (\`confidence ${confidenceLabel(result.analysis.confidence)}\`): ${result.analysis.cause}`)
    lines.push('')
  }

  lines.push(
    `<sub>Verification cost ${(verification.elapsedMs / 1000).toFixed(1)}s of measurement. Merging this PR updates the original PR's branch; the regression comment will flip on the next run. The diff is exactly the bytes that were measured — see Files Changed.</sub>`,
  )

  return lines.join('\n')
}
