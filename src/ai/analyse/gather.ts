import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { ResultJson } from '../../core/index.js'
import { collectDiff } from './collect-diff.js'
import { isLockfilePath, summarizeLockfile } from './lockfile-summary.js'
import type { ContextInput } from './assemble.js'

const exec = promisify(execFile)

/**
 * Gathers the diff data an analysis needs, from nothing but the result JSON — the contract is
 * the only interface between measurement and analysis, even in-process.
 */
export async function gatherDiffData(
  result: ResultJson,
): Promise<Omit<ContextInput, 'result'> | { unavailable: string }> {
  const { gitRoot, pathInRepo } = result.project
  if (!gitRoot || !pathInRepo || !result.base.available) {
    return { unavailable: 'no git baseline — there is no diff to analyse' }
  }

  const diff = await collectDiff(gitRoot, result.base.sha, pathInRepo)

  const lockfileSummaries = []
  for (const file of diff) {
    if (!isLockfilePath(file.path)) continue
    const current = await readFile(path.join(gitRoot, file.path), 'utf8').catch(() => null)
    const base = await gitShow(gitRoot, result.base.sha, file.path)
    lockfileSummaries.push(summarizeLockfile(file, base, current))
  }

  return { diff, lockfileSummaries }
}

async function gitShow(gitRoot: string, sha: string, repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await exec('git', ['-C', gitRoot, 'show', `${sha}:${repoPath}`], {
      maxBuffer: 256 * 1024 * 1024,
    })
    return stdout
  } catch {
    return null
  }
}
