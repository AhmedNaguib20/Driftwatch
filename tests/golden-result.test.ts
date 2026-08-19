import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { DRIFTWATCH_VERSION, attachAnalysis, buildResult } from '../src/core/index.js'
import type {
  AnalysisReport,
  BaselinePlan,
  BaseSideResult,
  MeasurementProtocol,
  ResolvedConfig,
  ProjectProfile,
  SideMeasurement,
} from '../src/core/index.js'

/**
 * Golden-file test: the result JSON is the contract every consumer depends on (CLAUDE.md
 * conventions). This test renders one fully deterministic result and compares it byte-for-byte
 * against tests/golden/result-v1.json.
 *
 * If it fails, one of two things is true:
 *  - unintended: you changed the contract by accident — fix the code.
 *  - intended: the contract is deliberately evolving — regenerate with
 *    `UPDATE_GOLDEN=1 npx vitest run tests/golden-result.test.ts`, review the diff like an API
 *    change (because it is one), and say so in the commit message.
 */

const GOLDEN = path.join(import.meta.dirname, 'golden', 'result-v1.json')
const GOLDEN_11 = path.join(import.meta.dirname, 'golden', 'result-v1.1.json')

function protocol(overrides: Partial<MeasurementProtocol> = {}): MeasurementProtocol {
  return {
    version: 1,
    workspace: 'worktree',
    cacheState: 'cold',
    nodeModules: 'cloned',
    gitMetadata: 'absent',
    nodeVersion: 'v20.20.0',
    platform: 'darwin',
    arch: 'arm64',
    buildCommand: 'npm run build',
    buildSamples: 3,
    warmupSamples: 1,
    routeSamples: 5,
    routeWarmupSamples: 1,
    hostLabels: [],
    env: { NEXT_TELEMETRY_DISABLED: '1' },
    ...overrides,
  }
}

const profile: ProjectProfile = {
  projectRoot: '/repo/app',
  gitRoot: '/repo',
  pathInRepo: 'app',
  language: 'javascript',
  framework: 'nextjs',
  frameworkVersion: '15.1.3',
  packageManager: 'npm',
  lockfile: 'package-lock.json',
  commands: {
    install: { bin: 'npm', args: ['ci'] },
    build: { bin: 'npm', args: ['run', 'build'] },
    serve: { bin: 'node_modules/.bin/next', args: ['start'] },
  },
  buildOutputDirs: ['.next'],
  cacheDirs: ['.next', 'node_modules/.cache'],
  routes: ['/', '/about', '/blog/[slug]'],
  supportedMetrics: ['build_time', 'bundle_size'],
  warnings: ['a project-level warning, verbatim'],
  evidence: [
    { fact: 'framework: nextjs', source: 'package.json', detail: 'depends on next@15.1.3' },
  ],
}

const config: ResolvedConfig = {
  detect: 'nextjs',
  measure: ['build_time', 'bundle_size'],
  serve: true,
  threshold: '5%',
  block_merge: false,
  base: 'main',
  provider: 'deepseek',
  model: 'deepseek-chat',
  thresholdPercent: 5,
  noiseFloorPercent: 2,
  sourcePath: '/repo/app/perf.yml',
  warnings: [],
}

const plan: BaselinePlan = {
  available: true,
  baseRef: 'main',
  baseSha: 'c0ffee0000000000000000000000000000000000',
  lockfileStatus: 'identical',
  dependenciesChanged: false,
  dependencies: 'clone',
  warnings: [],
  evidence: [{ fact: 'base: main @ c0ffee000000', source: 'git' }],
}

const baseSide: SideMeasurement = {
  metrics: [
    {
      id: 'install_time',
      status: 'skipped',
      label: 'install time',
      reason: 'dependencies unchanged between sides — provided by clone, install not measured',
    },
    {
      id: 'build_time',
      status: 'measured',
      value: 8724,
      unit: 'ms',
      label: 'build time (cold)',
      collectedBy: 'median of 3 cold builds, wall clock around `npm run build` in a worktree',
      samples: 3,
      sampleValues: [11143, 8629, 8724],
    },
    {
      id: 'bundle_size',
      status: 'measured',
      value: 2305491,
      unit: 'bytes',
      label: 'bundle size',
      collectedBy: 'sum of file sizes in .next (113 files), excluding internal caches and diagnostics',
      samples: 1,
    },
  ],
  protocol: protocol(),
  warnings: [],
  elapsedMs: 31900,
}

const currentSide: SideMeasurement = {
  metrics: [
    {
      id: 'install_time',
      status: 'skipped',
      label: 'install time',
      reason: 'dependencies unchanged between sides — provided by clone, install not measured',
    },
    {
      id: 'build_time',
      status: 'measured',
      value: 9350,
      unit: 'ms',
      label: 'build time (cold)',
      collectedBy: 'median of 3 cold builds, wall clock around `npm run build` in a copy',
      samples: 3,
      sampleValues: [11810, 9350, 9349],
    },
    {
      id: 'bundle_size',
      status: 'measured',
      value: 2305487,
      unit: 'bytes',
      label: 'bundle size',
      collectedBy: 'sum of file sizes in .next (113 files), excluding internal caches and diagnostics',
      samples: 1,
    },
  ],
  protocol: protocol({ workspace: 'copy' }),
  warnings: [],
  elapsedMs: 33100,
}

