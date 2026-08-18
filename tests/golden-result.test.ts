import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { DRIFTWATCH_VERSION, buildResult } from '../src/core/index.js'
import type {
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

describe('result JSON contract (schema v1)', () => {
  it('matches the golden file byte for byte', async () => {
    const result = buildResult({
      profile,
      config,
      plan,
      base,
      current: currentSide,
      now: () => new Date('2026-08-19T12:00:00.000Z'),
    })

    // driftwatchVersion tracks the package; pin it in the golden via substitution so a version
    // bump alone does not count as a contract change.
    const rendered = JSON.stringify(result, null, 2).replaceAll(
      DRIFTWATCH_VERSION,
      '<driftwatch-version>',
    )

    if (process.env.UPDATE_GOLDEN === '1') {
      await writeFile(GOLDEN, rendered + '\n', 'utf8')
    }

    const golden = await readFile(GOLDEN, 'utf8')
    expect(rendered + '\n').toBe(golden)
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
