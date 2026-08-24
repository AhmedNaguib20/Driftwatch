import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  DEEP_SYSTEM,
  PROMPT_VERSION,
  TRIAGE_SYSTEM,
  deepUser,
  runAnalysis,
  triageUser,
  assembleTriageContext,
  assembleDeepContext,
} from '../src/ai/analyse/index.js'
import type { ContextInput, DiffFile } from '../src/ai/analyse/index.js'
import { ProviderError } from '../src/ai/providers/index.js'
import type { ChatRequest, ChatResponse, Provider } from '../src/ai/providers/index.js'
import type { ResultJson } from '../src/core/index.js'

async function regressionResult(): Promise<ResultJson> {
  const raw = await readFile(path.join(import.meta.dirname, 'golden', 'result-v1.json'), 'utf8')
  return JSON.parse(raw.replaceAll('<driftwatch-version>', '0.2.0')) as ResultJson
}

function file(overrides: Partial<DiffFile> & { path: string }): DiffFile {
  return {
    insertions: 20,
    deletions: 2,
    binary: false,
    untracked: false,
    patch: `diff --git a/${overrides.path} b/${overrides.path}\n+changed\n`,
    ...overrides,
  }
}

const DIFF_DATA = {
  diff: [
    file({ path: 'lib/posts.ts', insertions: 25 }),
    file({ path: 'app/blog/page.tsx', insertions: 12 }),
  ],
  lockfileSummaries: [],
}

/** A response the API cut off at the cap — `finish_reason: "length"` (M9). */
class Truncated {
  constructor(readonly text: string, readonly outputTokens: number) {}
}

/** Scripted provider: pops responses in order; records every request it saw. */
function scriptedProvider(
  script: (string | ProviderError | Truncated)[],
): Provider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = []
  return {
    name: 'mock',
    model: 'mock-model',
    requests,
    async chat(request: ChatRequest): Promise<ChatResponse> {
      requests.push(request)
      const next = script.shift()
      if (next === undefined) throw new Error('scripted provider ran out of responses')
      if (next instanceof ProviderError) throw next
      if (next instanceof Truncated) {
        return {
          text: next.text,
          tokens: { input: 500, output: next.outputTokens },
          model: 'mock-model',
          truncated: true,
        }
      }
      return { text: next, tokens: { input: 500, output: 60 }, model: 'mock-model', truncated: false }
    },
  }
}

const TRIAGE_OK = JSON.stringify({
  suspects: [{ path: 'lib/posts.ts', reason: 'adds 300 generated pages' }],
})

const DEEP_OK = JSON.stringify({
  explainsRegression: true,
  cause: 'The archive import generates 300 additional static pages at build time.',
  confidence: 0.9,
  evidence: [
    'build time (cold) regressed from 8724ms to 9350ms (+626ms)',
    'lib/posts.ts adds a 300-entry archive array consumed by generateStaticParams',
  ],
  fix: {
    kind: 'diff',
    content: '--- a/lib/posts.ts\n+++ b/lib/posts.ts\n@@ -1 +1 @@\n-const N = 300\n+const N = 30\n',
  },
})

