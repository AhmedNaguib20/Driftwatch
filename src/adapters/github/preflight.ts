import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/**
 * Verifies the base commit exists locally BEFORE measuring. actions/checkout defaults to
 * fetch-depth: 1, which makes the base unreachable — this will be the #1 setup error, so the
 * message must solve it, not describe it.
 */
export async function preflightBase(
  cwd: string,
  baseSha: string,
): Promise<{ ok: true } | { ok: false; fix: string }> {
  try {
    await exec('git', ['-C', cwd, 'cat-file', '-e', `${baseSha}^{commit}`])
    return { ok: true }
  } catch {
    return {
      ok: false,
      fix: [
        `The PR base commit ${baseSha.slice(0, 12)} is not in this checkout.`,
        'Fix: give actions/checkout the full history in your workflow —',
        '',
        '      - uses: actions/checkout@v4',
        '        with:',
        '          fetch-depth: 0',
        '',
        'driftwatch checks the base commit out into a temporary worktree; a shallow clone cannot.',
      ].join('\n'),
    }
  }
}
