import type { AnalysisReport } from '../../core/index.js'
import type { EvalExpectation } from './types.js'

/** Judges one analysis against a case's expectations. Pure; every check reports its detail. */
export function judge(
  analysis: AnalysisReport,
  expected: EvalExpectation,
): { passed: boolean; checks: { check: string; ok: boolean; detail: string }[] } {
  const checks: { check: string; ok: boolean; detail: string }[] = []
  const add = (check: string, ok: boolean, detail: string) => checks.push({ check, ok, detail })

  add(
    `outcome is ${expected.outcome}`,
    analysis.outcome === expected.outcome,
    `got ${analysis.outcome}${analysis.outcome === 'skipped' ? ` (${analysis.reason})` : ''}`,
  )

  if (analysis.outcome === 'analysed') {
    if (expected.suspectsInclude) {
      for (const path of expected.suspectsInclude) {
        const found = analysis.suspects.some((s) => s.path === path)
        add(`suspects include ${path}`, found, found ? 'named' : `suspects were: ${analysis.suspects.map((s) => s.path).join(', ') || '(none)'}`)
      }
    }
    const cause = analysis.cause.toLowerCase()
    for (const keyword of expected.causeMustContain ?? []) {
      add(`cause mentions "${keyword}"`, cause.includes(keyword.toLowerCase()), `cause: ${analysis.cause}`)
    }
    if (expected.causeAnyOf && expected.causeAnyOf.length > 0) {
      const hit = expected.causeAnyOf.find((k) => cause.includes(k.toLowerCase()))
      add(`cause mentions any of [${expected.causeAnyOf.join(', ')}]`, hit !== undefined, hit ? `matched "${hit}"` : `cause: ${analysis.cause}`)
    }
    if (expected.confidence) {
      const ok = analysis.confidence >= expected.confidence.min && analysis.confidence <= expected.confidence.max
      add(
        `confidence in [${expected.confidence.min}, ${expected.confidence.max}]`,
        ok,
        `got ${analysis.confidence}`,
      )
    }
    if (expected.fix?.mustMentionAnyOf) {
      const content = analysis.fix.content.toLowerCase()
      const hit = expected.fix.mustMentionAnyOf.find((k) => content.includes(k.toLowerCase()))
      add(`fix mentions any of [${expected.fix.mustMentionAnyOf.join(', ')}]`, hit !== undefined, hit ? `matched "${hit}"` : `fix started: ${analysis.fix.content.slice(0, 120)}`)
    }
    if (expected.fix?.diffMayOnlyTouch && analysis.fix.kind === 'diff') {
      const touched = [...analysis.fix.content.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]!)
      const outside = touched.filter((p) => !expected.fix!.diffMayOnlyTouch!.includes(p))
      add(`diff fix confined to [${expected.fix.diffMayOnlyTouch.join(', ')}]`, outside.length === 0, outside.length === 0 ? `touched: ${touched.join(', ') || '(none)'}` : `also touched: ${outside.join(', ')}`)
    }
  }

  return { passed: checks.every((c) => c.ok), checks }
}
