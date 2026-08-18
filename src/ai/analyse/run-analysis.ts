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
const TRIAGE_MAX_OUTPUT = 1_000
const DEEP_MAX_OUTPUT = 2_500

/** Diff-format fixes require at least this confidence; below it we downgrade to prose. */
const DIFF_FIX_CONFIDENCE_BAR = 0.8

export async function runAnalysis(
  result: ResultJson,
  diffData: Omit<ContextInput, 'result'>,
  provider: Provider,
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
  if (!triage.result.value.plausible) {
    return {
      outcome: 'inconclusive',
      stopReason: triage.result.value.stopReason ?? 'triage found no plausible link to this diff',
      stages: { triage: triageStats },
      context: { triage: triageContext.manifest },
    }
  }

  const suspects = triage.result.value.suspects
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
 * The prompt states the fix rules; this enforces them. A model that returns a diff below the
 * confidence bar, or one touching files it was never shown, gets downgraded to prose — the
 * content is preserved, the downgrade is named. Guarantees live in code, not in model obedience.
 */
function enforceFixRules(deep: DeepOutput, shownFiles: ReadonlySet<string>): AnalysisFix {
  if (deep.fix.kind !== 'diff') return deep.fix

  if (deep.confidence < DIFF_FIX_CONFIDENCE_BAR) {
    return {
      kind: 'prose',
      content: deep.fix.content,
      note: `downgraded from a diff: confidence ${deep.confidence} is below the ${DIFF_FIX_CONFIDENCE_BAR} bar for ready-to-apply patches`,
    }
  }

  const touched = [...deep.fix.content.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]!)
  const unknown = touched.filter((p) => !shownFiles.has(p))
  if (unknown.length > 0) {
    return {
      kind: 'prose',
      content: deep.fix.content,
      note: `downgraded from a diff: it touches files not shown in the analysis context (${unknown.join(', ')})`,
    }
  }

  return deep.fix
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
