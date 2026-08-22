import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

import {
  assessMetric,
  attachAnalysis,
  attachVerification,
  buildResult,
  detectProject,
  overallOutcome,
  verifyFix,
} from '../src/core/index.js'
import type {
  AnalysisReport,
  MeasurementProtocol,
  MetricResult,
  ProjectProfile,
  ResultJson,
  SideMeasurement,
} from '../src/core/index.js'

const exec = promisify(execFile)
const temps: string[] = []

async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'driftwatch-verify-'))
  temps.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(temps.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

// ---------- three-way math ----------

describe('three-way assessment', () => {
  const bundle = (fixed: number) =>
    assessMetric({ id: 'client_bundle_size', label: 'bundle size', unit: 'bytes', base: 2_200_000, current: 2_340_000, fixed })

  it('restored: fixed within the floor of base', () => {
    expect(bundle(2_205_000).verdict).toBe('restored') // +0.2% off base
  })
  it('partial: meaningfully recovered, not to base', () => {
    expect(bundle(2_280_000).verdict).toBe('partial')
  })
  it('no-recovery: fixed ≈ current', () => {
    expect(bundle(2_338_000).verdict).toBe('no-recovery')
  })
  it('a fix that makes it WORSE is no-recovery, not partial', () => {
    expect(bundle(2_450_000).verdict).toBe('no-recovery')
  })
  it('time metrics use their class quantum: a 4ms route "restored" within 5ms', () => {
    const m = assessMetric({ id: 'route_latency:/live', label: 'route /live', unit: 'ms', base: 4, current: 85, fixed: 7 })
    expect(m.verdict).toBe('restored') // |7-4|=3ms < 5ms quantum
  })
  it('overall: all restored → restored; mixed → partial; none → no-recovery', () => {
    const r = bundle(2_205_000)
    const n = bundle(2_338_000)
    expect(overallOutcome([r, r])).toBe('restored')
    expect(overallOutcome([r, n])).toBe('partial')
    expect(overallOutcome([n, n])).toBe('no-recovery')
  })

  // The live Run B4 hole: TBT /live 106→194ms crossed the threshold, the sabotage's third side
  // landed at 147ms — within the 50ms quantum of BOTH sides — and order-dependent checks called
  // it "restored", buying a worthless diff a 'partial' and a fix PR.
  it('resolution gate: a regression inside the combined noise radii can never certify — either way', () => {
    const tbt = (fixed: number) =>
      assessMetric({ id: 'tbt:/live', label: 'TBT /live', unit: 'ms', base: 106, current: 194, fixed })
    expect(tbt(147).verdict).toBe('indistinguishable') // the live wobble
    expect(tbt(110).verdict).toBe('indistinguishable') // even a base-perfect landing proves nothing
    expect(tbt(194).verdict).toBe('indistinguishable') // and an unmoved value disproves nothing
  })

  it('indistinguishable rows never upgrade the overall outcome', () => {
    const r = bundle(2_205_000)
    const n = bundle(2_338_000)
    const i = assessMetric({ id: 'tbt:/live', label: 'TBT /live', unit: 'ms', base: 106, current: 194, fixed: 147 })
    expect(i.verdict).toBe('indistinguishable')
    expect(overallOutcome([n, n, i])).toBe('no-recovery') // the Run B shape: sabotage stays refused
    expect(overallOutcome([r, i])).toBe('partial') // unknowns cap the claim below 'restored'
    expect(overallOutcome([i])).toBe('no-recovery')
  })
})

// ---------- gate + outcome matrix with a mocked measure path ----------

function protocol(overrides: Partial<MeasurementProtocol> = {}): MeasurementProtocol {
  return {
    version: 1, workspace: 'copy', cacheState: 'cold', nodeModules: 'cloned', gitMetadata: 'absent',
    nodeVersion: process.version, platform: process.platform, arch: process.arch,
    buildCommand: 'npm run build', buildSamples: 3, warmupSamples: 1, routeSamples: 5,
    routeWarmupSamples: 1, browser: 'none', lighthouseProfile: 'none', hostLabels: [],
    env: { NEXT_TELEMETRY_DISABLED: '1' }, ...overrides,
  }
}

function measured(id: MetricResult['id'], value: number, unit: 'ms' | 'bytes'): MetricResult {
  return { id, status: 'measured', value, unit, label: id, collectedBy: 't', samples: 1 }
}

function side(metrics: MetricResult[], proto = protocol()): SideMeasurement {
  return { metrics, protocol: proto, warnings: [], elapsedMs: 1, layer2aElapsedMs: 0 }
}

const GOOD_DIFF = `--- a/app.js
+++ b/app.js
@@ -1,2 +1,2 @@
 const size = 'small'
-const payload = 'HEAVY'.repeat(1000)
+const payload = 'light'
`

function analysed(overrides: Partial<Extract<AnalysisReport, { outcome: 'analysed' }>> = {}): AnalysisReport {
  const stage = { provider: 'deepseek', model: 'm', tokens: { input: 1, output: 1 }, durationMs: 1, promptVersion: 2, retried: false }
  const manifest = { files: [], lockfiles: [], estimatedTokens: 1, budgetTokens: 1, truncated: false }
  return {
    outcome: 'analysed', cause: 'heavy payload', confidence: 0.9, evidence: ['e'],
    fix: { kind: 'diff', content: GOOD_DIFF },
    suspects: [], stages: { triage: stage, deep: stage }, context: { triage: manifest, deep: manifest },
    ...overrides,
  }
}

/** A real git-less project dir whose "build" copies app.js size into output. */
async function project(): Promise<{ profile: ProjectProfile; dir: string }> {
  const dir = await scratch()
  const w = async (rel: string, c: string) => {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true })
    await writeFile(path.join(dir, rel), c, 'utf8')
  }
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  await exec('git', ['-C', dir, 'config', 'user.email', 't@t'])
  await exec('git', ['-C', dir, 'config', 'user.name', 't'])
  await w('package.json', JSON.stringify({ name: 'p', scripts: { build: 'node build.js' } }))
  await w('next.config.mjs', 'export default {}\n')
  await w('app.js', "const size = 'small'\nconst payload = 'HEAVY'.repeat(1000)\n")
  await w('build.js', "const fs=require('fs')\nfs.mkdirSync('.next/static',{recursive:true})\nfs.writeFileSync('.next/static/out.js',fs.readFileSync('app.js'))\n")
  await w('.gitignore', 'node_modules/\n.next/\n.perf/\nperf.yml\n')
  await exec('git', ['-C', dir, 'add', '-A'])
  await exec('git', ['-C', dir, 'commit', '-q', '-m', 'c'])
  await w('node_modules/pkg/index.js', 'x')
  const profile = await detectProject({ cwd: dir })
  return { profile, dir }
}

