import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * The enclosing git repository, if there is one.
 *
 * Read-only by construction: `rev-parse` inspects, it never mutates. Hard rule 2 means nothing in
 * detection may alter the user's checkout, so this is the only git operation detection performs.
 */
export async function findGitRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['rev-parse', '--show-toplevel'], { cwd })
    const root = stdout.trim()
    return root.length > 0 ? root : null
  } catch {
    return null
  }
}
