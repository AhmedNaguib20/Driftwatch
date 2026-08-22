import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  FIX_PR_MARKER,
  createGithubClient,
  proposeFixPr,
  pushFixBranch,
  renderFixPrBody,
  renderFixPrTitle,
} from '../src/adapters/github/index.js'
import { attachVerification } from '../src/core/index.js'
import type { ResultJson, VerificationReport } from '../src/core/index.js'

const exec = promisify(execFile)
const TOKEN = 'ghp_fixpr_secret'
const temps: string[] = []

async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'driftwatch-fixpr-'))
  temps.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(temps.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

// ---- fixtures ----

async function goldenResult(autoFix: 'off' | 'propose'): Promise<ResultJson> {
  const raw = await readFile(path.join(import.meta.dirname, 'golden', 'result-v1.1.json'), 'utf8')
  const result = JSON.parse(raw.replaceAll('<driftwatch-version>', '0.6.0')) as ResultJson
  return { ...result, config: { ...result.config, auto_fix: autoFix } }
}

const DIFF = `--- a/app.js
+++ b/app.js
@@ -1,2 +1,2 @@
 const size = 'small'
-const payload = 'HEAVY'
+const payload = 'light'
`

function verification(outcome: VerificationReport['outcome']): VerificationReport {
  return {
    outcome,
    reason: outcome === 'not-applicable' ? 'the suggested diff does not apply cleanly: context drift' : null,
    metrics:
      outcome === 'restored' || outcome === 'partial'
        ? [{ id: 'client_bundle_size', label: 'bundle size', unit: 'bytes', base: 2305491, current: 2453493, fixed: 2306000, verdict: outcome === 'restored' ? 'restored' : 'partial' }]
        : [],
    diff: outcome === 'skipped' ? null : DIFF,
    elapsedMs: 41200,
  }
}

async function verifiedResult(autoFix: 'off' | 'propose', outcome: VerificationReport['outcome']): Promise<ResultJson> {
  return attachVerification(await goldenResult(autoFix), verification(outcome))
}

interface Recorded { method: string; url: string; headers: Record<string, string>; body: string | null }

function fakeGithub(routes: [RegExp, (r: Recorded) => Response | object][]) {
  const requests: Recorded[] = []
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const recorded: Recorded = {
      method: init?.method ?? 'GET',
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: (init?.body as string) ?? null,
    }
    requests.push(recorded)
    for (const [pattern, respond] of routes) {
      if (pattern.test(`${recorded.method} ${recorded.url}`)) {
        const out = respond(recorded)
        return out instanceof Response ? out : new Response(JSON.stringify(out), { status: 200 })
      }
    }
    return new Response('{"message":"unrouted"}', { status: 500 })
  }) as unknown as typeof fetch
  return { fetchImpl, requests }
}

/** Repo + bare origin whose main tip is the "PR head" the fix branch must build on. */
async function repoWithHead(): Promise<{ work: string; bare: string; headSha: string }> {
  const bare = await scratch()
  await exec('git', ['init', '-q', '--bare', bare])
  const work = await scratch()
  await exec('git', ['init', '-q', '-b', 'feature'], { cwd: work })
  await exec('git', ['-C', work, 'config', 'user.email', 't@t'])
  await exec('git', ['-C', work, 'config', 'user.name', 't'])
  await writeFile(path.join(work, 'app.js'), "const size = 'small'\nconst payload = 'HEAVY'\n", 'utf8')
  await exec('git', ['-C', work, 'add', '-A'])
  await exec('git', ['-C', work, 'commit', '-q', '-m', 'head'])
  await exec('git', ['-C', work, 'remote', 'add', 'origin', bare])
  await exec('git', ['-C', work, 'push', '-q', 'origin', 'feature'])
  const headSha = (await exec('git', ['-C', work, 'rev-parse', 'HEAD'])).stdout.trim()
  return { work, bare, headSha }
}

function ctx(work: string, headSha: string, overrides: Partial<Parameters<typeof proposeFixPr>[1]> = {}) {
  return {
    owner: 'ahmed', repo: 'driftwatch', prNumber: 7, headRef: 'feature',
    headSha, fromFork: false, gitRoot: work, ...overrides,
  }
}

