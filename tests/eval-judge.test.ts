import { describe, expect, it } from 'vitest'
import { judge } from '../src/ai/eval/judge.js'
import type { AnalysisReport } from '../src/core/index.js'

const stage = { provider: 'deepseek', model: 'm', tokens: { input: 1, output: 1 }, durationMs: 1, promptVersion: 2, retried: false }
const manifest = { files: [], lockfiles: [], estimatedTokens: 1, budgetTokens: 1, truncated: false }

function analysed(overrides: Partial<Extract<AnalysisReport, { outcome: 'analysed' }>> = {}): AnalysisReport {
  return {
    outcome: 'analysed',
    cause: 'importing lodash pulls the whole library into the bundle',
    confidence: 0.9,
    evidence: ['e'],
    fix: { kind: 'diff', content: '--- a/app/chart.tsx\n+++ b/app/chart.tsx\n@@ -1 +1 @@\n-import _ from "lodash"\n+import debounce from "lodash/debounce"\n' },
    suspects: [{ path: 'app/chart.tsx', reason: 'r' }],
    stages: { triage: stage, deep: stage },
    context: { triage: manifest, deep: manifest },
    ...overrides,
  }
}

describe('eval judge', () => {
  it('passes when every expectation holds', () => {
    const verdict = judge(analysed(), {
      outcome: 'analysed',
      suspectsInclude: ['app/chart.tsx'],
      causeMustContain: ['lodash'],
      confidence: { min: 0.5, max: 1 },
      fix: { mustMentionAnyOf: ['lodash'], diffMayOnlyTouch: ['app/chart.tsx'] },
    })
    expect(verdict.passed).toBe(true)
  })

  it('fails with named checks when the cause misses a keyword or the diff strays', () => {
    const verdict = judge(
      analysed({
        cause: 'something about the build',
        fix: { kind: 'diff', content: '--- a/next.config.mjs\n+++ b/next.config.mjs\n@@ -1 +1 @@\n-a\n+b\n' },
      }),
      {
        outcome: 'analysed',
        causeMustContain: ['lodash'],
        fix: { diffMayOnlyTouch: ['app/chart.tsx'] },
      },
    )
    expect(verdict.passed).toBe(false)
    const failed = verdict.checks.filter((c) => !c.ok).map((c) => c.check)
    expect(failed).toEqual(['cause mentions "lodash"', 'diff fix confined to [app/chart.tsx]'])
  })

  it('fails on the wrong outcome and reports what it got', () => {
    const verdict = judge({ outcome: 'skipped', reason: 'auth: rejected' }, { outcome: 'analysed' })
    expect(verdict.passed).toBe(false)
    expect(verdict.checks[0]!.detail).toMatch(/skipped.*auth/)
  })
})
