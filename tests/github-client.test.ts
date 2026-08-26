import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type {
  GithubError} from '../src/adapters/github/index.js';
import {
  COMMENT_MARKER,
  conclusionFor,
  createGithubClient,
  publishResult,
  upsertComment,
} from '../src/adapters/github/index.js'
import type { ResultJson } from '../src/core/index.js'

const TOKEN = 'ghp_test_secret_token'

interface Recorded {
  readonly method: string
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: string | null
}

/** Scripted GitHub: route patterns → responses. Records EVERY request for hygiene assertions. */
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

function client(fetchImpl: typeof fetch, sleep = async () => {}) {
  return createGithubClient({ token: TOKEN, fetchImpl, sleep })
}

const TARGET = { owner: 'ahmed', repo: 'driftwatch', prNumber: 7 }

async function regressionResult(): Promise<ResultJson> {
  const raw = await readFile(path.join(import.meta.dirname, 'golden', 'result-v1.1.json'), 'utf8')
  return JSON.parse(raw.replaceAll('<driftwatch-version>', '0.2.0')) as ResultJson
}

describe('comment upsert — one comment, ever (§6.1)', () => {
  it('creates when no marker comment exists', async () => {
    const gh = fakeGithub([
      [/GET .*\/comments\?/, () => []],
      [/POST .*\/issues\/7\/comments$/, () => ({ id: 1, html_url: 'https://github.com/c/1' })],
    ])
    const { url, healed } = await upsertComment(client(gh.fetchImpl), TARGET, `${COMMENT_MARKER}\nhi`)

    expect(url).toBe('https://github.com/c/1')
    expect(healed).toBe(0)
    expect(gh.requests.filter((r) => r.method === 'POST')).toHaveLength(1)
  })

  it('updates in place when the marker comment sits on page 2', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i, body: `noise ${i}` }))
    const page2 = [{ id: 400, body: `${COMMENT_MARKER}\nold`, html_url: 'https://github.com/c/400' }]
    const gh = fakeGithub([
      [/GET .*[&?]page=1$/, () => page1],
      [/GET .*[&?]page=2$/, () => page2],
      [/PATCH .*\/issues\/comments\/400$/, () => ({ id: 400, html_url: 'https://github.com/c/400' })],
    ])

    const { url } = await upsertComment(client(gh.fetchImpl), TARGET, `${COMMENT_MARKER}\nnew`)

    expect(url).toBe('https://github.com/c/400')
    expect(gh.requests.some((r) => r.method === 'PATCH')).toBe(true)
    expect(gh.requests.filter((r) => r.method === 'POST')).toHaveLength(0)
  })

  it('self-heals duplicates: updates the first, deletes the rest', async () => {
    const gh = fakeGithub([
      [/GET .*\/comments\?/, () => [
        { id: 10, body: `${COMMENT_MARKER}\na`, html_url: 'https://github.com/c/10' },
        { id: 11, body: 'unrelated' },
        { id: 12, body: `${COMMENT_MARKER}\nb` },
        { id: 13, body: `${COMMENT_MARKER}\nc` },
      ]],
      [/PATCH .*\/comments\/10$/, () => ({ id: 10, html_url: 'https://github.com/c/10' })],
      [/DELETE .*\/comments\/1[23]$/, () => new Response(null, { status: 204 })],
    ])

    const { healed } = await upsertComment(client(gh.fetchImpl), TARGET, 'body')

    expect(healed).toBe(2)
    const deletes = gh.requests.filter((r) => r.method === 'DELETE').map((r) => r.url)
    expect(deletes).toHaveLength(2)
    expect(deletes[0]).toContain('/comments/12')
    expect(deletes[1]).toContain('/comments/13')
  })
})

describe('check conclusions (§6.2)', () => {
  it('maps verdicts: warn-only regression is NEUTRAL, block_merge makes it failure', () => {
    expect(conclusionFor('ok', false)).toBe('success')
    expect(conclusionFor('regression', false)).toBe('neutral')
    expect(conclusionFor('regression', true)).toBe('failure')
    expect(conclusionFor('inconclusive', false)).toBe('neutral')
    expect(conclusionFor('inconclusive', true)).toBe('neutral')
  })
})

