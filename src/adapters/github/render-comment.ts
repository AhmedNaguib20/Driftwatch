import { buildStamp, shortReason, softeningSummary, summariseReason } from '../../core/index.js'
import type { MetricComparison, ResultJson } from '../../core/index.js'
import { formatPercent, formatValue } from './format.js'
import { renderAnalysisFooterParts, renderAnalysisSection } from './render-analysis.js'
import { renderHowMeasuredSlim, renderWhatWasSent } from './render-details.js'

/**
 * result JSON → PR comment markdown. Pure function; the first real consumer of the schema-1.1
 * contract, and it reads NOTHING but the contract. Rendering target: docs/pr-comment-mockup.html.
 * The hidden marker is what upsert targets — one comment per PR, updated in place (§6.1).
 */

export const COMMENT_MARKER = '<!-- driftwatch:comment -->'

export interface CommentOptions {
  /** Link target for the full measurement accounting (the run's step summary). */
  readonly runUrl?: string | null
  /** A verified fix PR (or the honest reason there is none despite a verified fix). */
  readonly fixPr?: { readonly number: number; readonly url: string; readonly summary: string } | null
  readonly fixPrNote?: string | null
}

/**
 * The PR comment: verdict + table + AI + SLIM details. Email evidence drove the shape: Gmail
 * renders <details> expanded, so the exhaustive per-side accounting lives in the run's step
 * summary (renderSummary — same renderer family, mode-aware) and the comment links to it.
 */
export function renderComment(result: ResultJson, options: CommentOptions = {}): string {
  const lines: string[] = [COMMENT_MARKER, '']

  lines.push(...verdictBanner(result))
  if (options.fixPr) {
    lines.push('')
    lines.push(`✓ **verified fix available:** [#${options.fixPr.number}](${options.fixPr.url}) (${options.fixPr.summary})`)
  } else if (options.fixPrNote) {
    lines.push('')
    lines.push(`_${options.fixPrNote}_`)
  } else {
    const line = verificationLine(result)
    if (line) {
      lines.push('')
      lines.push(line)
    }
  }
  lines.push('')
  lines.push(...comparisonTable(result))
  lines.push(...softeningBlock(result))
  lines.push(...fixBlocks(result))
  lines.push(...renderAnalysisSection(result))
  lines.push('')
  lines.push(renderHowMeasuredSlim(result, options.runUrl ?? null))
  const sent = renderWhatWasSent(result)
  if (sent) {
    lines.push('')
    lines.push(sent)
  }
  lines.push('')
  lines.push('---')
  lines.push(footer(result))

  return lines.join('\n')
}

/** The check run's markdown: verdict + table only — visible even where the comment cannot post. */
export function renderCheckSummary(result: ResultJson): string {
  return [...verdictBanner(result), '', ...comparisonTable(result)].join('\n')
}

/** One line for the check title / commit status description. */
export function renderCheckTitle(result: ResultJson): string {
  switch (result.verdict) {
    case 'regression': {
      const worst = result.comparison.metrics
        .filter((m) => m.verdict === 'regressed' && m.exceedsThreshold)
        .map((m) => `${m.label} ${formatPercent(m.delta!.percent)}`)
        .join(', ')
      return `${worst} (threshold ${result.config.thresholdPercent}%)`
    }
    case 'ok':
      return 'no significant performance change'
    case 'inconclusive':
      return !result.base.available
        ? `inconclusive: ${result.base.reason}`
        : 'inconclusive: a key metric could not be compared'
    case 'inconclusive-context':
      return 'measured, but not attributable to this change'
    case 'recorded':
      return 'trend point recorded (no comparison)'
  }
}

