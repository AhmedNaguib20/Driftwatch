import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/**
 * Applies the AI's diff inside a fresh workspace copy. `git apply --recount --check` decides
 * first: a diff that does not apply cleanly is verdict "not-applicable" with git's own words —
 * never patched around, never fuzzy-matched (a fix we had to bend is not the fix that was
 * suggested). --recount is the one tolerance, and it is bookkeeping-only: models routinely
 * miscount hunk-header line totals (observed live: a header claiming 7 old lines over a 10-line
 * body of byte-exact context), and recount recomputes the numbers from the body while still
 * requiring every content line to match exactly. Same principle as the JSON fence-stripping:
 * tolerance in bookkeeping, never in content.
 *
 * Diff paths are repo-relative (a/fixtures/app/… — enforceFixRules guaranteed they stay inside
 * the shown context), so apply runs at the workspace's TREE root, the copy's repo-root mirror.
 */
export async function applyDiff(
  workspaceDir: string,
  pathInRepo: string,
  diff: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  // workspaceDir = <tmp>/tree/<pathInRepo>; the tree root is where repo-relative paths resolve.
  const up = pathInRepo === '.' ? 0 : pathInRepo.split(path.sep).length
  let treeRoot = workspaceDir
  for (let i = 0; i < up; i += 1) treeRoot = path.dirname(treeRoot)

  const patchDir = await mkdtemp(path.join(tmpdir(), 'driftwatch-patch-'))
  const patchFile = path.join(patchDir, 'fix.diff')
  try {
    await writeFile(patchFile, diff.endsWith('\n') ? diff : diff + '\n', 'utf8')

    try {
      await exec('git', ['-C', treeRoot, 'apply', '--recount', '--check', patchFile])
    } catch (error) {
      const e = error as { stderr?: string; message?: string }
      return {
        ok: false,
        reason: `the suggested diff does not apply cleanly: ${(e.stderr || e.message || 'unknown').trim().split('\n').slice(0, 4).join('\n')}`,
      }
    }

    await exec('git', ['-C', treeRoot, 'apply', '--recount', patchFile])
    return { ok: true }
  } finally {
    await rm(patchDir, { recursive: true, force: true })
  }
}