describe('runAnalysis — two-stage flow', () => {
  it('happy path: triage gates deep, both stages accounted', async () => {
    const provider = scriptedProvider([TRIAGE_OK, DEEP_OK])
    const analysis = await runAnalysis(await regressionResult(), DIFF_DATA, provider)

    expect(analysis.outcome).toBe('analysed')
    if (analysis.outcome !== 'analysed') return
    expect(analysis.cause).toMatch(/300 additional static pages/)
    expect(analysis.confidence).toBe(0.9)
    expect(analysis.fix.kind).toBe('diff')
    expect(analysis.suspects[0]!.path).toBe('lib/posts.ts')
    for (const stage of [analysis.stages.triage, analysis.stages.deep]) {
      expect(stage.provider).toBe('mock')
      expect(stage.tokens).toEqual({ input: 500, output: 60 })
      expect(stage.promptVersion).toBe(PROMPT_VERSION)
      expect(stage.durationMs).toBeGreaterThanOrEqual(0)
    }
    // Deep context manifest recorded — the per-run record of what was sent.
    expect(analysis.context.deep.files.length).toBeGreaterThan(0)
  })

  it('v2: triage inlines small patches but never large ones; deep carries the suspect patch', async () => {
    const bigPatch = 'diff --git a/big.ts b/big.ts\n' + '+LARGE-FILE-LINE\n'.repeat(80)
    const diffData = {
      diff: [
        ...DIFF_DATA.diff,
        file({ path: 'big.ts', insertions: 80, deletions: 0, patch: bigPatch }),
      ],
      lockfileSummaries: [],
    }
    const provider = scriptedProvider([TRIAGE_OK, DEEP_OK])
    await runAnalysis(await regressionResult(), diffData, provider)

    expect(provider.requests[0]!.user).toContain('+changed') // small patch inlined at triage
    expect(provider.requests[0]!.user).not.toContain('LARGE-FILE-LINE') // large one is not
    expect(provider.requests[1]!.user).toContain('+changed')
    expect(provider.requests[1]!.user).toContain('Triage ranked these suspects')
  })

  it('v2: triage never stops the pipeline — deep always runs and is the only stage that may conclude not-explained', async () => {
    const provider = scriptedProvider([
      JSON.stringify({ suspects: [], outOfDiffHints: ['a dependency may have changed outside this diff'] }),
      JSON.stringify({
        explainsRegression: false,
        cause: 'After weighing the patches: the diff touches only documentation; investigate dependency resolution and build environment instead.',
        confidence: 0.4,
        evidence: ['build time (cold) regressed 8724ms → 9350ms while no code-bearing file changed'],
        fix: { kind: 'prose', content: 'Compare lockfiles and CI images between the two builds.' },
      }),
    ])
    const analysis = await runAnalysis(await regressionResult(), DIFF_DATA, provider)

    expect(provider.requests).toHaveLength(2) // deep ALWAYS ran
    expect(analysis.outcome).toBe('inconclusive')
    if (analysis.outcome !== 'inconclusive') return
    expect(analysis.stopReason).toMatch(/investigate dependency resolution/)
    expect(analysis.stages.deep).toBeDefined()
    // The triage hint travelled into the deep request as a hypothesis, labelled as such.
    expect(provider.requests[1]!.user).toMatch(/out-of-diff hypotheses.*a dependency may have changed/)
  })

  it('provider error at triage → skipped with the typed reason', async () => {
    const provider = scriptedProvider([new ProviderError('auth', 'deepseek rejected the API key (HTTP 401)')])
    const analysis = await runAnalysis(await regressionResult(), DIFF_DATA, provider)

    expect(analysis.outcome).toBe('skipped')
    if (analysis.outcome !== 'skipped') return
    expect(analysis.reason).toMatch(/triage failed: auth: deepseek rejected/)
  })

  it('provider error at deep → skipped, names the stage', async () => {
    const provider = scriptedProvider([TRIAGE_OK, new ProviderError('timeout', 'mock did not respond within 180000ms')])
    const analysis = await runAnalysis(await regressionResult(), DIFF_DATA, provider)

    expect(analysis.outcome).toBe('skipped')
    if (analysis.outcome !== 'skipped') return
    expect(analysis.reason).toMatch(/deep analysis failed: timeout/)
  })

  it('malformed then corrected: analysis succeeds, retry visible in the stage stats', async () => {
    const provider = scriptedProvider(['this is not json', TRIAGE_OK, DEEP_OK])
    const analysis = await runAnalysis(await regressionResult(), DIFF_DATA, provider)

    expect(analysis.outcome).toBe('analysed')
    if (analysis.outcome !== 'analysed') return
    expect(analysis.stages.triage.retried).toBe(true)
    expect(analysis.stages.triage.tokens.input).toBe(1000) // both attempts counted
  })

  it('malformed twice → skipped honestly', async () => {
    const provider = scriptedProvider(['nope', 'still nope'])
    const analysis = await runAnalysis(await regressionResult(), DIFF_DATA, provider)

    expect(analysis.outcome).toBe('skipped')
    if (analysis.outcome !== 'skipped') return
    expect(analysis.reason).toMatch(/invalid JSON twice/)
  })

  it('never runs on a non-regression verdict — and that is not a skip', async () => {
    const result = { ...(await regressionResult()), verdict: 'ok' as const }
    const provider = scriptedProvider([])
    const analysis = await runAnalysis(result, DIFF_DATA, provider)

    // 'not_applicable', not 'skipped': nothing was attempted and nothing failed, so no human
    // surface reports it. 'skipped' is reserved for an attempt that cost something (spec §9e).
    expect(analysis.outcome).toBe('not_applicable')
    expect(provider.requests).toHaveLength(0)
  })

  it('downgrades a diff fix below the confidence bar to prose, preserving content', async () => {
    const provider = scriptedProvider([
      TRIAGE_OK,
      JSON.stringify({
        explainsRegression: true,
        cause: 'probably the archive',
        confidence: 0.55,
        evidence: ['build time regressed +626ms'],
        fix: { kind: 'diff', content: '--- a/lib/posts.ts\n+++ b/lib/posts.ts\n@@ -1 +1 @@\n-a\n+b\n' },
      }),
    ])
    const analysis = await runAnalysis(await regressionResult(), DIFF_DATA, provider)

    if (analysis.outcome !== 'analysed') throw new Error('expected analysed')
    expect(analysis.fix.kind).toBe('prose')
    expect(analysis.fix.note).toMatch(/below the 0.8 bar/)
    expect(analysis.fix.content).toContain('+++ b/lib/posts.ts')
    // Spec v35: the display downgrade keeps the machine diff for verification.
    expect(analysis.fix.diff).toBe(analysis.fix.content)
  })

  it('downgrades a diff that touches files the model was never shown', async () => {
    const provider = scriptedProvider([
      TRIAGE_OK,
      JSON.stringify({
        explainsRegression: true,
        cause: 'the archive',
        confidence: 0.95,
        evidence: ['build time regressed +626ms'],
        fix: { kind: 'diff', content: '--- a/next.config.mjs\n+++ b/next.config.mjs\n@@ -1 +1 @@\n-a\n+b\n' },
      }),
    ])
    const analysis = await runAnalysis(await regressionResult(), DIFF_DATA, provider)

    if (analysis.outcome !== 'analysed') throw new Error('expected analysed')
    expect(analysis.fix.kind).toBe('prose')
    expect(analysis.fix.note).toMatch(/files not shown.*next\.config\.mjs/)
    // Confinement is a safety rule, not a display rule: no machine diff survives.
    expect(analysis.fix.diff).toBeUndefined()
  })
})