// ---- branch mechanics (real git) ----

describe('fix branch', () => {
  it('builds on the head sha, commits exactly the diff bytes, force-pushes', async () => {
    const { work, bare, headSha } = await repoWithHead()

    const pushed = await pushFixBranch({ gitRoot: work, headSha, prNumber: 7, diff: DIFF, message: 'perf: fix' })

    expect(pushed).toEqual({ ok: true, branch: 'driftwatch/fix-pr7' })
    const content = (await exec('git', ['-C', bare, 'show', 'driftwatch/fix-pr7:app.js'])).stdout
    expect(content).toContain("payload = 'light'")
    const parent = (await exec('git', ['-C', bare, 'rev-parse', 'driftwatch/fix-pr7^'])).stdout.trim()
    expect(parent).toBe(headSha)
    // re-run force-updates the same branch without error
    const again = await pushFixBranch({ gitRoot: work, headSha, prNumber: 7, diff: DIFF, message: 'perf: fix' })
    expect(again.ok).toBe(true)
    // and the user's own branch was never touched
    expect((await exec('git', ['-C', work, 'rev-parse', 'feature'])).stdout.trim()).toBe(headSha)
  })

  it('a diff that no longer applies reports honestly, pushes nothing', async () => {
    const { work, bare, headSha } = await repoWithHead()
    const stale = DIFF.replace("const payload = 'HEAVY'", "const payload = 'DIFFERENT'")

    const pushed = await pushFixBranch({ gitRoot: work, headSha, prNumber: 7, diff: stale, message: 'x' })

    expect(pushed.ok).toBe(false)
    if (!pushed.ok) expect(pushed.reason).toMatch(/no longer applies/)
    await expect(exec('git', ['-C', bare, 'rev-parse', 'driftwatch/fix-pr7'])).rejects.toThrow()
  })
})

// ---- REST orchestration (mocked API) ----

describe('proposeFixPr — gates', () => {
  it('auto_fix off → skipped, zero API calls', async () => {
    const { work, headSha } = await repoWithHead()
    const gh = fakeGithub([])
    const outcome = await proposeFixPr(
      createGithubClient({ token: TOKEN, fetchImpl: gh.fetchImpl }),
      ctx(work, headSha),
      await verifiedResult('off', 'restored'),
    )
    expect(outcome).toEqual({ kind: 'skipped', reason: 'auto_fix is off', commentLine: null })
    expect(gh.requests).toHaveLength(0)
  })

  it('no-recovery / build-broken NEVER open a PR', async () => {
    const { work, headSha } = await repoWithHead()
    for (const bad of ['no-recovery', 'build-broken'] as const) {
      const gh = fakeGithub([[/GET .*\/pulls\?/, () => []]])
      const outcome = await proposeFixPr(
        createGithubClient({ token: TOKEN, fetchImpl: gh.fetchImpl }),
        ctx(work, headSha),
        await verifiedResult('propose', bad),
      )
      expect(outcome.kind).toBe('skipped')
      expect(gh.requests.filter((r) => r.method === 'POST')).toHaveLength(0)
    }
  })

  it('fork PRs skip with the honest comment line, no push attempted', async () => {
    const { work, bare, headSha } = await repoWithHead()
    const gh = fakeGithub([[/GET .*\/pulls\?/, () => []]])
    const outcome = await proposeFixPr(
      createGithubClient({ token: TOKEN, fetchImpl: gh.fetchImpl }),
      ctx(work, headSha, { fromFork: true }),
      await verifiedResult('propose', 'restored'),
    )
    expect(outcome.kind).toBe('skipped')
    if (outcome.kind === 'skipped') expect(outcome.commentLine).toMatch(/fork PRs/)
    await expect(exec('git', ['-C', bare, 'rev-parse', 'driftwatch/fix-pr7'])).rejects.toThrow()
  })
})