const base: BaseSideResult = {
  side: baseSide,
  sha: plan.baseSha,
  fromCache: true,
  measuredAt: '2026-08-19T09:00:00.000Z',
  cachePath: null,
}

const GOLDEN_ANALYSIS: AnalysisReport = {
  outcome: 'analysed',
  cause: 'lib/posts.ts adds a 300-entry archive consumed by generateStaticParams, adding ~300 statically generated pages to the build.',
  confidence: 0.9,
  evidence: [
    'build time (cold) regressed 8724ms → 9350ms (+626ms, +7.18%); samples [11143, 8629, 8724] vs [11810, 9350, 9349]',
    'lib/posts.ts (+25/-1) introduces the archive array that /blog/[slug] statically generates',
  ],
  fix: {
    kind: 'diff',
    content: '--- a/lib/posts.ts\n+++ b/lib/posts.ts\n@@ -1 +1 @@\n-const ARCHIVE_SIZE = 300\n+const ARCHIVE_SIZE = 30\n',
  },
  suspects: [{ path: 'lib/posts.ts', reason: 'adds 300 generated pages' }],
  stages: {
    triage: { provider: 'deepseek', model: 'deepseek-chat', tokens: { input: 1200, output: 90 }, durationMs: 3100, promptVersion: 1, retried: false },
    deep: { provider: 'deepseek', model: 'deepseek-chat', tokens: { input: 5400, output: 420 }, durationMs: 12800, promptVersion: 1, retried: false },
  },
  context: {
    triage: { files: [{ path: 'lib/posts.ts', disposition: 'diffstat-only', insertions: 25, deletions: 1, reason: 'triage sends the diffstat only' }], lockfiles: [], estimatedTokens: 350, budgetTokens: 4000, truncated: false },
    deep: { files: [{ path: 'lib/posts.ts', disposition: 'full', insertions: 25, deletions: 1, reason: null }], lockfiles: [], estimatedTokens: 900, budgetTokens: 24000, truncated: false },
  },
}

describe('result JSON contract (schema v1)', () => {
  it('matches the 1.1 golden file byte for byte', async () => {
    const result = attachAnalysis(
      buildResult({
        profile,
        config,
        plan,
        base,
        current: currentSide,
        now: () => new Date('2026-08-19T12:00:00.000Z'),
      }),
      GOLDEN_ANALYSIS,
    )

    // driftwatchVersion tracks the package; pin it in the golden via substitution so a version
    // bump alone does not count as a contract change.
    const rendered = JSON.stringify(result, null, 2).replaceAll(
      DRIFTWATCH_VERSION,
      '<driftwatch-version>',
    )

    if (process.env.UPDATE_GOLDEN === '1') {
      await writeFile(GOLDEN_11, rendered + '\n', 'utf8')
    }

    expect(rendered + '\n').toBe(await readFile(GOLDEN_11, 'utf8'))
  })

  it('1.1 is a strict superset of 1.0 — every 1.0 field survives with its value', async () => {
    // The 1.0 golden is frozen history: it is never regenerated. A 1.0 consumer must be able to
    // read a 1.1 result, so every leaf present in 1.0 must exist unchanged in 1.1.
    const v10 = JSON.parse(await readFile(GOLDEN, 'utf8'))
    const v11 = JSON.parse(await readFile(GOLDEN_11, 'utf8'))

    const missing: string[] = []
    function compare(a: unknown, b: unknown, at: string): void {
      if (typeof a !== 'object' || a === null) {
        if (JSON.stringify(a) !== JSON.stringify(b)) missing.push(`${at}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`)
        return
      }
      if (Array.isArray(a)) {
        const bArr = b as unknown[]
        a.forEach((item, i) => compare(item, bArr?.[i], `${at}[${i}]`))
        return
      }
      for (const [key, value] of Object.entries(a)) {
        compare(value, (b as Record<string, unknown>)?.[key], `${at}.${key}`)
      }
    }
    compare(v10, v11, '$')

    expect(missing).toEqual([])
  })

  it('the deterministic scenario exercises the interesting rows', async () => {
    const golden = JSON.parse(
      (await readFile(GOLDEN, 'utf8')).replaceAll('<driftwatch-version>', '0.0.0'),
    )
    const verdicts = Object.fromEntries(
      golden.comparison.metrics.map((m: { id: string; verdict: string }) => [m.id, m.verdict]),
    )
    // A skipped row, a genuine regression (7.2% > threshold), and a no-change row.
    expect(verdicts).toEqual({
      install_time: 'skipped',
      build_time: 'regressed',
      bundle_size: 'no_change',
    })
    expect(golden.verdict).toBe('regression')
    expect(golden.schemaVersion).toBe(1)
  })
})