describe('golden prompts — the prompts are documentation', () => {
  const GOLDEN = path.join(import.meta.dirname, 'golden', `prompts-v${PROMPT_VERSION}.md`)

  it('rendered prompts match the golden file', async () => {
    const input: ContextInput = { result: await regressionResult(), ...DIFF_DATA }
    const triageCtx = assembleTriageContext(input)
    const deepCtx = assembleDeepContext(input, ['lib/posts.ts'])

    const rendered = [
      `# Driftwatch prompts — version ${PROMPT_VERSION}`,
      '## Triage system',
      TRIAGE_SYSTEM,
      '## Triage user (with golden-result context)',
      triageUser(triageCtx.text),
      '## Deep system',
      DEEP_SYSTEM,
      '## Deep user (with golden-result context)',
      deepUser(deepCtx.text, ['lib/posts.ts']),
      '',
    ].join('\n\n')

    if (process.env.UPDATE_GOLDEN === '1') await writeFile(GOLDEN, rendered, 'utf8')
    expect(rendered).toBe(await readFile(GOLDEN, 'utf8'))
  })
})

describe('the output ceiling — truncation is its own failure (M9)', () => {
  /** The real run-a shape: triage names the right file, then the response stops mid-object. */
  const CUT_OFF = '{\n  "suspects": [\n    {\n      "path": "fixtures/next-app/lib/posts.ts",\n      "reason": "Adds 300 generated posts to the shared array, which every guide page imports and filters over, increa'

  it('retries with a RAISED cap, never the identical request', async () => {
    const provider = scriptedProvider([new Truncated(CUT_OFF, 1000), TRIAGE_OK, DEEP_OK])
    const analysis = await runAnalysis(await regressionResult(), DIFF_DATA, provider)

    expect(analysis.outcome).toBe('analysed')
    // Two triage requests: the second asks for more ROOM, not for better formatting.
    expect(provider.requests[1]!.maxOutputTokens).toBe(provider.requests[0]!.maxOutputTokens * 2)
    expect(provider.requests[1]!.user).toBe(provider.requests[0]!.user)
    expect(provider.requests[1]!.user).not.toMatch(/was rejected/)
  })

  it('names truncation with both numbers when even the raised cap is not enough', async () => {
    const provider = scriptedProvider([new Truncated(CUT_OFF, 1000), new Truncated(CUT_OFF, 6400)])
    const analysis = await runAnalysis(await regressionResult(), DIFF_DATA, provider)

    expect(analysis.outcome).toBe('skipped')
    if (analysis.outcome !== 'skipped') return
    expect(analysis.reason).toMatch(/truncated at 6400 tokens \(cap 6400\)/)
    expect(analysis.reason).toMatch(/already retried once with the cap raised from 3200/)
    // The distinction IS the finding: never call this invalid JSON.
    expect(analysis.reason).not.toMatch(/invalid JSON/)
    expect(analysis.reason).toMatch(/ran out of room, not out of ability/)
  })

  it('malformed output still gets the CORRECTIVE retry — the other failure, the other fix', async () => {
    const provider = scriptedProvider(['not json at all', TRIAGE_OK, DEEP_OK])
    const analysis = await runAnalysis(await regressionResult(), DIFF_DATA, provider)

    expect(analysis.outcome).toBe('analysed')
    expect(provider.requests[1]!.maxOutputTokens).toBe(provider.requests[0]!.maxOutputTokens)
    expect(provider.requests[1]!.user).toMatch(/was rejected/)
  })

  it('caps clear the measured worst case: 31-file triage (1559) and a 150-line fix (2360)', async () => {
    const provider = scriptedProvider([TRIAGE_OK, DEEP_OK])
    await runAnalysis(await regressionResult(), DIFF_DATA, provider)
    expect(provider.requests[0]!.maxOutputTokens).toBeGreaterThan(1559 * 1.5)
    expect(provider.requests[1]!.maxOutputTokens).toBeGreaterThan(2360 * 2)
  })
})
