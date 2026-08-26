import { GithubError } from './api-client.js'

/**
 * Configuration or transient — the distinction that decides whether an undelivered measurement
 * fails the run (spec §9f).
 *
 * `publishResult` was written never to fail the user's CI, and that was right for what it was
 * designed against: GitHub being down, a rate limit, a dropped connection. Those self-heal, and
 * failing someone's pull request over a blip is the behaviour that gets a tool uninstalled.
 *
 * Configuration is the opposite in every respect. A missing token or an unwritable repository
 * never fixes itself, and — the part that matters — it is INDISTINGUISHABLE FROM SUCCESS to
 * whoever reads the pull request: a green tick, no comment, a measured regression nobody sees.
 * M3 step 3 already drew this line for setup errors, which is why the base-commit preflight
 * exits 1; this applies the same rule to the other end of the run.
 *
 * The classification is written out rather than derived from the status number, because the
 * status alone does not carry the meaning: 403 on a write is a permission the workflow did not
 * grant, while 503 is GitHub having a bad minute.
 */

export type FailureClass = 'configuration' | 'transient'

export function classifyFailure(error: unknown): FailureClass {
  if (!(error instanceof GithubError)) {
    // A non-GitHub error here is a driftwatch bug (a renderer throwing, say). It will not
    // self-heal either, so it is surfaced rather than swallowed into a green run.
    return 'configuration'
  }

  switch (error.kind) {
    case 'network':
      // Could not reach GitHub at all — DNS, TLS, a dropped socket. The next run may be fine.
      return 'transient'
    case 'rate-limit':
      // Already retried once inside the client; the budget refills on its own.
      return 'transient'
    case 'auth':
      // 401 (token rejected) and 403 (permission not granted). Both are the workflow's own
      // configuration; neither changes without someone editing a file.
      return 'configuration'
    case 'http':
      // 5xx is GitHub's problem and passes. Everything else — 404 on a repository the token
      // cannot see, 422 on a request we built wrong — persists until something is changed.
      return typeof error.status === 'number' && error.status >= 500 ? 'transient' : 'configuration'
  }
}