function regressionResult(
  analysis: AnalysisReport,
  currentProto = protocol(),
  sides?: { base: MetricResult[]; current: MetricResult[] },
): ResultJson {
  const config = {
    detect: 'nextjs' as const, app: null, package_manager: null, measure: ['client_bundle_size'], serve: true, browser: true, verify: true, auto_fix: 'off' as const,
    threshold: '5%', block_merge: false, base: 'main', provider: 'deepseek', model: 'm',
    thresholdPercent: 5, noiseFloorPercent: 2, sourcePath: null, warnings: [],
  }
  const profile = {
    projectRoot: '/x', gitRoot: '/x', pathInRepo: '.', language: 'javascript' as const,
    framework: 'nextjs' as const, frameworkVersion: null, packageManager: 'npm' as const,
    lockfile: null, workspaceRoot: null, pathInWorkspace: null, workspaceApps: [], commands: { install: null, build: { bin: 'node', args: ['build.js'] }, serve: null },
    buildOutputDirs: ['.next'], clientOutputDirs: ['.next/static'], cacheDirs: ['.next'], routes: [], supportedMetrics: ['client_bundle_size'],
    warnings: [], evidence: [],
  }
  const base = {
    side: side(sides?.base ?? [measured('build_time', 300, 'ms'), measured('client_bundle_size', 45, 'bytes')]),
    sha: 'a'.repeat(40), fromCache: false, measuredAt: null, cachePath: null,
  }
  const plan = {
    available: true as const, baseRef: 'main', baseSha: 'a'.repeat(40),
    lockfileStatus: 'identical' as const, dependenciesChanged: false as const,
    dependencies: 'clone' as const, commitsAhead: 1, baseAgeDays: 0, likelyIntegrationTarget: null, warnings: [], evidence: [],
  }
  const result = buildResult({
    profile, config, plan, base,
    current: side(sides?.current ?? [measured('build_time', 305, 'ms'), measured('client_bundle_size', 5041, 'bytes')], currentProto),
    now: () => new Date('2026-08-19T12:00:00Z'),
  })
  return attachAnalysis(result, analysis)
}

