import type { ResultJson } from '../../core/index.js'
import { comparisonTable, renderCheckTitle } from './render-comment.js'
import { renderAllMetrics, renderHowMeasured } from './render-details.js'

/**
 * GITHUB_STEP_SUMMARY — the run's own page, next to the log: the natural home for the exhaustive
 * accounting the PR comment links to. Same renderer family as the comment (shared table, shared
 * detail blocks), different role: the comment persuades, the summary documents.
 */
export interface SummaryLinks {
  readonly commentUrl: string | null
  readonly checkUrl: string | null
}

export function renderSummary(result: ResultJson, links: SummaryLinks): string {
  const lines: string[] = []

  lines.push(`# Driftwatch — ${renderCheckTitle(result)}`)
  const back: string[] = []
  if (links.commentUrl) back.push(`[PR comment](${links.commentUrl})`)
  if (links.checkUrl) back.push(`[check](${links.checkUrl})`)
  if (back.length > 0) lines.push(back.join(' · '))
  lines.push('')
  lines.push(...comparisonTable(result))
  lines.push('')
  lines.push(renderAllMetrics(result))
  lines.push(renderHowMeasured(result))

  return lines.join('\n')
}
