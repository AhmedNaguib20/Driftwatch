import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import type { ResultJson } from '../../core/index.js'
import { runAnalysis } from '../analyse/run-analysis.js'
import type { DiffFile, LockfileSummary } from '../analyse/index.js'
import { createProvider, resolveApiKey } from '../providers/index.js'
import { estimateCostUsd } from '../providers/pricing.js'
import { judge } from './judge.js'
import type { EvalCaseResult, EvalExpectation } from './types.js'

/**
 * Runs every case in eval/cases/ against the live provider (spec §7.2). Each case directory:
 *   result.json    — the captured measured result (schema 1.1)
 *   diff.json      — collected DiffFile[]
 *   lockfiles.json — LockfileSummary[]
 *   expected.json  — EvalExpectation
 * Live calls on purpose: this judges real model behavior; comparability requires identical
 * PROMPT_VERSION between runs being compared.
 */
export async function runEvalCases(
  casesDir: string,
  progress: (message: string) => void = () => {},
): Promise<EvalCaseResult[]> {
  const apiKey = resolveApiKey()
  if (!apiKey) throw new Error('eval needs DRIFTWATCH_API_KEY — it judges live provider behavior')

  const names = (await readdir(casesDir, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
  if (names.length === 0) throw new Error(`no cases found in ${casesDir}`)

  const results: EvalCaseResult[] = []

  for (const name of names) {
    const dir = path.join(casesDir, name)
    const result = JSON.parse(await readFile(path.join(dir, 'result.json'), 'utf8')) as ResultJson
    const diff = JSON.parse(await readFile(path.join(dir, 'diff.json'), 'utf8')) as DiffFile[]
    const lockfileSummaries = JSON.parse(
      await readFile(path.join(dir, 'lockfiles.json'), 'utf8'),
    ) as LockfileSummary[]
    const expected = JSON.parse(
      await readFile(path.join(dir, 'expected.json'), 'utf8'),
    ) as EvalExpectation

    const provider = createProvider({
      provider: result.config.provider,
      model: result.config.model,
      apiKey,
    })

    progress(`${name}: analysing…`)
    const started = performance.now()
    const analysis = await runAnalysis(result, { diff, lockfileSummaries }, provider, (m) =>
      progress(`${name}: ${m}`),
    )
    const durationMs = Math.round(performance.now() - started)

    const verdictOfJudge = judge(analysis, expected)
    const tokens = sumTokens(analysis)
    const promptVersion = versionOf(analysis)

    results.push({
      name,
      passed: verdictOfJudge.passed,
      checks: verdictOfJudge.checks,
      tokens,
      costUsd: costOf(analysis, tokens),
      durationMs,
      promptVersion,
    })
  }

  return results
}

function sumTokens(analysis: { outcome: string }): { input: number; output: number } {
  const stages = stagesOf(analysis)
  return stages.reduce(
    (sum, s) => ({ input: sum.input + s.tokens.input, output: sum.output + s.tokens.output }),
    { input: 0, output: 0 },
  )
}

function costOf(analysis: { outcome: string }, _tokens: { input: number }): number | null {
  const stages = stagesOf(analysis)
  if (stages.length === 0) return null
  let total = 0
  for (const s of stages) {
    const cost = estimateCostUsd(s.provider, s.model, s.tokens)
    if (cost === null) return null
    total += cost
  }
  return total
}

function versionOf(analysis: { outcome: string }): number | null {
  return stagesOf(analysis)[0]?.promptVersion ?? null
}

function stagesOf(analysis: {
  outcome: string
}): { provider: string; model: string; tokens: { input: number; output: number }; promptVersion: number }[] {
  const a = analysis as {
    stages?: {
      triage?: { provider: string; model: string; tokens: { input: number; output: number }; promptVersion: number }
      deep?: { provider: string; model: string; tokens: { input: number; output: number }; promptVersion: number }
    }
  }
  return [a.stages?.triage, a.stages?.deep].filter((s): s is NonNullable<typeof s> => Boolean(s))
}
