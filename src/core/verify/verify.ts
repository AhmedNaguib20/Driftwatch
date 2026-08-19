import { performance } from 'node:perf_hooks'
import type { ProjectProfile } from '../detect/types.js'
import { measureWorkspace } from '../measure/measure.js'
import type { MeasureOptions, ProgressReporter } from '../measure/measure.js'
import type { SideMeasurement } from '../measure/types.js'
import { createWorkingTreeWorkspace } from '../measure/workspace.js'
import type { WorkspaceOptions } from '../measure/workspace.js'
import { protocolMismatches } from '../report/protocol-match.js'
import type { ResultJson } from '../report/types.js'
import type { VerificationReport } from '../report/verification.js'
import { applyDiff } from './apply.js'
import { assessMetric, overallOutcome } from './assess.js'

/**
 * The verification stage (M6): measurement proves the AI's own suggestion. Gates first — cost
 * control means verification runs ONLY on a confirmed regression carrying a diff fix at the same
 * confidence bar enforceFixRules applies (≥ 0.8) — then: fresh copy, apply, measure as a third
 * side, three-way verdict per regressed metric. Every §5.1 discipline holds; a protocol mismatch
 * on the third side refuses the verification itself.
 */

export const VERIFY_CONFIDENCE_BAR = 0.8

export interface VerifyOptions extends WorkspaceOptions, MeasureOptions {
  readonly progress?: ProgressReporter
  /** Injectable for the verdict-matrix tests; defaults to the real measurement path. */
  readonly measureFn?: typeof measureWorkspace
}

export async function verifyFix(
  profile: ProjectProfile,
  result: ResultJson,
  options: VerifyOptions = {},
): Promise<VerificationReport> {
  const started = performance.now()
  const progress = options.progress ?? (() => {})
  const done = (report: Omit<VerificationReport, 'elapsedMs'>): VerificationReport => ({
    ...report,
    elapsedMs: Math.round(performance.now() - started),
  })
  const skipped = (reason: string) =>
    done({ outcome: 'skipped', reason, metrics: [], diff: null })

  // Gates (cost control) — the same bar enforceFixRules applies to ready diffs.
  if (result.verdict !== 'regression') return skipped('verification runs only on a confirmed regression')
  const analysis = result.analysis
  if (!analysis || analysis.outcome !== 'analysed') return skipped('no completed analysis to verify')
  if (analysis.fix.kind !== 'diff') return skipped('the fix is a prose suggestion, not a ready diff')
  if (analysis.confidence < VERIFY_CONFIDENCE_BAR) {
    return skipped(`confidence ${analysis.confidence} is under the ${VERIFY_CONFIDENCE_BAR} verification bar`)
  }
  const regressed = result.comparison.metrics.filter((m) => m.verdict === 'regressed')
  if (regressed.length === 0) return skipped('no regressed metrics to verify against')
  if (!('metrics' in result.current) || !('protocol' in result.current)) {
    return skipped('no measured current side to verify against')
  }

  const diff = analysis.fix.content

  progress('verify: copying the current tree for the fixed side…')
  const workspace = await createWorkingTreeWorkspace(profile, options)
  try {
    progress('verify: applying the suggested diff…')
    const applied = await applyDiff(workspace.dir, profile.pathInRepo ?? '.', diff)
    if (!applied.ok) {
      return done({ outcome: 'not-applicable', reason: applied.reason, metrics: [], diff })
    }

    progress('verify: measuring the fixed copy (third side, same invocation)…')
    const measure = options.measureFn ?? measureWorkspace
    const fixed: SideMeasurement = await measure(profile, workspace, progress, options)

    // §5.1: the third side must match the current side's protocol or the verification refuses.
    const mismatches = protocolMismatches(result.current.protocol, fixed.protocol)
    if (mismatches.length > 0) {
      return done({
        outcome: 'refused',
        reason: `the fixed side was measured under a different protocol — ${mismatches.join('; ')}`,
        metrics: [],
        diff,
      })
    }

    const fixedBuild = fixed.metrics.find((m) => m.id === 'build_time')
    if (fixedBuild?.status === 'skipped' && !fixedBuild.excluded) {
      return done({
        outcome: 'build-broken',
        reason: `the fixed copy does not build: ${fixedBuild.reason}`,
        metrics: [],
        diff,
      })
    }

    const metrics = []
    for (const m of regressed) {
      const fixedMetric = fixed.metrics.find((f) => f.id === m.id)
      if (!fixedMetric || fixedMetric.status !== 'measured' || m.current === null) continue
      metrics.push(
        assessMetric({
          id: m.id,
          label: m.label,
          unit: m.unit,
          base: m.base,
          current: m.current,
          fixed: fixedMetric.value,
        }),
      )
    }
    if (metrics.length === 0) {
      return done({
        outcome: 'build-broken',
        reason: 'the fixed copy produced none of the regressed metrics',
        metrics: [],
        diff,
      })
    }

    return done({ outcome: overallOutcome(metrics), reason: null, metrics, diff })
  } finally {
    await workspace.cleanup()
  }
}
