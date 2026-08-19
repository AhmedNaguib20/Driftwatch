import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/**
 * Browser resolution for Lighthouse. Chrome comes from the environment (CI images ship it;
 * locally whatever is installed) — the exact version is part of the measurement protocol:
 * differing browser versions between sides are a §5.1 protocol mismatch and refuse deltas.
 * The signature is resolved once, BEFORE measurement, so the cache hash stays predictable.
 */

export interface BrowserInfo {
  readonly path: string
  /** e.g. "chrome/139.0.7258.67" — the protocol field and hash input. */
  readonly signature: string
}

let cached: Promise<BrowserInfo | null> | undefined

export function resolveBrowser(): Promise<BrowserInfo | null> {
  cached ??= resolve()
  return cached
}

/** Test hook: clears the memo so resolution can be exercised repeatedly. */
export function resetBrowserCache(): void {
  cached = undefined
}

async function resolve(): Promise<BrowserInfo | null> {
  // CHROME_PATH wins outright: chrome-launcher's install scan only covers PATH and desktop
  // entries, so a pinned Chrome in a toolcache directory is invisible to it — its env handling
  // merely re-weights entries the scan already found. Honoring the var directly is what makes
  // the CI pin (and our own install hint) actually work.
  let chromePath: string
  const pinned = process.env.CHROME_PATH?.trim()
  if (pinned) {
    chromePath = pinned
  } else {
    try {
      const launcher = await import('chrome-launcher')
      const installations = launcher.Launcher.getInstallations()
      if (installations.length === 0) return null
      chromePath = installations[0]!
    } catch {
      return null
    }
  }

  try {
    const { stdout } = await exec(chromePath, ['--version'])
    // "Google Chrome 139.0.7258.67" / "Chromium 139.0.x" → chrome/139.0.7258.67
    const version = /([0-9][0-9.]*)/.exec(stdout)?.[1] ?? 'unknown'
    return { path: chromePath, signature: `chrome/${version}` }
  } catch {
    // A pinned path that cannot even answer --version is a broken pin — better no browser (and
    // skipped lighthouse metrics with the hint) than measuring with a mystery binary.
    return pinned ? null : { path: chromePath, signature: 'chrome/unknown' }
  }
}

export const NO_BROWSER_HINT =
  'no Chrome/Chromium found — install Chrome or set CHROME_PATH; on CI, ubuntu-latest images ship it'
