import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Committed fixtures must not carry a local machine's paths.
 *
 * The eval cases are CAPTURED OUTPUT — real result JSON from real runs — so they pick up whatever
 * absolute paths the machine that produced them had, and they get regenerated. The pre-public
 * audit found four of them carrying `/Users/<name>/…`; this is the guard that stops the next
 * regeneration from putting it back.
 *
 * A username is not a secret, but it is gratuitous: nothing about the eval needs to know whose
 * laptop ran it.
 */

const root = path.resolve(import.meta.dirname, '..')
const HOME_PATH = /\/(Users|home)\/(?!runner\b)[A-Za-z0-9._-]+\//

async function jsonFilesUnder(dir: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...(await jsonFilesUnder(full)))
    else if (entry.name.endsWith('.json') || entry.name.endsWith('.md')) found.push(full)
  }
  return found
}

describe('committed fixtures carry no local paths', () => {
  it('no eval case names a home directory', async () => {
    for (const file of await jsonFilesUnder(path.join(root, 'eval'))) {
      const contents = await readFile(file, 'utf8')
      const hit = HOME_PATH.exec(contents)
      expect(hit?.[0], `${path.relative(root, file)} contains "${hit?.[0]}" — regenerate it somewhere neutral, or scrub the path`).toBeUndefined()
    }
  })

  it('no golden file names a home directory either', async () => {
    for (const file of await jsonFilesUnder(path.join(root, 'tests', 'golden'))) {
      const contents = await readFile(file, 'utf8')
      expect(HOME_PATH.exec(contents)?.[0], path.relative(root, file)).toBeUndefined()
    }
  })
})
