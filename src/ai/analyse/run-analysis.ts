import { performance } from 'node:perf_hooks'
import type { ResultJson } from '../../core/index.js'
import { ProviderError, jsonCall } from '../providers/index.js'
import type { Provider } from '../providers/index.js'
import type { Analysis, AnalysisFix, StageStats } from './analysis-types.js'
import { assembleDeepContext, assembleTriageContext } from './assemble.js'
import type { ContextInput } from './assemble.js'
import { DEEP_SYSTEM, PROMPT_VERSION, TRIAGE_SYSTEM, deepUser, triageUser } from './prompts.js'
import { validateDeep, validateTriage } from './schemas.js'
import type { DeepOutput } from './schemas.js'

/**
 * The two-stage flow (spec §7): triage gates deep analysis. Every exit is honest — a "this diff
 * does not explain it" from triage surfaces as inconclusive with the model's reason; a provider
 * failure surfaces as skipped with the error. Nothing here can change the measurement verdict:
 * analysis annotates the result, it never overrules it.
 */

const TRIAGE_TIMEOUT_MS = 60_000
const DEEP_TIMEOUT_MS = 180_000
/**
 * Output caps, measured (M9) — the same discipline as BUILD_SAMPLES: a number with a basis, not
 * a round guess.
 *
 * Triage output scales with the diff's FILE COUNT: it ranks one suspect per plausibly-relevant
 * changed file, each with a one-sentence reason. Modelled against the four eval cases' real
 * diffs (our own estimateTokens over a well-formed response):
 *
 *     run-b   1 file    104 tokens        run-d   2 files   146 tokens
 *     run-c   3 files   190 tokens        run-a  31 files  1559 tokens   ← old cap was 1000
 *
 * That is why run-a failed at the M6 close and again at the M8 close: ~47 tokens per changed
 * file, so a 31-file diff needs 1.5x the room it was given. 3200 is 2x the measured largest and
 * covers ~66 changed files at that rate; beyond it, truncation is now DETECTED, named, and
 * retried once with the cap doubled rather than re-sent unchanged.
 *
 * Deep output is cause + evidence + a fix, and a diff fix has no schema bound. Same method:
 *
 *     6-line fix   148 tokens      40-line   725 tokens
 *     16-line fix  371 tokens      80-line  1315 tokens      150-line  2360 tokens  ← cap was 2500
 *
 * A 150-line fix left 140 tokens of headroom. Raised pre-emptively to 6000 (≈2.5x, ~400-line
 * fixes) because model verbosity grows and this failure mode is silent until it isn't.
 */
const TRIAGE_MAX_OUTPUT = 3_200
const DEEP_MAX_OUTPUT = 6_000

/** Below this confidence a diff fix is DISPLAYED as prose; the diff itself survives for
 * verification (spec v35 — the bar governs presentation, measurement governs proof). */
const DIFF_FIX_CONFIDENCE_BAR = 0.8

