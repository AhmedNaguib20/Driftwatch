import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { COMMENT_MARKER, renderComment, renderSummary } from '../src/adapters/github/index.js'
import type { MetricComparison, ResultJson } from '../src/core/index.js'

/**
 * Golden tests for the PR comment — the adapter's contract with its readers. Each scenario is a
 * surgical variant of the schema-1.1 golden result, so the renderer is tested against exactly
 * what core emits. Regenerate deliberately with UPDATE_GOLDEN=1 and review the diff as a UI
 * change, because it is one.
 */

const golden = (name: string) => path.join(import.meta.dirname, 'golden', name)

async function baseResult(): Promise<ResultJson> {
  const raw = await readFile(golden('result-v1.1.json'), 'utf8')
  return JSON.parse(raw.replaceAll('<driftwatch-version>', '0.2.0')) as ResultJson
}

function noChangeMetric(m: MetricComparison): MetricComparison {
  if (m.verdict !== 'regressed') return m
  return {
    ...m,
    verdict: 'no_change',
    delta: null,
    exceedsThreshold: false,
    reason: 'delta is under the 2% noise floor',
    current: m.base,
  }
}

const SSG_REASON =
  'prerendered (SSG) — served as static files; excluded from route_latency (regressions surface in bundle_size / Lighthouse)'

function policyRow(route: string, reason: string): MetricComparison {
  return {
    id: `route_latency:${route}`, label: `route ${route}`, unit: null,
    base: null, current: null, delta: null, verdict: 'skipped',
    // Both sides skip identically, so core emits the reason ONCE (no base:/current: prefixes).
    exceedsThreshold: false, reason, excluded: true,
  }
}

/** The real-email shape: five identical SSG exclusions + one dynamic-segment skip. */
function withPolicyRows(result: ResultJson): ResultJson {
  return {
    ...result,
    comparison: {
      ...result.comparison,
      metrics: [
        ...result.comparison.metrics,
        policyRow('/', SSG_REASON),
        policyRow('/about', SSG_REASON),
        policyRow('/blog', SSG_REASON),
        policyRow('/dashboard', SSG_REASON),
        policyRow('/blog/[slug]', 'dynamic segment — no concrete URL to measure'),
      ],
    },
  }
}

