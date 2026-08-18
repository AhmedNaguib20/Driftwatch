import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

import {
  assembleDeepContext,
  assembleTriageContext,
  collectDiff,
  isSecretPath,
  summarizeLockfile,
} from '../src/ai/analyse/index.js'
import type { ContextInput, DiffFile } from '../src/ai/analyse/index.js'
import type { ResultJson } from '../src/core/index.js'

const exec = promisify(execFile)
const temps: string[] = []

afterEach(async () => {
  await Promise.all(temps.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

async function writeFileIn(dir: string, rel: string, contents: string | Buffer): Promise<void> {
  const target = path.join(dir, rel)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, contents)
}

async function git(dir: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-C', dir, ...args])
  return stdout.trim()
}

/** The result fixture reuses the golden result — the analysis input IS the contract output. */
async function goldenResult(): Promise<ResultJson> {
  const raw = await readFile(path.join(import.meta.dirname, 'golden', 'result-v1.json'), 'utf8')
  return JSON.parse(raw.replaceAll('<driftwatch-version>', '0.2.0')) as ResultJson
}

function file(overrides: Partial<DiffFile> & { path: string }): DiffFile {
  return {
    insertions: 10,
    deletions: 2,
    binary: false,
    untracked: false,
    patch: `diff --git a/${overrides.path} b/${overrides.path}\n+added line\n-removed line\n`,
    ...overrides,
  }
}

describe('collectDiff on a real repo', () => {
  it('sees tracked edits, untracked files, and detects binary by content', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'driftwatch-diff-'))
    temps.push(dir)
    await exec('git', ['init', '-q', '-b', 'main'], { cwd: dir })
    await git(dir, 'config', 'user.email', 't@t')
    await git(dir, 'config', 'user.name', 't')
    await writeFileIn(dir, 'src/app.ts', 'export const a = 1\n')
    await writeFileIn(dir, '.gitignore', 'node_modules/\nignored.txt\n')
    await git(dir, 'add', '-A')
    await git(dir, 'commit', '-q', '-m', 'base')
    const sha = await git(dir, 'rev-parse', 'HEAD')

    await writeFileIn(dir, 'src/app.ts', 'export const a = 2\nexport const b = 3\n')
    await writeFileIn(dir, 'src/new-module.ts', 'export const fresh = true\n')
    await writeFileIn(dir, 'ignored.txt', 'never seen')
    // Binary content with a text extension — content decides, not the name.
    await writeFileIn(dir, 'asset.txt', Buffer.from([0, 1, 2, 3, 255, 254, 0, 66]))

    const diff = await collectDiff(dir, sha, '.')
    const byPath = new Map(diff.map((f) => [f.path, f]))

    expect(byPath.get('src/app.ts')).toMatchObject({ untracked: false, binary: false })
    expect(byPath.get('src/app.ts')!.patch).toContain('+export const b = 3')
    expect(byPath.get('src/new-module.ts')).toMatchObject({ untracked: true, binary: false })
    expect(byPath.get('src/new-module.ts')!.patch).toContain('+export const fresh = true')
    expect(byPath.get('asset.txt')).toMatchObject({ binary: true, patch: '' })
    expect(byPath.has('ignored.txt')).toBe(false)
  })
})

describe('secret patterns', () => {
  it('matches by basename wherever the file lives', () => {
    for (const p of [
      '.env',
      '.env.production',
      'config/.env.local',
      'certs/server.pem',
      'deploy/signing.key',
      'ops/credentials.json',
      '.npmrc',
      'secrets.yaml',
    ]) {
      expect(isSecretPath(p), p).toBe(true)
    }
    for (const p of ['src/env.ts', 'lib/keyboard.ts', 'monkey.test.ts', 'docs/secretary.md']) {
      expect(isSecretPath(p), p).toBe(false)
    }
  })
})

