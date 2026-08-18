import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { COMMENT_MARKER, renderComment } from '../src/adapters/github/index.js'
import type { MetricComparison, ResultJson } from '../src/core/index.js'

/**
 * Golden tests for the PR comment — the adapter's contract with its readers. Each scenario is a
 * surgical variant of the schema-1.1 golden result, so the renderer is tested against exactly
 * what core emits. Regenerate deliberately with UPDATE_GOLDEN=1 and review the diff as a UI
 * change, because it is one.
 */

const golden = (name: string) => path.join(import.meta.dirname, 'golden', name)

async function baseResult(): Promise<ResultJson> {
  const raw = await readFile(golden('result-v1.1.json'), 'utf8')
  return JSON.parse(raw.replaceAll('<driftwatch-version>', '0.2.0')) as ResultJson
}

function noChangeMetric(m: MetricComparison): MetricComparison {
  if (m.verdict !== 'regressed') return m
  return {
    ...m,
    verdict: 'no_change',
    delta: null,
    exceedsThreshold: false,
    reason: 'delta is under the 2% noise floor',
    current: m.base,
  }
}

async function scenario(name: string): Promise<ResultJson> {
  const result = await baseResult()
  switch (name) {
    case 'regression-analysed':
      return result
    case 'regression-no-key':
      return { ...result, analysis: { outcome: 'no_key' } }
    case 'regression-analysis-skipped':
      return {
        ...result,
        analysis: {
          outcome: 'skipped',
          reason: 'triage failed: timeout: deepseek did not respond within 60000ms',
        },
      }
    case 'no-change':
      return {
        ...result,
        verdict: 'ok',
        comparison: {
          ...result.comparison,
          metrics: result.comparison.metrics.map(noChangeMetric),
        },
        analysis: { outcome: 'skipped', reason: 'analysis runs only on a regression verdict' },
      }
    case 'inconclusive-measurement':
      return {
        ...result,
        verdict: 'inconclusive',
        base: { available: false, reason: 'base ref "main" does not resolve to a commit in this repository' },
        comparison: {
          ...result.comparison,
          protocolsMatch: false,
          metrics: result.comparison.metrics.map((m) => ({
            ...m,
            verdict: 'skipped' as const,
            delta: null,
            exceedsThreshold: false,
            base: null,
            reason: 'base unavailable: base ref "main" does not resolve to a commit in this repository',
          })),
        },
        analysis: { outcome: 'skipped', reason: 'analysis runs only on a regression verdict' },
      }
    default:
      throw new Error(`unknown scenario ${name}`)
  }
}

const SCENARIOS = [
  'regression-analysed',
  'regression-no-key',
  'regression-analysis-skipped',
  'no-change',
  'inconclusive-measurement',
] as const

describe('PR comment renderer — golden contract', () => {
  for (const name of SCENARIOS) {
    it(`renders ${name} to its golden file`, async () => {
      const rendered = renderComment(await scenario(name)) + '\n'
      const file = golden(`comment-${name}.md`)
      if (process.env.UPDATE_GOLDEN === '1') await writeFile(file, rendered, 'utf8')
      expect(rendered).toBe(await readFile(file, 'utf8'))
    })
  }

  it('every rendering carries the upsert marker exactly once, first line', async () => {
    for (const name of SCENARIOS) {
      const rendered = renderComment(await scenario(name))
      expect(rendered.startsWith(COMMENT_MARKER)).toBe(true)
      expect(rendered.split(COMMENT_MARKER)).toHaveLength(2)
    }
  })

  it('regression banner names the crossed metrics and the threshold', async () => {
    const rendered = renderComment(await scenario('regression-analysed'))
    expect(rendered).toContain('⚠️ Performance regression detected')
    expect(rendered).toContain('**build time (cold)** is up +7.2%')
    expect(rendered).toContain('Threshold is 5%')
    expect(rendered).toContain('`main@c0ffee0`')
  })

  it('the table keeps explicit no-change rows so the reader knows we looked', async () => {
    const rendered = renderComment(await scenario('regression-analysed'))
    expect(rendered).toContain('| bundle size |')
    expect(rendered).toContain('| no change |')
  })

  it('confidence renders as number + calibrated word, never bare adjectives', async () => {
    const rendered = renderComment(await scenario('regression-analysed'))
    expect(rendered).toContain('confidence 90% (high)')
    expect(rendered).not.toMatch(/definitely/i)
  })

  it('no-key renders the measurement intact with a one-line note (fork-PR path)', async () => {
    const rendered = renderComment(await scenario('regression-no-key'))
    expect(rendered).toContain('⚠️ Performance regression detected')
    expect(rendered).toContain('normal for fork PRs')
    expect(rendered).not.toContain('Likely cause')
  })

  it('the what-was-sent details appear only when analysis actually ran', async () => {
    expect(renderComment(await scenario('regression-analysed'))).toContain('What was sent to the AI provider')
    expect(renderComment(await scenario('regression-no-key'))).not.toContain('What was sent')
    expect(renderComment(await scenario('no-change'))).not.toContain('What was sent')
  })
})