async function scenario(name: string): Promise<ResultJson> {
  const result = withPolicyRows(await baseResult())
  switch (name) {
    case 'regression-analysed':
      return result
    case 'regression-no-key':
      return { ...result, analysis: { outcome: 'no_key' } }
    case 'regression-analysis-skipped':
      return {
        ...result,
        analysis: {
          outcome: 'skipped',
          reason: 'triage failed: timeout: deepseek did not respond within 60000ms',
        },
      }
    case 'no-change':
      return {
        ...result,
        verdict: 'ok',
        comparison: {
          ...result.comparison,
          metrics: result.comparison.metrics.map(noChangeMetric),
        },
        analysis: { outcome: 'skipped', reason: 'analysis runs only on a regression verdict' },
      }
    case 'regression-verified-upgrade': {
      // Spec v35: confidence held the diff back from display; measurement earned it back.
      if (result.analysis?.outcome !== 'analysed') throw new Error('fixture must be analysed')
      const diff = result.analysis.fix.content
      return {
        ...result,
        analysis: {
          ...result.analysis,
          confidence: 0.7,
          fix: {
            kind: 'prose',
            content: diff,
            note: 'downgraded from a diff: confidence 0.7 is below the 0.8 bar for ready-to-apply patches',
            diff,
          },
        },
        verification: {
          outcome: 'restored',
          reason: null,
          metrics: [{ id: 'client_bundle_size', label: 'bundle size', unit: 'bytes', base: 2305491, current: 2453493, fixed: 2306980, verdict: 'restored' }],
          diff,
          elapsedMs: 41000,
        },
      }
    }
    case 'regression-verify-failed':
      return {
        ...result,
        verification: {
          outcome: 'no-recovery',
          reason: null,
          metrics: [{ id: 'client_bundle_size', label: 'bundle size', unit: 'bytes', base: 2305491, current: 2453493, fixed: 2452000, verdict: 'no-recovery' }],
          diff: '--- a/x\n+++ b/x\n',
          elapsedMs: 39000,
          devOverride: true,
        },
      }
    case 'nothing-measured': {
      // The jinni shape (spec §9a): every metric skipped, the real error multi-line, a fix known.
      const npmError = [
        'install failed (code 1):',
        'npm error code EUNSUPPORTEDPROTOCOL',
        'npm error Unsupported URL Type "workspace:": workspace:*',
      ].join('\n')
      const fix = [
        '`npm install` cannot resolve `workspace:*` dependencies — those exist only inside a',
        'pnpm/yarn workspace, and driftwatch measured this app on its own.',
        'This project looks like a monorepo package. Point driftwatch at the workspace root, or',
        'set the package manager explicitly in perf.yml:',
        '',
        '    package_manager: pnpm',
      ].join('\n')
      const skip = (m: MetricComparison, reason: string, withFix = false): MetricComparison => ({
        ...m, verdict: 'skipped', base: null, current: null, delta: null,
        exceedsThreshold: false, reason, ...(withFix ? { fix } : {}),
      })
      return {
        ...result,
        verdict: 'inconclusive',
        analysis: { outcome: 'skipped', reason: 'analysis runs only on a regression verdict' },
        comparison: {
          ...result.comparison,
          metrics: result.comparison.metrics.map((m, i) =>
            m.excluded ? m : skip(m, i === 0 ? npmError : 'no build output to weigh (build did not succeed)', i === 0),
          ),
        },
      }
    }
    case 'inconclusive-measurement':
      return {
        ...result,
        verdict: 'inconclusive',
        base: { available: false, reason: 'base ref "main" does not resolve to a commit in this repository' },
        comparison: {
          ...result.comparison,
          protocolsMatch: false,
          metrics: result.comparison.metrics.map((m) => ({
            ...m,
            verdict: 'skipped' as const,
            delta: null,
            exceedsThreshold: false,
            base: null,
            reason: 'base unavailable: base ref "main" does not resolve to a commit in this repository',
          })),
        },
        analysis: { outcome: 'skipped', reason: 'analysis runs only on a regression verdict' },
      }
    default:
      throw new Error(`unknown scenario ${name}`)
  }
}

const SCENARIOS = [
  'nothing-measured',
  'regression-analysed',
  'regression-verified-upgrade',
  'regression-verify-failed',
  'regression-no-key',
  'regression-analysis-skipped',
  'no-change',
  'inconclusive-measurement',
] as const