function verdictBanner(result: ResultJson): string[] {
  const baseline = result.base.available
    ? `\`${result.config.base}@${result.base.sha.slice(0, 7)}\``
    : 'unavailable'

  switch (result.verdict) {
    case 'regression': {
      const worst = result.comparison.metrics
        .filter((m) => m.verdict === 'regressed' && m.exceedsThreshold)
        .map((m) => `**${m.label}** is up ${formatPercent(m.delta!.percent)}`)
        .join(', ')
      return [
        `### ⚠️ Performance regression detected`,
        '',
        `${worst} against baseline ${baseline}. Threshold is ${result.config.thresholdPercent}%.`,
      ]
    }
    case 'ok':
      return [
        `### ✅ No significant performance change`,
        '',
        `All measured deltas are under the ${result.config.noiseFloorPercent}% noise floor or below the ${result.config.thresholdPercent}% threshold, against baseline ${baseline}.`,
      ]
    case 'inconclusive': {
      const why = !result.base.available
        ? result.base.reason
        : !result.comparison.protocolsMatch
          ? 'the two sides were measured under different protocols — deltas were refused, not computed'
          : 'a key metric could not be measured'
      return [`### ❔ Measurement inconclusive`, '', `${why}. Baseline: ${baseline}.`]
    }
    case 'inconclusive-context':
      return [
        `### 〰️ Measured — but not attributable to this change`,
        '',
        `${softeningSummary(result.softening ?? [])}. Baseline: ${baseline}.`,
      ]
    case 'recorded':
      return [`### 📈 Trend point recorded`, '', 'Absolute measurement of this commit — no comparison was made.']
  }
}

/**
 * The conditions that withheld attribution, each with its remedy (spec §9a decision 2). Rendered
 * right under the table: the numbers are real and above it, this is why they are not a verdict.
 */
function softeningBlock(result: ResultJson): string[] {
  const conditions = result.softening ?? []
  if (conditions.length === 0) return []
  const lines: string[] = ['', '> **Why this is not called a regression**', '>']
  for (const condition of conditions) {
    const [first, ...rest] = condition.text.split('\n')
    lines.push(`> - ${first}`)
    for (const line of rest) lines.push(line.trim().length > 0 ? `>   \`${line.trim()}\`` : '>')
  }
  lines.push('>')
  lines.push('> _The measurements above are real. What is withheld is the claim that this change caused them — the same doctrine as movement vs drift._')
  return lines
}

export function comparisonTable(result: ResultJson): string[] {
  const rank = { regressed: 0, improved: 1, no_change: 2, not_comparable: 3, skipped: 4 }
  const rows = [...result.comparison.metrics].sort((a, b) => rank[a.verdict] - rank[b.verdict])

  // Identical-reason POLICY skips collapse to one row each — five SSG exclusions are one fact,
  // not five table rows (email evidence: they blew up the table width). Full list in a details
  // block below the table.
  const grouped = new Map<string, MetricComparison[]>()
  const singles: MetricComparison[] = []
  for (const m of rows) {
    if (m.verdict === 'skipped' && m.excluded) {
      const key = shortReason(m.reason ?? 'not collected')
      if (!grouped.has(key)) grouped.set(key, [])
      grouped.get(key)!.push(m)
    } else {
      singles.push(m)
    }
  }

  // Never-ran must not read as ran-and-quiet (spec §9a).
  const neverRan = rows.length > 0 && rows.every((m) => m.base === null && m.current === null)
  const cell = (v: number | null, unit: MetricComparison['unit']) =>
    v === null && neverRan ? '_not measured_' : formatValue(v, unit)

  const lines = ['| Metric | Base | This PR | Change |', '|---|---|---|---|']
  for (const m of singles) {
    lines.push(`| ${m.label} | ${cell(m.base, m.unit)} | ${cell(m.current, m.unit)} | ${changeCell(m)} |`)
  }
  const groupedRows: { reason: string; members: MetricComparison[] }[] = []
  for (const [reason, members] of grouped) {
    if (members.length === 1) {
      const m = members[0]!
      lines.push(
        `| ${m.label} | ${formatValue(m.base, m.unit)} | ${formatValue(m.current, m.unit)} | ${changeCell(m)} |`,
      )
    } else {
      lines.push(`| ${members.length} rows excluded by policy | — | — | ${reason.replaceAll('|', '\\|')} |`)
      groupedRows.push({ reason, members })
    }
  }

  if (neverRan) {
    lines.push('')
    lines.push('> Nothing was measured this run — every row above is **unavailable**, not unchanged.')
  }

  if (groupedRows.length > 0) {
    lines.push('')
    lines.push('<details>')
    lines.push('<summary>Excluded rows</summary>')
    lines.push('')
    for (const g of groupedRows) {
      lines.push(`- ${g.members.map((m) => m.label).join(', ')} — ${compactReason(g.members[0]!.reason ?? g.reason)}`)
    }
    lines.push('')
    lines.push('</details>')
  }
  return lines
}


