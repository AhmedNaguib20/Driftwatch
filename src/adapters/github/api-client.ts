/**
 * Thin GitHub REST client — same discipline as the AI provider client: fetch-based, injectable
 * for offline tests, token in the Authorization header and NOWHERE else (never logged, never in
 * error messages, never in a body). Typed failures; rate limits honored with one retry.
 */

export type GithubErrorKind = 'auth' | 'http' | 'network' | 'rate-limit'

export class GithubError extends Error {
  constructor(
    readonly kind: GithubErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'GithubError'
  }
}

const API_VERSION = '2022-11-28'
/** A Retry-After beyond this is a long outage, not a blip — fail instead of hanging a CI job. */
const MAX_RETRY_AFTER_SECONDS = 30

export interface GithubClientOptions {
  readonly token: string
  readonly baseUrl?: string
  readonly fetchImpl?: typeof fetch
  /** Injectable so rate-limit tests do not actually sleep. */
  readonly sleep?: (ms: number) => Promise<void>
}

export interface GithubResponse {
  readonly status: number
  readonly json: unknown
}

export interface GithubClient {
  request(method: string, path: string, body?: unknown): Promise<GithubResponse>
}

export function createGithubClient(options: GithubClientOptions): GithubClient {
  const doFetch = options.fetchImpl ?? fetch
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const baseUrl = options.baseUrl ?? 'https://api.github.com'

  async function once(method: string, path: string, body?: unknown): Promise<Response> {
    try {
      return await doFetch(`${baseUrl}${path}`, {
        method,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${options.token}`,
          'x-github-api-version': API_VERSION,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
    } catch (error) {
      throw new GithubError('network', `could not reach GitHub: ${(error as Error).message}`)
    }
  }

  return {
    async request(method: string, path: string, body?: unknown): Promise<GithubResponse> {
      let response = await once(method, path, body)

      // One retry on rate limiting, honoring Retry-After when it is short enough to be a blip.
      if (response.status === 429 || isRateLimited(response)) {
        const waitSeconds = Number(response.headers.get('retry-after') ?? '1')
        if (Number.isFinite(waitSeconds) && waitSeconds <= MAX_RETRY_AFTER_SECONDS) {
          await sleep(Math.max(waitSeconds, 1) * 1000)
          response = await once(method, path, body)
        }
      }

      if (response.status === 401) {
        throw new GithubError('auth', 'GitHub rejected the token (HTTP 401)', 401)
      }
      if (response.status === 429 || isRateLimited(response)) {
        throw new GithubError('rate-limit', 'GitHub rate limit exceeded (after one retry)', response.status)
      }
      if (!response.ok) {
        const snippet = (await response.text().catch(() => '')).slice(0, 300)
        throw new GithubError(
          response.status === 403 ? 'auth' : 'http',
          `GitHub returned HTTP ${response.status} for ${method} ${path}${snippet ? `: ${snippet}` : ''}`,
          response.status,
        )
      }

      const json = response.status === 204 ? null : await response.json().catch(() => null)
      return { status: response.status, json }
    },
  }
}

function isRateLimited(response: Response): boolean {
  return response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0'
}