describe('proposeFixPr — open, upsert, self-close', () => {
  it('opens INTO the PR branch with the marker body; partial says so in the title', async () => {
    const { work, headSha } = await repoWithHead()
    const gh = fakeGithub([
      [/GET .*\/pulls\?/, () => []],
      [/POST .*\/pulls$/, (r) => {
        const body = JSON.parse(r.body!)
        expect(body.base).toBe('feature') // into the PR branch, never main
        expect(body.head).toBe('driftwatch/fix-pr7')
        expect(body.body).toContain(FIX_PR_MARKER)
        expect(body.title).toMatch(/^perf: partially recovers/)
        return { number: 99, html_url: 'https://github.com/pr/99' }
      }],
    ])
    const outcome = await proposeFixPr(
      createGithubClient({ token: TOKEN, fetchImpl: gh.fetchImpl }),
      ctx(work, headSha),
      await verifiedResult('propose', 'partial'),
    )
    expect(outcome.kind).toBe('opened')
  })

  it('re-runs PATCH the same PR instead of opening a second', async () => {
    const { work, headSha } = await repoWithHead()
    const gh = fakeGithub([
      [/GET .*\/pulls\?/, () => [{ number: 99, html_url: 'https://github.com/pr/99', body: `${FIX_PR_MARKER}\nold` }]],
      [/PATCH .*\/pulls\/99$/, () => ({ number: 99, html_url: 'https://github.com/pr/99' })],
    ])
    const outcome = await proposeFixPr(
      createGithubClient({ token: TOKEN, fetchImpl: gh.fetchImpl }),
      ctx(work, headSha),
      await verifiedResult('propose', 'restored'),
    )
    expect(outcome.kind).toBe('updated')
    expect(gh.requests.filter((r) => r.method === 'POST' && /\/pulls$/.test(r.url))).toHaveLength(0)
  })

  it('a stale diff self-closes the existing fix PR with one line', async () => {
    const { work, headSha } = await repoWithHead()
    const closed: string[] = []
    const gh = fakeGithub([
      [/GET .*\/pulls\?/, () => [{ number: 99, html_url: 'u', body: `${FIX_PR_MARKER}\nold` }]],
      [/POST .*\/issues\/99\/comments$/, (r) => {
        expect(JSON.parse(r.body!).body).toMatch(/no longer apply cleanly/)
        return { id: 1 }
      }],
      [/PATCH .*\/pulls\/99$/, (r) => {
        closed.push(JSON.parse(r.body!).state)
        return { number: 99 }
      }],
    ])
    const outcome = await proposeFixPr(
      createGithubClient({ token: TOKEN, fetchImpl: gh.fetchImpl }),
      ctx(work, headSha),
      await verifiedResult('propose', 'not-applicable'),
    )
    expect(outcome).toEqual({ kind: 'closed-stale', number: 99 })
    expect(closed).toEqual(['closed'])
  })

  it('token hygiene: header only, never in URLs, bodies, or outputs', async () => {
    const { work, headSha } = await repoWithHead()
    const gh = fakeGithub([
      [/GET .*\/pulls\?/, () => []],
      [/POST .*\/pulls$/, () => ({ number: 99, html_url: 'u' })],
    ])
    await proposeFixPr(
      createGithubClient({ token: TOKEN, fetchImpl: gh.fetchImpl }),
      ctx(work, headSha),
      await verifiedResult('propose', 'restored'),
    )
    for (const r of gh.requests) {
      expect(r.headers.authorization).toBe(`Bearer ${TOKEN}`)
      expect(r.url).not.toContain(TOKEN)
      expect(r.body ?? '').not.toContain(TOKEN)
    }
  })
})

describe('fix PR body golden', () => {
  it('the body is the measured evidence and matches its golden file', async () => {
    const result = await verifiedResult('propose', 'restored')
    const rendered =
      `# ${renderFixPrTitle(result, result.verification!)}\n\n` +
      renderFixPrBody(result, result.verification!) +
      '\n'
    const golden = path.join(import.meta.dirname, 'golden', 'fix-pr-body.md')
    if (process.env.UPDATE_GOLDEN === '1') await writeFile(golden, rendered, 'utf8')
    expect(rendered).toBe(await readFile(golden, 'utf8'))
    expect(rendered).toContain('verified by measurement in the same run')
    expect(rendered).not.toContain('```diff') // the diff lives in Files Changed, not the body
  })
})
