import { execFile } from 'node:child_process'
import { rm, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const exec = promisify(execFile)
const repoRoot = path.resolve(import.meta.dirname, '..')

/**
 * Hard rule 1 is only real if the lint rule actually fails the build. These tests write a throwaway
 * file into src/core, lint it, and assert the outcome — rather than trusting the config by eye.
 */

async function lint(file: string): Promise<{ code: number; output: string }> {
  try {
    const { stdout, stderr } = await exec(
      'npx',
      ['eslint', '--no-ignore', '--format', 'json', file],
      { cwd: repoRoot },
    )
    return { code: 0, output: stdout + stderr }
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string }
    return { code: e.code ?? 1, output: (e.stdout ?? '') + (e.stderr ?? '') }
  }
}

const scratch: string[] = []

async function writeCoreFile(name: string, contents: string): Promise<string> {
  const dir = path.join(repoRoot, 'src', 'core', '__lint_scratch__')
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, name)
  await writeFile(file, contents, 'utf8')
  scratch.push(dir)
  return file
}

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('src/core must not import from src/adapters', () => {
  it('fails lint on a relative import into the adapters tree', async () => {
    const file = await writeCoreFile(
      'violation.ts',
      `import { render } from '../../adapters/github/comment.js'\nexport const x = render\n`,
    )
    const { code, output } = await lint(file)
    expect(code).not.toBe(0)
    expect(output).toContain('driftwatch/no-core-to-adapters')
  })

  it('fails lint on a dynamic import into the adapters tree', async () => {
    const file = await writeCoreFile(
      'dynamic.ts',
      `export const load = () => import('../../adapters/github/index.js')\n`,
    )
    const { code, output } = await lint(file)
    expect(code).not.toBe(0)
    expect(output).toContain('driftwatch/no-core-to-adapters')
  })

  it('fails lint on an aliased adapters specifier', async () => {
    const file = await writeCoreFile(
      'aliased.ts',
      `import x from 'driftwatch/adapters/github'\nexport default x\n`,
    )
    const { code, output } = await lint(file)
    expect(code).not.toBe(0)
    expect(output).toContain('driftwatch/no-core-to-adapters')
  })

  it('allows imports that stay inside core', async () => {
    const file = await writeCoreFile(
      'allowed.ts',
      `import path from 'node:path'\nexport const join = path.join\n`,
    )
    const { code } = await lint(file)
    expect(code).toBe(0)
  })

  it('does not constrain files outside core', async () => {
    const dir = path.join(repoRoot, 'src', 'adapters', '__lint_scratch__')
    await mkdir(dir, { recursive: true })
    scratch.push(dir)
    const file = path.join(dir, 'ok.ts')
    await writeFile(
      file,
      `export const load = () => import('../github/index.js')\n`,
      'utf8',
    )
    const { output } = await lint(file)
    expect(output).not.toContain('no-core-to-adapters')
  })
})
