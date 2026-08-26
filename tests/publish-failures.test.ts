import { describe, expect, it } from 'vitest'

import { GithubError } from '../src/adapters/github/api-client.js'
import { classifyFailure } from '../src/adapters/github/failure-class.js'

/**
 * Configuration or transient — the rule that decides whether a measured verdict nobody received
 * leaves a green tick behind it (spec §9f).
 *
 * The distinction is asserted as a pure function over every kind the client can raise, because
 * getting it wrong is expensive in both directions: too strict and a GitHub blip fails someone's
 * pull request, too loose and a read-only repository looks exactly like "nothing regressed".
 */

describe('failure classification', () => {
  const cases: readonly [string, unknown, 'configuration' | 'transient'][] = [
    // Configuration — never self-heals, always a workflow edit away from working.
    ['401, token rejected', new GithubError('auth', 'rejected', 401), 'configuration'],
    ['403 on a write, permission not granted', new GithubError('auth', 'forbidden', 403), 'configuration'],
    ['404, repository the token cannot see', new GithubError('http', 'not found', 404), 'configuration'],
    ['422, a request we built wrong', new GithubError('http', 'unprocessable', 422), 'configuration'],
    ['a non-GitHub error — a driftwatch bug', new TypeError('boom'), 'configuration'],

    // Transient — the next run may well succeed, so warn and stay green.
    ['500', new GithubError('http', 'server error', 500), 'transient'],
    ['503, GitHub having a bad minute', new GithubError('http', 'unavailable', 503), 'transient'],
    ['rate limited after one retry', new GithubError('rate-limit', 'limited', 403), 'transient'],
    ['network, could not reach GitHub at all', new GithubError('network', 'ECONNRESET'), 'transient'],
  ]

  for (const [name, error, expected] of cases) {
    it(`${name} → ${expected}`, () => {
      expect(classifyFailure(error)).toBe(expected)
    })
  }

  it('separates 403 from 503 — the pair the status code alone cannot tell apart', () => {
    // Both are "GitHub said no". Only one of them is the workflow's own doing, which is why the
    // classification is written out rather than derived from the number.
    expect(classifyFailure(new GithubError('auth', 'forbidden', 403))).toBe('configuration')
    expect(classifyFailure(new GithubError('http', 'unavailable', 503))).toBe('transient')
  })

  it('a rate limit that arrives AS a 403 is still transient', () => {
    // GitHub returns 403 with x-ratelimit-remaining: 0. The client already distinguishes it into
    // its own kind; if that ever regressed, a rate-limited run would start failing pull requests.
    expect(classifyFailure(new GithubError('rate-limit', 'limited', 403))).toBe('transient')
  })
})
