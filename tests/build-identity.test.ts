import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  DRIFTWATCH_VERSION,
  STALE_BUILD_ENV,
  buildIdentity,
  buildStamp,
  checkStaleness,
  staleBuildRefusal,
} from '../src/core/index.js'

const temps: string[] = []
afterEach(async () => {
  await Promise.all(temps.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

/**
 * Every output identifies its build (spec v50). These are the guards for the failure that cost
 * five days: a `dist/` built before the source it claims to contain, running silently.
 */
describe('build identity', () => {
  it('names the version from package.json — the same read the protocol hash uses', () => {
    expect(buildIdentity().version).toBe(DRIFTWATCH_VERSION)
    expect(DRIFTWATCH_VERSION).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('knows it is running from source under the test runner, and says so', () => {
    // vitest executes the TypeScript directly — the distinction that hid the stale build.
    expect(buildIdentity().entry).toBe('src')
    expect(buildIdentity().builtAt).toBeNull()
    expect(buildStamp()).toBe(`driftwatch v${DRIFTWATCH_VERSION} (from source)`)
  })

  it('stamps a dist build with when it was built', () => {
    expect(
      buildStamp({ version: '1.2.3', entry: 'dist', builtAt: '2026-08-24T09:30:00.000Z' }),
    ).toBe('driftwatch v1.2.3 (dist built 2026-08-24 09:30Z)')
  })
})

describe('staleness — refused, not warned', () => {
  async function tree(options: { srcMtime: number; distMtime: number }): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'driftwatch-stale-'))
    temps.push(dir)
    for (const [sub, mtime] of [['src', options.srcMtime], ['dist', options.distMtime]] as const) {
      await mkdir(path.join(dir, sub, 'core'), { recursive: true })
      const file = path.join(dir, sub, 'core', 'thing.js')
      await writeFile(file, 'x', 'utf8')
      await utimes(file, new Date(mtime), new Date(mtime))
    }
    return dir
  }

  it('running from source is never stale — the source IS what executes', async () => {
    const dir = await tree({ srcMtime: Date.now(), distMtime: Date.now() - 86_400_000 })
    expect(checkStaleness(dir, 'src').stale).toBe(false)
  })

  it('DETECTS the real failure: a dist built before the source it claims to contain', async () => {
    // The exact shape of the five-day bug — dist from Aug 19, source edited Aug 24.
    const dir = await tree({ srcMtime: Date.UTC(2026, 7, 24, 9, 0), distMtime: Date.UTC(2026, 7, 19, 15, 46) })
    const staleness = checkStaleness(dir, 'dist')

    expect(staleness.stale).toBe(true)
    expect(staleness.detail).toMatch(/src\/core\/thing\.js changed \d+ minute\(s\) after the running build/)
    expect(staleness.detail).toMatch(/does not contain that change/)
  })

  it('a dist newer than its source is fine', async () => {
    const dir = await tree({ srcMtime: Date.UTC(2026, 7, 19), distMtime: Date.UTC(2026, 7, 24) })
    expect(checkStaleness(dir, 'dist').stale).toBe(false)
  })

  it('the refusal names the file, the lag, the command, and the escape hatch', () => {
    const message = staleBuildRefusal('src/core/thing.ts changed 42 minute(s) after the running build (dist/core/thing.js).')
    expect(message).toMatch(/refusing to run/)
    expect(message).toMatch(/42 minute\(s\)/)
    expect(message).toMatch(/npm run build/)
    expect(message).toMatch(new RegExp(`${STALE_BUILD_ENV}=1`))
    // It must not merely warn — the word matters, because a warning is what we scrolled past.
    expect(message).not.toMatch(/^warning/i)
  })

  it('a published install (dist only, no src) is not stale — there is nothing to be stale against', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'driftwatch-published-'))
    temps.push(dir)
    await mkdir(path.join(dir, 'dist'), { recursive: true })
    await writeFile(path.join(dir, 'dist', 'index.js'), 'x', 'utf8')
    expect(checkStaleness(dir).stale).toBe(false)
  })
})