describe('PR comment renderer — golden contract', () => {
  const RUN_URL = 'https://github.com/ahmed/driftwatch/actions/runs/123456'

  for (const name of SCENARIOS) {
    it(`renders ${name} to its golden file`, async () => {
      const rendered = renderComment(await scenario(name), { runUrl: RUN_URL }) + '\n'
      const file = golden(`comment-${name}.md`)
      if (process.env.UPDATE_GOLDEN === '1') await writeFile(file, rendered, 'utf8')
      expect(rendered).toBe(await readFile(file, 'utf8'))
    })
  }

  it('groups identical-reason policy skips into one row with a details list', async () => {
    const rendered = renderComment(await scenario('regression-analysed'))
    expect(rendered).toContain('| 4 rows excluded by policy | — | — | prerendered (SSG) |')
    // the odd one out (different reason) stays its own row:
    expect(rendered).toContain('| route /blog/[slug] |')
    expect(rendered).toContain('<summary>Excluded rows</summary>')
    expect(rendered).toContain('route /, route /about, route /blog, route /dashboard — prerendered (SSG)')
    // and the five reasons no longer appear as five table rows:
    expect([...rendered.matchAll(/prerendered \(SSG\)/g)].length).toBeLessThanOrEqual(2)
  })

  it('the comment carries no per-side accounting; it links to the run summary instead', async () => {
    const rendered = renderComment(await scenario('regression-analysed'), { runUrl: 'https://x/runs/9' })
    expect(rendered).not.toContain('All metrics')
    expect(rendered).not.toContain('samples:')
    expect(rendered).toContain('[run summary](https://x/runs/9)')
  })

  it('the summary carries the accounting with methodology stated once per metric', async () => {
    const result = await scenario('regression-analysed')
    const summary = renderSummary(result, { commentUrl: 'https://x/c/1', checkUrl: 'https://x/ch/2' })
    expect(summary).toContain('[PR comment](https://x/c/1)')
    expect(summary).toContain('[check](https://x/ch/2)')
    expect(summary).toContain('## All metrics')
    // methodology once (workspace word stripped), values per side:
    expect([...summary.matchAll(/median of 3 cold builds/g)]).toHaveLength(1)
    expect(summary).toContain('- Base: 8.72 s (samples: 11143, 8629, 8724)')
    expect(summary).toContain('- This PR: 9.35 s (samples: 11810, 9350, 9349)')
    expect(summary).not.toMatch(/in a (worktree|copy)/)
  })

  it('every rendering carries the upsert marker exactly once, first line', async () => {
    for (const name of SCENARIOS) {
      const rendered = renderComment(await scenario(name))
      expect(rendered.startsWith(COMMENT_MARKER)).toBe(true)
      expect(rendered.split(COMMENT_MARKER)).toHaveLength(2)
    }
  })

  it('regression banner names the crossed metrics and the threshold', async () => {
    const rendered = renderComment(await scenario('regression-analysed'))
    expect(rendered).toContain('⚠️ Performance regression detected')
    expect(rendered).toContain('**build time (cold)** is up +7.2%')
    expect(rendered).toContain('Threshold is 5%')
    expect(rendered).toContain('`main@c0ffee0`')
  })

  it('the table keeps explicit no-change rows so the reader knows we looked', async () => {
    const rendered = renderComment(await scenario('regression-analysed'))
    expect(rendered).toContain('| client bundle size |')
    expect(rendered).toContain('| no change |')
  })

  it('confidence renders as number + calibrated word, never bare adjectives', async () => {
    const rendered = renderComment(await scenario('regression-analysed'))
    expect(rendered).toContain('confidence 90% (high)')
    expect(rendered).not.toMatch(/definitely/i)
  })

  it('no-key renders the measurement intact, and the tier note exactly once', async () => {
    const rendered = renderComment(await scenario('regression-no-key'))
    expect(rendered).toContain('⚠️ Performance regression detected')
    expect(rendered).not.toContain('Likely cause')

    // The free tier is not a misconfiguration: the note says what the tier adds and how to turn
    // it on, once, and nowhere else in the comment is the key named (spec §9e).
    expect(rendered).toContain('optional AI tier')
    expect([...rendered.matchAll(/DRIFTWATCH_API_KEY/g)]).toHaveLength(1)
  })

  it('on a fork PR it explains the mechanism instead of giving advice that cannot work', async () => {
    const rendered = renderComment(await scenario('regression-no-key'), { fromFork: true })

    expect(rendered).toContain('repository secrets are not exposed to fork runs')
    // A fork author cannot set the secret, so the comment must not tell them to.
    expect(rendered).not.toContain("set `DRIFTWATCH_API_KEY`")
  })

  it('renders the summary golden', async () => {
    const summary =
      renderSummary(await scenario('regression-analysed'), {
        commentUrl: 'https://github.com/ahmed/driftwatch/pull/7#issuecomment-1',
        checkUrl: 'https://github.com/ahmed/driftwatch/runs/2',
      }) + '\n'
    const file = golden('summary-regression-analysed.md')
    if (process.env.UPDATE_GOLDEN === '1') await writeFile(file, summary, 'utf8')
    expect(summary).toBe(await readFile(file, 'utf8'))
  })

  it('never-ran reads as "not measured", never as eight quiet em-dashes', async () => {
    const rendered = renderComment(await scenario('nothing-measured'))
    expect(rendered).toContain('_not measured_')
    expect(rendered).toContain('Nothing was measured this run')
    // The provenance line that assumes measurement happened must be gone.
    expect(rendered).not.toContain('both sides measured fresh')
  })

  it('shows the LAST reason line and points at the full error — never a dangling promise', async () => {
    const rendered = renderComment(await scenario('nothing-measured'))
    expect(rendered).toContain('npm error Unsupported URL Type')
    expect(rendered).toContain('(full error in the run summary)')
    // The first line ended in a colon promising output it could not show — never rendered alone.
    expect(rendered).not.toMatch(/skipped — install failed \(code 1\):\s*\|/)
  })

  it('every failure carries its own fix — the exact config, not advice', async () => {
    const rendered = renderComment(await scenario('nothing-measured'))
    expect(rendered).toContain('How to get these numbers')
    expect(rendered).toContain('package_manager: pnpm')
  })

  it('the run summary carries the FULL multi-line error the comment abbreviated', async () => {
    const summary = renderSummary(await scenario('nothing-measured'), { commentUrl: null, checkUrl: null })
    expect(summary).toContain('Why metrics are missing')
    expect(summary).toContain('npm error code EUNSUPPORTEDPROTOCOL')
    expect(summary).toContain('npm error Unsupported URL Type "workspace:": workspace:*')
    expect(summary).toContain('How to get this number')
  })

  it('a prose-displayed diff that verifies gets the diff display back with its measured numbers', async () => {
    const rendered = renderComment(await scenario('regression-verified-upgrade'))
    expect(rendered).toContain('**Suggested fix** (diff verified by measurement: restored)')
    expect(rendered).toContain('measurement verified it: bundle size 2.34 MB → 2.20 MB (restored)')
    expect(rendered).toContain('```diff')
    // The confidence-downgrade note is superseded by the measured outcome — not repeated.
    expect(rendered).not.toContain('below the 0.8 bar')
  })

  it('a failed verification reports honestly and stamps the dev override', async () => {
    const rendered = renderComment(await scenario('regression-verify-failed'))
    expect(rendered).toContain('a fix was proposed but did not verify (no recovery: bundle size 2.34 MB→2.34 MB vs base 2.20 MB) — no fix PR opened.')
    expect(rendered).toContain('DEV OVERRIDE: verification measured a substituted diff')
  })

  it('the what-was-sent details appear only when analysis actually ran', async () => {
    expect(renderComment(await scenario('regression-analysed'))).toContain('What was sent to the AI provider')
    expect(renderComment(await scenario('regression-no-key'))).not.toContain('What was sent')
    expect(renderComment(await scenario('no-change'))).not.toContain('What was sent')
  })
})

describe('policy-skip grouping keys on what the reader SEES', () => {
  it('rows that display identically group together, however their reasons differ downstream', async () => {
    // The jinni re-run split "dynamic segment" into two rows (19 + 5): five routes were new on
    // the branch, so their reason carried "(not present at base)" and hashed differently. Two
    // rows with the same visible label and different counts is exactly what grouping prevents.
    const base = await baseResult()
    const dynamic = 'dynamic segment — no concrete URL to measure'
    const rows: MetricComparison[] = [
      policyRow('/a/[id]', dynamic),
      policyRow('/b/[id]', dynamic),
      { ...policyRow('/c/[id]', `${dynamic} (not present at base)`) },
    ]
    const rendered = renderComment({
      ...base,
      comparison: { ...base.comparison, metrics: [...base.comparison.metrics, ...rows] },
    })

    expect(rendered).toContain('| 3 rows excluded by policy | — | — | dynamic segment |')
    expect(rendered).not.toMatch(/\| 2 rows excluded by policy .*dynamic segment/)
    expect(rendered).toContain('route /a/[id], route /b/[id], route /c/[id]')
  })
})