describe('lockfile summary', () => {
  const lockJson = (packages: Record<string, string>) =>
    JSON.stringify({
      lockfileVersion: 3,
      packages: Object.fromEntries(
        Object.entries(packages).map(([name, version]) => [`node_modules/${name}`, { version }]),
      ),
    })

  it('reports added, removed, and bumped packages with versions', () => {
    const summary = summarizeLockfile(
      file({ path: 'package-lock.json' }),
      lockJson({ react: '18.0.0', lodash: '4.17.21' }),
      lockJson({ react: '19.0.0', zod: '3.24.1' }),
    )

    expect(summary.added).toEqual([{ name: 'zod', from: null, to: '3.24.1' }])
    expect(summary.removed).toEqual([{ name: 'lodash', from: '4.17.21', to: null }])
    expect(summary.bumped).toEqual([{ name: 'react', from: '18.0.0', to: '19.0.0' }])
    expect(summary.unparsed).toBeNull()
  })

  it('degrades honestly for formats without a summarizer', () => {
    const summary = summarizeLockfile(file({ path: 'pnpm-lock.yaml' }), 'a', 'b')
    expect(summary.unparsed).toMatch(/no summarizer/)
  })
})

describe('context assembly', () => {
  async function input(): Promise<ContextInput> {
    return {
      result: await goldenResult(),
      diff: [
        file({ path: 'app/blog/page.tsx', insertions: 40, deletions: 5, patch: 'diff --git a/app/blog/page.tsx b/app/blog/page.tsx\n+import Chart\n' }),
        file({ path: 'lib/posts.ts', insertions: 25, deletions: 1, patch: 'diff --git a/lib/posts.ts b/lib/posts.ts\n+const archive = []\n' }),
        file({ path: '.env.local', insertions: 2, deletions: 0, patch: 'diff SECRET-VALUE-INSIDE\n+API_TOKEN=hunter2\n' }),
        file({ path: 'logo.png', insertions: 0, deletions: 0, binary: true, patch: '' }),
        file({ path: 'package-lock.json', insertions: 900, deletions: 100, patch: 'diff huge lockfile noise\n' }),
      ],
      lockfileSummaries: [
        {
          lockfile: 'package-lock.json',
          added: [{ name: 'lodash', from: null, to: '4.17.21' }],
          removed: [],
          bumped: [],
          unparsed: null,
        },
      ],
    }
  }

  it('triage context: diffstat + numbers, small patches inlined, secrets still never', async () => {
    const { text, manifest } = assembleTriageContext(await input())

    expect(text).toContain('## Diffstat')
    expect(text).toContain('app/blog/page.tsx: +40/-5')
    expect(text).toContain('[11143, 8629, 8724]') // sampleValues visible
    // v2: files under 50 changed lines get their patch inlined at triage (§7.1c).
    expect(text).toContain('import Chart')
    expect(text).not.toContain('hunter2') // secrets stay withheld even when tiny
    expect(text).not.toContain('huge lockfile noise')
    const byPath = Object.fromEntries(manifest.files.map((f) => [f.path, f.disposition]))
    expect(byPath['app/blog/page.tsx']).toBe('full')
    expect(byPath['.env.local']).toBe('withheld')
    expect(manifest.estimatedTokens).toBeLessThan(manifest.budgetTokens)
  })

  it('deep context includes suspect patches and never secret/lockfile/binary content', async () => {
    const { text, manifest } = assembleDeepContext(await input(), ['lib/posts.ts'])

    expect(text).toContain('+const archive = []')
    expect(text).toContain('+import Chart')
    // The secret's diffstat line exists; its content does not.
    expect(text).toContain('.env.local: +2/-0')
    expect(text).not.toContain('hunter2')
    expect(text).not.toContain('SECRET-VALUE-INSIDE')
    expect(text).not.toContain('huge lockfile noise')
    expect(text).toContain('added lodash @ 4.17.21')

    const byPath = Object.fromEntries(manifest.files.map((f) => [f.path, f.disposition]))
    expect(byPath['.env.local']).toBe('withheld')
    expect(byPath['logo.png']).toBe('binary')
    expect(byPath['package-lock.json']).toBe('diffstat-only')
    expect(byPath['lib/posts.ts']).toBe('full')
  })

  it('suspects win the budget over larger non-suspects', async () => {
    const big = 'x'.repeat(90_000) // ~22.5K tokens — nearly the whole deep budget
    const ctx: ContextInput = {
      result: await goldenResult(),
      diff: [
        file({ path: 'huge-refactor.ts', insertions: 5000, deletions: 4000, patch: `diff huge\n${big}` }),
        file({ path: 'suspect.ts', insertions: 3, deletions: 1, patch: 'diff --git suspect\n+the one line that matters\n' }),
      ],
      lockfileSummaries: [],
    }

    const { text, manifest } = assembleDeepContext(ctx, ['suspect.ts'])

    expect(text).toContain('+the one line that matters')
    const huge = manifest.files.find((f) => f.path === 'huge-refactor.ts')!
    expect(['truncated', 'diffstat-only']).toContain(huge.disposition)
    expect(manifest.truncated).toBe(true)
  })

  it('is deterministic: same inputs, byte-identical output', async () => {
    const a = assembleDeepContext(await input(), ['lib/posts.ts'])
    const b = assembleDeepContext(await input(), ['lib/posts.ts'])
    expect(a.text).toBe(b.text)
    expect(JSON.stringify(a.manifest)).toBe(JSON.stringify(b.manifest))
  })

  it('never contains absolute paths or the createdAt timestamp', async () => {
    const { text } = assembleDeepContext(await input(), [])
    expect(text).not.toContain('/repo/app')
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/)
  })
})

