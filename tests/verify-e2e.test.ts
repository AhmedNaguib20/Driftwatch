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
    await exec('cp', ['-Rc', path.join(repoRoot, 'fixtures', 'next-app', 'node_modules'), path.join(dir, 'node_modules')])
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
    const bundleRow = result.comparison.metrics.find((m) => m.id === 'bundle_size')!
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

    expect(report.outcome).toBe('restored')
    const m = report.metrics.find((x) => x.id === 'bundle_size')!
    expect(m.verdict).toBe('restored')
    // Real numbers: the fix removed what the regression added.
    expect(m.current - m.fixed).toBeGreaterThan(100_000) // ~140KB of lodash gone
    expect(Math.abs(m.fixed - (m.base ?? 0))).toBeLessThan(2_000) // back to base within noise
  }, 600_000)
})