describe('verifyFix — gates', () => {
  it('skips on prose-only fixes and non-regressions; confidence is never consulted (spec v35)', async () => {
    const { profile } = await project()

    // Model prose with no machine diff: nothing to measure.
    const prose = await verifyFix(profile, regressionResult(analysed({ fix: { kind: 'prose', content: 'x' } })))
    expect(prose.outcome).toBe('skipped')
    expect(prose.reason).toMatch(/no machine-applicable diff/)

    const ok = { ...regressionResult(analysed()), verdict: 'ok' as const }
    expect((await verifyFix(profile, ok)).outcome).toBe('skipped')
  })

  it('assesses only threshold-crossers: a noise-band timing wobble cannot buy a worthless fix a partial', async () => {
    const { profile } = await project()

    // build_time +3.3% is over the noise floor+quantum (regressed row) but UNDER the 5%
    // threshold; bundle_size is the actual regression. The "fix" leaves bundle untouched
    // while build time wobbles back near base — the live Run B sabotage shape.
    const result = regressionResult(analysed(), protocol(), {
      base: [measured('build_time', 30_000, 'ms'), measured('client_bundle_size', 45, 'bytes')],
      current: [measured('build_time', 31_000, 'ms'), measured('client_bundle_size', 5041, 'bytes')],
    })
    const buildRow = result.comparison.metrics.find((m) => m.id === 'build_time')!
    expect(buildRow.verdict).toBe('regressed')
    expect(buildRow.exceedsThreshold).toBe(false)

    const report = await verifyFix(profile, result, {
      serve: false,
      browser: false,
      measureFn: async () =>
        side([measured('build_time', 30_200, 'ms'), measured('client_bundle_size', 5041, 'bytes')]),
    })

    expect(report.metrics.map((m) => m.id)).toEqual(['client_bundle_size'])
    expect(report.outcome).toBe('no-recovery')
  })

  it('verifies a low-confidence diff and a prose-displayed diff — the display bar is not a measurement gate', async () => {
    const { profile } = await project()

    const low = await verifyFix(profile, regressionResult(analysed({ confidence: 0.7 })), { serve: false, browser: false })
    expect(low.outcome).toBe('restored')

    // enforceFixRules' confidence downgrade: shown as prose, diff kept for verification.
    const downgraded = analysed({
      confidence: 0.7,
      fix: { kind: 'prose', content: GOOD_DIFF, note: 'downgraded from a diff: confidence 0.7 is below the 0.8 bar for ready-to-apply patches', diff: GOOD_DIFF },
    })
    const report = await verifyFix(profile, regressionResult(downgraded), { serve: false, browser: false })
    expect(report.outcome).toBe('restored')
  })
})

