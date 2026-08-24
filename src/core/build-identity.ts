import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Which build produced this output? (spec v50.)
 *
 * A stale `dist/` ran for five days while both of us believed a fix was live: `bin` points at
 * build output, nothing rebuilt it, and no output identified itself. The principle that came out
 * of it — **every output must identify the build that produced it** — is why this module exists
 * and why every report header calls it.
 *
 * It answers three separate questions, deliberately not conflated:
 *  - `version`: the package version, read from package.json — the SAME read DRIFTWATCH_VERSION
 *    uses for the protocol hash, so a report and a cache key can never disagree about it.
 *  - `entry`: 'src' when running the TypeScript directly (tsx, vitest), 'dist' when running the
 *    compiled binary. This is the distinction that hid the whole problem.
 *  - `builtAt`: when the running dist was compiled. Null from source — there is no build.
 */

const HERE = fileURLToPath(import.meta.url)

/** Package root: two levels up from src/core/ or dist/core/. */
const PACKAGE_ROOT = path.resolve(path.dirname(HERE), '..', '..')

export const DRIFTWATCH_VERSION: string = (
  JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { version: string }
).version

export interface BuildIdentity {
  readonly version: string
  /** 'src' = running TypeScript directly; 'dist' = running the compiled binary. */
  readonly entry: 'src' | 'dist'
  /** ISO timestamp of the running dist build; null when running from source. */
  readonly builtAt: string | null
}

let cached: BuildIdentity | null = null

export function buildIdentity(): BuildIdentity {
  if (cached) return cached
  const entry: 'src' | 'dist' = HERE.includes(`${path.sep}dist${path.sep}`) ? 'dist' : 'src'
  let builtAt: string | null = null
  if (entry === 'dist') {
    try {
      builtAt = statSync(HERE).mtime.toISOString()
    } catch {
      builtAt = null
    }
  }
  cached = { version: DRIFTWATCH_VERSION, entry, builtAt }
  return cached
}

/** One line, everywhere: the same stamp in the terminal, the eval, the comment and the JSON. */
export function buildStamp(identity: BuildIdentity = buildIdentity()): string {
  if (identity.entry === 'src') return `driftwatch v${identity.version} (from source)`
  const built = identity.builtAt ? ` built ${identity.builtAt.slice(0, 16).replace('T', ' ')}Z` : ''
  return `driftwatch v${identity.version} (dist${built})`
}

export interface Staleness {
  readonly stale: boolean
  /** Why, when stale — the newest source file and the build that predates it. */
  readonly detail: string | null
}

/**
 * Is the running `dist/` older than the source it was built from?
 *
 * Only answerable in a checkout: a published install ships `dist` alone (package.json `files`),
 * so an absent `src/` means "nothing to be stale against", not "stale". Running from source is
 * never stale by construction — the source IS what executes.
 */
export function checkStaleness(
  root: string = PACKAGE_ROOT,
  /** Injectable so the stale branch — the one that matters — is testable from source. */
  entry: 'src' | 'dist' = buildIdentity().entry,
): Staleness {
  if (entry === 'src') return { stale: false, detail: null }

  const src = newestFile(path.join(root, 'src'))
  const dist = newestFile(path.join(root, 'dist'))
  if (src === null || dist === null) return { stale: false, detail: null }
  if (src.mtimeMs <= dist.mtimeMs) return { stale: false, detail: null }

  const ageMinutes = Math.round((src.mtimeMs - dist.mtimeMs) / 60_000)
  return {
    stale: true,
    detail:
      `${path.relative(root, src.file)} changed ${ageMinutes} minute(s) after the running build ` +
      `(${path.relative(root, dist.file)}). The binary you are running does not contain that change.`,
  }
}

function newestFile(dir: string): { file: string; mtimeMs: number } | null {
  let newest: { file: string; mtimeMs: number } | null = null
  const walk = (current: string): void => {
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.isFile()) continue
      try {
        const { mtimeMs } = statSync(full)
        if (newest === null || mtimeMs > newest.mtimeMs) newest = { file: full, mtimeMs }
      } catch {
        /* vanished mid-walk */
      }
    }
  }
  walk(dir)
  return newest
}

/**
 * The refusal (spec v50): a warning is what we would have ignored — this cost five days of both
 * of us reasoning about code that was not running. It carries the exact command, and the escape
 * hatch is explicit so nobody has to guess one.
 */
export const STALE_BUILD_ENV = 'DRIFTWATCH_ALLOW_STALE'

export function staleBuildRefusal(detail: string): string {
  return [
    'refusing to run: the compiled build is older than the source.',
    '',
    `  ${detail}`,
    '',
    'Rebuild, then re-run:',
    '',
    '    npm run build',
    '',
    `To run the stale build anyway, set ${STALE_BUILD_ENV}=1.`,
  ].join('\n')
}