function changeCell(m: MetricComparison): string {
  switch (m.verdict) {
    case 'regressed':
      return `**${formatPercent(m.delta!.percent)}** ⬆️${m.exceedsThreshold ? '' : ' (under threshold)'}`
    case 'improved':
      return `${formatPercent(m.delta!.percent)} ⬇️`
    case 'no_change':
      return 'no change'
    case 'not_comparable':
      return 'not comparable'
    case 'skipped':
      return `skipped — ${compactReason(m.reason ?? 'not collected')}`
  }
}

/** Table cells show the LAST reason line (the specific one) and escape pipes (spec §9a). */
function compactReason(reason: string): string {
  const { text, truncated } = summariseReason(reason)
  return (truncated ? `${text} (full error in the run summary)` : text).replaceAll('|', '\\|')
}

/**
 * Every failure carries its own fix (spec §9a) — one block per distinct remedy, naming the
 * metrics it unblocks. Rendered as a fenced block so the command survives copy-paste.
 */
function fixBlocks(result: ResultJson): string[] {
  const byFix = new Map<string, string[]>()
  for (const m of result.comparison.metrics) {
    if (!m.fix || m.excluded) continue
    if (!byFix.has(m.fix)) byFix.set(m.fix, [])
    byFix.get(m.fix)!.push(m.label)
  }
  if (byFix.size === 0) return []

  const lines: string[] = ['', '<details>', '<summary>How to get these numbers</summary>', '']
  for (const [fix, labels] of byFix) {
    const shown = labels.length > 3 ? `${labels.slice(0, 3).join(', ')} +${labels.length - 3} more` : labels.join(', ')
    lines.push(`**${escapeText(shown)}**`, '', '```', ...fix.split('\n'), '```', '')
  }
  lines.push('</details>')
  return lines
}

function escapeText(text: string): string {
  return text.replaceAll('|', '\\|')
}

/** The honest one-liner when verification ran but no fix PR exists. */
function verificationLine(result: ResultJson): string | null {
  const v = result.verification
  if (!v) return null
  const three = (m: NonNullable<ResultJson['verification']>['metrics'][number]) =>
    `${m.label} ${formatValue(m.current, m.unit ?? 'bytes')}→${formatValue(m.fixed, m.unit ?? 'bytes')} vs base ${m.base !== null ? formatValue(m.base, m.unit ?? 'bytes') : '—'}`
  // Illustrate the outcome with a row that carries it — never an indistinguishable one.
  const carrier = (verdicts: readonly string[]) =>
    v.metrics.find((m) => verdicts.includes(m.verdict)) ?? v.metrics[0]
  switch (v.outcome) {
    case 'restored':
    case 'partial': {
      const m = carrier(['restored', 'partial'])
      return `✓ _a fix verified (${v.outcome}${m ? `: ${three(m)}` : ''}, measured) — enable \`auto_fix: propose\` to receive it as a PR._`
    }
    case 'no-recovery': {
      if (v.reason !== null) return `⚠ _a fix was proposed but did not verify (${v.reason}) — no fix PR opened._`
      const m = carrier(['no-recovery'])
      return `⚠ _a fix was proposed but did not verify (no recovery${m ? `: ${three(m)}` : ''}) — no fix PR opened._`
    }
    case 'build-broken':
      return '⚠ _a fix was proposed but did not verify (it breaks the build) — no fix PR opened._'
    case 'not-applicable':
      return '⚠ _a fix was proposed but could not be applied cleanly — no fix PR opened._'
    default:
      return null
  }
}

function footer(result: ResultJson): string {
  const parts: string[] = []
  if (result.base.available) {
    parts.push(
      `Baseline \`${result.config.base}@${result.base.sha.slice(0, 7)}\`${result.base.fromCache ? ' (cached)' : ''}`,
    )
  }
  // The build, not just the version (spec v50): src-vs-dist and the build time are what tell a
  // reader whether the comment came from the code they think it did.
  parts.push(buildStamp(result.build))
  parts.push(...renderAnalysisFooterParts(result.analysis))
  if (result.verification?.devOverride) {
    parts.push('⚠ DEV OVERRIDE: verification measured a substituted diff, not the analysis fix')
  }
  return `<sub>${parts.join(' · ')}</sub>`
}