describe('verifyFix — outcome matrix (real apply, real tiny builds)', () => {
  it('not-applicable: a diff that does not apply cleanly is reported, never patched around', async () => {
    const { profile } = await project()
    const bad = analysed({ fix: { kind: 'diff', content: GOOD_DIFF.replace("const size = 'small'", "const size = 'WRONG-CONTEXT'") } })

    const report = await verifyFix(profile, regressionResult(bad), { serve: false, browser: false })

    expect(report.outcome).toBe('not-applicable')
    expect(report.reason).toMatch(/does not apply cleanly/)
  })

  it('restored: the fix really shrinks the output back to base', async () => {
    const { profile } = await project()

    const report = await verifyFix(profile, regressionResult(analysed()), { serve: false, browser: false })

    expect(report.outcome).toBe('restored')
    expect(report.metrics).toHaveLength(1)
    const m = report.metrics[0]!
    expect(m.id).toBe('client_bundle_size')
    expect(m.fixed).toBeLessThan(100) // 'light' payload
    expect(m.verdict).toBe('restored')
    expect(report.diff).toContain('+const payload')
  })

  it('build-broken: a fix that breaks the build reports with the log tail', async () => {
    const { profile } = await project()
    const breaking = analysed({
      fix: { kind: 'diff', content: `--- a/build.js\n+++ b/build.js\n@@ -1,3 +1,3 @@\n const fs=require('fs')\n-fs.mkdirSync('.next/static',{recursive:true})\n+throw new Error('broken build from the fix')\n fs.writeFileSync('.next/static/out.js',fs.readFileSync('app.js'))\n` },
    })

    const report = await verifyFix(profile, regressionResult(breaking), { serve: false, browser: false })

    expect(report.outcome).toBe('build-broken')
    expect(report.reason).toMatch(/broken build from the fix/)
  })

  it('refused: a third side measured under a different protocol refuses itself (§5.1)', async () => {
    const { profile } = await project()
    const mockMeasure = (async (_p: unknown, w: { kind: 'copy' | 'worktree' }) => side([measured('build_time', 300, 'ms'), measured('client_bundle_size', 41, 'bytes')], protocol({ nodeVersion: 'v99.0.0', workspace: w.kind })) ) as never

    const report = await verifyFix(profile, regressionResult(analysed()), { serve: false, browser: false, measureFn: mockMeasure })

    expect(report.outcome).toBe('refused')
    expect(report.reason).toMatch(/nodeVersion.*v99\.0\.0/)
  })

  it('no-recovery and partial via mocked measurement', async () => {
    const { profile } = await project()
    const withFixedBundle = (value: number) =>
      (async (_p: unknown, w: { kind: 'copy' }) =>
        side([measured('build_time', 300, 'ms'), measured('client_bundle_size', value, 'bytes')], protocol({ workspace: w.kind }))) as never

    const none = await verifyFix(profile, regressionResult(analysed()), { serve: false, browser: false, measureFn: withFixedBundle(5030) })
    expect(none.outcome).toBe('no-recovery')

    const part = await verifyFix(profile, regressionResult(analysed()), { serve: false, browser: false, measureFn: withFixedBundle(2500) })
    expect(part.outcome).toBe('partial')
  })
})

describe('verification golden', () => {
  it('the contract block matches its golden file', async () => {
    const { profile } = await project()
    const report = await verifyFix(profile, regressionResult(analysed()), { serve: false, browser: false })
    const stable = { ...report, elapsedMs: 1234 }
    const result = attachVerification(regressionResult(analysed()), stable)

    const rendered = JSON.stringify({ schemaMinorVersion: result.schemaMinorVersion, verification: result.verification }, null, 2) + '\n'
    const golden = path.join(import.meta.dirname, 'golden', 'verification-block.json')
    if (process.env.UPDATE_GOLDEN === '1') await writeFile(golden, rendered, 'utf8')
    expect(rendered).toBe(await readFile(golden, 'utf8'))
  })
})

describe('apply tolerance — bookkeeping only', () => {
  it('a miscounted hunk header applies (recount); a content mismatch still refuses', async () => {
    const { profile } = await project()
    // Correct content, WRONG old-length in the header (2 real old lines, header claims 5).
    const miscounted = GOOD_DIFF.replace('@@ -1,2 +1,2 @@', '@@ -1,5 +1,5 @@')
    const ok = await verifyFix(profile, regressionResult(analysed({ fix: { kind: 'diff', content: miscounted } })), { serve: false, browser: false })
    expect(ok.outcome).toBe('restored')

    const wrongContent = GOOD_DIFF.replace("const size = 'small'", "const size = 'NOT-IN-FILE'")
    const bad = await verifyFix(profile, regressionResult(analysed({ fix: { kind: 'diff', content: wrongContent } })), { serve: false, browser: false })
    expect(bad.outcome).toBe('not-applicable')
  })
})