describe('publishResult — never throws, and fails the run only on configuration', () => {
  function happyRoutes() {
    return fakeGithub([
      [/GET .*\/comments\?/, () => []],
      [/POST .*\/issues\/7\/comments$/, () => ({ id: 1, html_url: 'https://github.com/c/1' })],
      [/POST .*\/check-runs$/, (r) => {
        const body = JSON.parse(r.body!)
        expect(body.name).toBe('driftwatch')
        expect(body.conclusion).toBe('neutral') // regression, warn-only
        expect(body.output.summary).toContain('| Metric | Base | This PR | Change |')
        return { id: 2, html_url: 'https://github.com/checks/2' }
      }],
    ])
  }

  async function publish(gh: ReturnType<typeof fakeGithub>, blockMerge = false, fromFork = false) {
    return publishResult(await regressionResult(), {
      ...TARGET,
      headSha: 'abc123',
      blockMerge,
      fromFork,
      token: TOKEN,
      fetchImpl: gh.fetchImpl,
      sleep: async () => {},
    })
  }

  it('posts comment and neutral check with the table in the summary', async () => {
    const gh = happyRoutes()
    const outcome = await publish(gh)

    expect(outcome.commentUrl).toBe('https://github.com/c/1')
    expect(outcome.checkUrl).toBe('https://github.com/checks/2')
    expect(outcome.warnings).toEqual([])
    expect(outcome.blockers).toEqual([])
  })

  it('comment 403 on a FORK PR degrades to check-only with a warning, and stays green', async () => {
    // A fork's token is read-only by GitHub's design, not by the maintainer's mistake. It is the
    // one configuration failure nobody can edit their way out of, so it keeps the old behaviour.
    const gh = fakeGithub([
      [/GET .*\/comments\?/, () => new Response('{"message":"Resource not accessible"}', { status: 403 })],
      [/POST .*\/check-runs$/, () => ({ id: 2, html_url: 'https://github.com/checks/2' })],
    ])
    const outcome = await publish(gh, false, true)

    expect(outcome.commentUrl).toBeNull()
    expect(outcome.checkUrl).toBe('https://github.com/checks/2')
    expect(outcome.warnings.join('\n')).toMatch(/comment could not be posted/)
    expect(outcome.blockers).toEqual([])
  })

  it('the SAME 403 on a normal PR is a blocker carrying the fix, not a warning', async () => {
    /**
     * The run that motivated this printed raw GitHub JSON as a warning and finished green, on a
     * pull request whose regression had been measured correctly. Nobody saw it. A read-only
     * repository does not heal itself, so this is a setup failure — and M3 step 3 put setup
     * failures outside warn-only.
     */
    const gh = fakeGithub([
      [/GET .*\/comments\?/, () => new Response('{"message":"Resource not accessible"}', { status: 403 })],
      [/POST .*\/check-runs$/, () => ({ id: 2, html_url: 'https://github.com/checks/2' })],
    ])
    const outcome = await publish(gh)

    expect(outcome.warnings).toEqual([])
    expect(outcome.blockers).toHaveLength(1)
    expect(outcome.blockers[0]!.what).toMatch(/comment could not be posted/)
    // GitHub's own words are kept, but they are no longer the whole message.
    expect(outcome.blockers[0]!.cause).toMatch(/403/)
    expect(outcome.blockers[0]!.stanza).toContain('pull-requests: write')
    expect(outcome.blockers[0]!.stanza).toContain('statuses: write')
  })

  it('a 503 on the same call stays a warning — GitHub having a bad minute is not configuration', async () => {
    const gh = fakeGithub([
      [/GET .*\/comments\?/, () => new Response('upstream', { status: 503 })],
      [/POST .*\/check-runs$/, () => ({ id: 2, html_url: 'https://github.com/checks/2' })],
    ])
    const outcome = await publish(gh)

    expect(outcome.blockers).toEqual([])
    expect(outcome.warnings).toHaveLength(1)
  })

  it('checks:write 403 falls back to a commit status; warn-only regression maps to success + truthful description', async () => {
    const gh = fakeGithub([
      [/GET .*\/comments\?/, () => []],
      [/POST .*\/issues\/7\/comments$/, () => ({ id: 1, html_url: 'https://github.com/c/1' })],
      [/POST .*\/check-runs$/, () => new Response('{"message":"forbidden"}', { status: 403 })],
      [/POST .*\/statuses\/abc123$/, (r) => {
        const body = JSON.parse(r.body!)
        expect(body.state).toBe('success')
        expect(body.description).toMatch(/^⚠ .*warn-only\)$/)
        expect(body.context).toBe('driftwatch')
        return { url: 'https://api.github.com/statuses/1' }
      }],
    ])
    const outcome = await publish(gh)

    expect(outcome.checkUrl).toBe('https://api.github.com/statuses/1')
    expect(outcome.warnings.join('\n')).toMatch(/commit status instead/)
  })

  it('neither surface available → two blockers, nothing thrown', async () => {
    // This is the run that finished green while delivering nothing at all.
    const gh = fakeGithub([
      [/GET .*\/comments\?/, () => new Response('x', { status: 403 })],
      [/POST .*\/check-runs$/, () => new Response('x', { status: 403 })],
      [/POST .*\/statuses\//, () => new Response('x', { status: 403 })],
    ])
    const outcome = await publish(gh)

    expect(outcome.commentUrl).toBeNull()
    expect(outcome.checkUrl).toBeNull()
    expect(outcome.blockers).toHaveLength(2)
    expect(outcome.warnings).toEqual([])
  })

  it('block_merge:true turns the regression check into a failure', async () => {
    const gh = fakeGithub([
      [/GET .*\/comments\?/, () => []],
      [/POST .*\/issues\/7\/comments$/, () => ({ id: 1 })],
      [/POST .*\/check-runs$/, (r) => {
        expect(JSON.parse(r.body!).conclusion).toBe('failure')
        return { id: 2, html_url: 'https://github.com/checks/2' }
      }],
    ])
    const outcome = await publish(gh, true)
    expect(outcome.checkUrl).toBe('https://github.com/checks/2')
  })

  it('token hygiene: header only — never in URLs, bodies, or warning text', async () => {
    const gh = fakeGithub([
      [/GET .*\/comments\?/, () => new Response('denied', { status: 403 })],
      [/POST .*\/check-runs$/, () => new Response('denied', { status: 403 })],
      [/POST .*\/statuses\//, () => new Response('denied', { status: 403 })],
    ])
    const outcome = await publish(gh)

    for (const request of gh.requests) {
      expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`)
      expect(request.url).not.toContain(TOKEN)
      expect(request.body ?? '').not.toContain(TOKEN)
    }
    expect(outcome.warnings.join('\n')).not.toContain(TOKEN)
  })
})

describe('rate limiting', () => {
  it('honors retry-after once, then succeeds', async () => {
    let calls = 0
    const gh = fakeGithub([
      [/GET .*\/rate-limited$/, () => {
        calls += 1
        return calls === 1
          ? new Response('slow down', { status: 429, headers: { 'retry-after': '2' } })
          : new Response('{"ok":true}', { status: 200 })
      }],
    ])
    const slept: number[] = []
    const c = createGithubClient({ token: TOKEN, fetchImpl: gh.fetchImpl, sleep: async (ms) => { slept.push(ms) } })

    const { json } = await c.request('GET', '/rate-limited')

    expect(json).toEqual({ ok: true })
    expect(slept).toEqual([2000])
  })

  it('gives up with a typed error when still limited after the retry', async () => {
    const gh = fakeGithub([
      [/GET .*\/rate-limited$/, () =>
        new Response('slow down', { status: 429, headers: { 'retry-after': '1' } })],
    ])
    const c = createGithubClient({ token: TOKEN, fetchImpl: gh.fetchImpl, sleep: async () => {} })

    const error = await c.request('GET', '/rate-limited').catch((e: GithubError) => e)

    expect((error as GithubError).kind).toBe('rate-limit')
    expect((error as GithubError).message).not.toContain(TOKEN)
  })
})
