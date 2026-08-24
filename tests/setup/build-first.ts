import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/**
 * Several suites spawn the COMPILED binary (dist/cli/index.js). Running those against a dist that
 * predates src is the five-day failure in test form: green assertions about code that is not the
 * code under edit (spec v50). So the suite builds before it asserts anything — ~1.3s.
 */
export default async function setup(): Promise<void> {
  await exec('npm', ['run', 'build'], { cwd: path.resolve(import.meta.dirname, '..', '..') })
}