export async function runAnalysis(
  result: ResultJson,
  diffData: Omit<ContextInput, 'result'>,
  provider: Provider,
  progress: (message: string) => void = () => {},
): Promise<Analysis> {
  if (result.verdict !== 'regression') {
    return { outcome: 'skipped', reason: 'analysis runs only on a regression verdict (spec §7)' }
  }

  const input: ContextInput = { result, ...diffData }
  const triageContext = assembleTriageContext(input)

  let triage
  try {
    triage = await timed(() =>
      jsonCall(
        provider,
        {
          system: TRIAGE_SYSTEM,
          user: triageUser(triageContext.text),
          maxOutputTokens: TRIAGE_MAX_OUTPUT,
          temperature: 0,
          timeoutMs: TRIAGE_TIMEOUT_MS,
        },
        validateTriage,
      ),
    )
  } catch (error) {
    return { outcome: 'skipped', reason: `triage failed: ${describeError(error)}` }
  }

  const triageStats = stats(provider, triage)

  // v2: triage never stops the pipeline — measurement proved the regression is real (§7.1c);
  // triage only ranks suspects and offers hypotheses that deep weighs.
  const suspects = triage.result.value.suspects
  const hints = triage.result.value.outOfDiffHints ?? []
  progress(
    `triage: suspects: ${suspects.map((s) => s.path).join(', ') || '(none named)'}${hints.length > 0 ? ` (+${hints.length} out-of-diff hint(s))` : ''}; running deep analysis…`,
  )
  const deepContext = assembleDeepContext(
    input,
    suspects.map((s) => s.path),
  )

  let deep
  try {
    deep = await timed(() =>
      jsonCall(
        provider,
        {
          system: DEEP_SYSTEM,
          user: deepUser(
            deepContext.text,
            suspects.map((s) => s.path),
            hints,
          ),
          maxOutputTokens: DEEP_MAX_OUTPUT,
          temperature: 0,
          timeoutMs: DEEP_TIMEOUT_MS,
        },
        validateDeep,
      ),
    )
  } catch (error) {
    return { outcome: 'skipped', reason: `deep analysis failed: ${describeError(error)}` }
  }

  const value = deep.result.value

  // Deep — with the full patches in hand — is the only stage allowed to conclude this.
  if (!value.explainsRegression) {
    return {
      outcome: 'inconclusive',
      stopReason: value.cause,
      stages: { triage: triageStats, deep: stats(provider, deep) },
      context: { triage: triageContext.manifest, deep: deepContext.manifest },
    }
  }

  return {
    outcome: 'analysed',
    cause: value.cause,
    confidence: value.confidence,
    evidence: value.evidence,
    fix: enforceFixRules(value, filesShown(deepContext.manifest)),
    suspects,
    stages: { triage: triageStats, deep: stats(provider, deep) },
    context: { triage: triageContext.manifest, deep: deepContext.manifest },
  }
}

/**
 * The prompt states the fix rules; this enforces them. Two different rules produce the same
 * prose display but mean different things (spec v35, second de-gating):
 *
 *  - Confinement (files the model was never shown) is a safety guarantee — the diff is dropped
 *    entirely; verification never measures it.
 *  - The confidence bar is a DISPLAY rule only — the fix is shown as prose, but the diff
 *    survives in `diff` for verification to measure. Measurement is better evidence than the
 *    model's self-confidence; if the fix verifies, measurement earns it the display back.
 *
 * Guarantees live in code, not in model obedience.
 */
function enforceFixRules(deep: DeepOutput, shownFiles: ReadonlySet<string>): AnalysisFix {
  if (deep.fix.kind !== 'diff') return deep.fix

  const touched = [...deep.fix.content.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]!)
  const unknown = touched.filter((p) => !shownFiles.has(p))
  if (unknown.length > 0) {
    return {
      kind: 'prose',
      content: deep.fix.content,
      note: `downgraded from a diff: it touches files not shown in the analysis context (${unknown.join(', ')})`,
    }
  }

  if (deep.confidence < DIFF_FIX_CONFIDENCE_BAR) {
    return {
      kind: 'prose',
      content: deep.fix.content,
      note: `downgraded from a diff: confidence ${deep.confidence} is below the ${DIFF_FIX_CONFIDENCE_BAR} bar for ready-to-apply patches`,
      diff: deep.fix.content,
    }
  }

  return { ...deep.fix, diff: deep.fix.content }
}

function filesShown(manifest: { files: readonly { path: string; disposition: string }[] }): Set<string> {
  return new Set(
    manifest.files.filter((f) => f.disposition === 'full' || f.disposition === 'truncated').map((f) => f.path),
  )
}

interface Timed<T> {
  readonly result: T
  readonly durationMs: number
}

async function timed<T>(fn: () => Promise<T>): Promise<Timed<T>> {
  const started = performance.now()
  const result = await fn()
  return { result, durationMs: Math.round(performance.now() - started) }
}

function stats(
  provider: Provider,
  call: Timed<{ tokens: { input: number; output: number }; model: string; retried: boolean }>,
): StageStats {
  return {
    provider: provider.name,
    model: call.result.model,
    tokens: call.result.tokens,
    durationMs: call.durationMs,
    promptVersion: PROMPT_VERSION,
    retried: call.result.retried,
  }
}

function describeError(error: unknown): string {
  if (error instanceof ProviderError) return `${error.kind}: ${error.message}`
  return error instanceof Error ? error.message : String(error)
}
