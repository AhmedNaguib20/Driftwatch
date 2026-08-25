import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { cp, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'

import { attachAnalysis, detectProject, runDriftwatch, verifyFix } from '../src/core/index.js'
import type { AnalysisReport } from '../src/core/index.js'

const exec = promisify(execFile)
const repoRoot = path.resolve(import.meta.dirname, '..')
const temps: string[] = []

afterAll(async () => {
  await Promise.all(temps.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

/**
 * The M6 promise, end to end and REAL: the lodash regression on the actual fixture, the
 * known-good modular-import fix, and a verification verdict backed by real builds. Runs on a
 * temp copy of the fixture (the real one is never touched); serve/browser off keeps it to
 * builds + bundle (~2 minutes of honest work).
 */
describe('fix verification — real end-to-end on the fixture', () => {
  it('the modular-import fix comes back "restored" with real numbers', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'driftwatch-e2e-'))
    temps.push(parent)
    const dir = path.join(parent, 'app')

    // A private copy of the fixture, its own git history, lodash change uncommitted on top.
    await cp(path.join(repoRoot, 'fixtures', 'next-app'), dir, {
      recursive: true,
      filter: (src) => !src.includes('.next') && !src.includes('node_modules'),
    })
    // The PRODUCT guards this (`workspace.ts` uses `cp -Rc` only on darwin and falls back to
    // fs.cp elsewhere); this test copied the fast path without the guard. `-c` is an APFS
    // clone flag that GNU cp does not have, so this line failed outright on Linux — which is
    // why this test had never actually run in CI.
    await ensureFixtureInstalled(path.join(repoRoot, 'fixtures', 'next-app'))
    await cloneNodeModules(path.join(repoRoot, 'fixtures', 'next-app', 'node_modules'), path.join(dir, 'node_modules'))
    await exec('git', ['init', '-q', '-b', 'main'], { cwd: dir })
    await exec('git', ['-C', dir, 'config', 'user.email', 't@t'])
    await exec('git', ['-C', dir, 'config', 'user.name', 't'])
    await writeFile(path.join(dir, '.gitignore'), 'node_modules/\n.next/\n.perf/\nperf.yml\n', 'utf8')
    await exec('git', ['-C', dir, 'add', '-A'])
    await exec('git', ['-C', dir, 'commit', '-q', '-m', 'base'])

    // The regression: full lodash import, uncommitted.
    const chart = path.join(dir, 'app', 'dashboard', 'chart.tsx')
    const original = await readFile(chart, 'utf8')
    let changed = original.replace("'use client'\n\nimport {", "'use client'\n\nimport _ from 'lodash'\nimport {")
    changed = changed.replace(
      'export default function Chart({ data }: { data: Sample[] }) {\n  return (',
      "const logResize = _.debounce(() => console.log('chart resized'), 200)\n\nexport default function Chart({ data }: { data: Sample[] }) {\n  if (typeof window !== 'undefined') window.addEventListener('resize', logResize)\n  return (",
    )
    expect(changed).not.toBe(original)
    await writeFile(chart, changed, 'utf8')

    const result = await runDriftwatch({ cwd: dir, serve: false, browser: false })
    expect(result.verdict).toBe('regression')
    const bundleRow = result.comparison.metrics.find((m) => m.id === 'client_bundle_size')!
    expect(bundleRow.verdict).toBe('regressed')

    // The known-good fix, as the AI proposed it live on PR #6: modular import.
    const fixDiff = [
      '--- a/app/dashboard/chart.tsx',
      '+++ b/app/dashboard/chart.tsx',
      '@@ -1,6 +1,6 @@',
      " 'use client'",
      ' ',
      "-import _ from 'lodash'",
      "+import debounce from 'lodash/debounce'",
      ' import {',
      '   CartesianGrid,',
      '   Line,',
      '@@ -12,7 +12,7 @@',
      " } from 'recharts'",
      " import type { Sample } from '@/lib/metrics'",
      ' ',
      "-const logResize = _.debounce(() => console.log('chart resized'), 200)",
      "+const logResize = debounce(() => console.log('chart resized'), 200)",
      ' ',
      ' export default function Chart({ data }: { data: Sample[] }) {',
      "   if (typeof window !== 'undefined') window.addEventListener('resize', logResize)",
      '',
    ].join('\n')

    const stage = { provider: 'deepseek', model: 'm', tokens: { input: 1, output: 1 }, durationMs: 1, promptVersion: 2, retried: false }
    const manifest = { files: [], lockfiles: [], estimatedTokens: 1, budgetTokens: 1, truncated: false }
    const analysis: AnalysisReport = {
      outcome: 'analysed',
      cause: 'full lodash import in the chart client component',
      confidence: 0.9,
      evidence: ['bundle_size regressed'],
      fix: { kind: 'diff', content: fixDiff },
      suspects: [{ path: 'app/dashboard/chart.tsx', reason: 'the import' }],
      stages: { triage: stage, deep: stage },
      context: { triage: manifest, deep: manifest },
    }

    const profile = await detectProject({ cwd: dir })
    const report = await verifyFix(profile, attachAnalysis(result, analysis), {
      serve: false,
      browser: false,
      installIfAbsent: true,
      progress: () => {},
    })

    // On a loaded machine the fixture's build_time can noise-cross the threshold and dilute the
    // overall to 'partial' beside the byte row (timing is the coarser instrument — spec §5).
    // The contract this test protects is the deterministic class: bundle restored, real numbers.
    expect(['restored', 'partial']).toContain(report.outcome)
    const m = report.metrics.find((x) => x.id === 'client_bundle_size')!
    expect(m.verdict).toBe('restored')
    // Real numbers: the fix removed what the regression added. ~70KB on the CLIENT bundle —
    // the old single metric said ~140KB because lodash landed in both the client chunk and the
    // server bundle, and counted both. Splitting them (spec §9a decision 1) made the headline
    // mean what it says: this is what a browser stops downloading.
    expect(m.current - m.fixed).toBeGreaterThan(50_000)
    expect(Math.abs(m.fixed - (m.base ?? 0))).toBeLessThan(2_000) // back to base within noise
    // 152s unloaded; the whole suite runs it in parallel with other real builds, where it has
    // been seen to exceed 600s. A duration cap is not a correctness assertion — when it trips it
    // says nothing about the code — so it is set well past the loaded worst case rather than
    // tuned close to it.
  }, 1_200_000)
})

/**
 * The fixture's dependencies are gitignored, so they exist only where someone has installed them.
 * On a fresh checkout — which is what CI is — they are simply absent, and this test cannot run.
 * It installs them rather than skipping: a test that quietly does nothing in the one environment
 * that matters is the failure this whole sweep is about.
 */
async function ensureFixtureInstalled(fixture: string): Promise<void> {
  if (existsSync(path.join(fixture, 'node_modules'))) return
  await exec('npm', ['ci', '--no-audit', '--no-fund'], { cwd: fixture, timeout: 600_000 })
}

/** Mirrors src/core/measure/workspace.ts: clone on APFS, plain copy everywhere else. */
async function cloneNodeModules(source: string, target: string): Promise<void> {
  if (process.platform === 'darwin') {
    try {
      await exec('cp', ['-Rc', source, target])
      return
    } catch {
      // Not APFS — fall through to the portable copy.
    }
  }
  await cp(source, target, { recursive: true, verbatimSymlinks: true })
}