describe('golden contexts', () => {
  const TRIAGE_GOLDEN = path.join(import.meta.dirname, 'golden', 'context-triage.md')
  const DEEP_GOLDEN = path.join(import.meta.dirname, 'golden', 'context-deep.md')

  async function stableInput(): Promise<ContextInput> {
    return {
      result: await goldenResult(),
      diff: [
        file({
          path: 'lib/posts.ts',
          insertions: 25,
          deletions: 1,
          patch: 'diff --git a/lib/posts.ts b/lib/posts.ts\n@@ -1,3 +1,10 @@\n+const archive = Array.from({ length: 300 })\n',
        }),
        file({
          path: 'app/blog/page.tsx',
          insertions: 12,
          deletions: 2,
          untracked: true,
          patch: 'diff --git a/app/blog/page.tsx b/app/blog/page.tsx\n@@ -0,0 +1,12 @@\n+import Chart from "../dashboard/chart"\n',
        }),
        file({ path: '.env', insertions: 1, deletions: 0, patch: '+TOKEN=x\n' }),
        file({ path: 'package-lock.json', insertions: 40, deletions: 3, patch: 'noise\n' }),
      ],
      lockfileSummaries: [
        {
          lockfile: 'package-lock.json',
          added: [{ name: 'lodash', from: null, to: '4.17.21' }],
          removed: [],
          bumped: [{ name: 'next', from: '15.1.2', to: '15.1.3' }],
          unparsed: null,
        },
      ],
    }
  }

  it('triage context matches its golden file', async () => {
    const { text, manifest } = assembleTriageContext(await stableInput())
    const rendered = `${text}\n\n<!-- manifest: ${JSON.stringify(manifest)} -->\n`
    if (process.env.UPDATE_GOLDEN === '1') await writeFile(TRIAGE_GOLDEN, rendered, 'utf8')
    expect(rendered).toBe(await readFile(TRIAGE_GOLDEN, 'utf8'))
  })

  it('deep context matches its golden file', async () => {
    const { text, manifest } = assembleDeepContext(await stableInput(), ['lib/posts.ts'])
    const rendered = `${text}\n\n<!-- manifest: ${JSON.stringify(manifest)} -->\n`
    if (process.env.UPDATE_GOLDEN === '1') await writeFile(DEEP_GOLDEN, rendered, 'utf8')
    expect(rendered).toBe(await readFile(DEEP_GOLDEN, 'utf8'))
  })
})
