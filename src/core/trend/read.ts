import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parseIndex } from './index-file.js'
import type { IndexFile } from './index-file.js'
import { PERF_DATA_BRANCH } from './store.js'

const exec = promisify(execFile)

/**
 * Read-only access to the perf-data index. Fetch updates only the remote-tracking ref — no
 * branch, no working directory, nothing of the user's is ever written.
 */
export async function readPerfDataIndex(
  gitRoot: string,
  options: { readonly fetch?: boolean } = {},
): Promise<{ index: IndexFile; ref: string } | { unavailable: string }> {
  if (options.fetch !== false) {
    await exec('git', ['-C', gitRoot, 'fetch', 'origin', `+${PERF_DATA_BRANCH}:refs/remotes/origin/${PERF_DATA_BRANCH}`]).catch(() => {})
  }

  for (const ref of [`refs/remotes/origin/${PERF_DATA_BRANCH}`, `refs/heads/${PERF_DATA_BRANCH}`]) {
    const exists = await exec('git', ['-C', gitRoot, 'rev-parse', '--verify', '--quiet', ref]).then(() => true, () => false)
    if (!exists) continue
    try {
      const { stdout } = await exec('git', ['-C', gitRoot, 'show', `${ref}:index.json`], { maxBuffer: 64 * 1024 * 1024 })
      const index = parseIndex(stdout)
      if (index === null) {
        return { unavailable: `the ${PERF_DATA_BRANCH} branch exists but its index.json is not driftwatch's` }
      }
      return { index, ref }
    } catch {
      return { unavailable: `the ${PERF_DATA_BRANCH} branch exists but has no readable index.json` }
    }
  }
  return {
    unavailable: `no ${PERF_DATA_BRANCH} branch found — trend data appears after pushes to the default branch run in CI (or see \`driftwatch record\`)`,
  }
}
