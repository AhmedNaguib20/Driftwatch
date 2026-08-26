import { execFile } from 'node:child_process'
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * What the published tarball contains — asked of `npm pack`, not of `package.json`.
 *
 * Reading the `files` whitelist would only prove what someone wrote down. npm's rules involve
 * always-included names, `.npmignore`, and negated patterns like `!dist/**\/*.map`, so the
 * question is answered by the tool that does the packing.
 *
 * **It packs a COPY, with `scripts` stripped.** `npm pack` runs the `prepare` script, and this
 * package's `prepare` is `npm run build` — `--ignore-scripts` does not stop it (verified against
 * npm 10.8.2: dist/ was rebuilt anyway). Run in place, this test would fire a second `tsc` into
 * the same `dist/` that the suite's own build and every spawned CLI are using, and it did: a
 * `npm run check` failed here with two builds colliding. A test whose SIDE EFFECTS race the
 * harness is flaky by construction, exactly like one that races the clock.
 *
 * The copy holds every path the whitelist can match, so the whitelist is exercised for real.
 */

const exec = promisify(execFile)
const repoRoot = path.resolve(import.meta.dirname, '..')
const temps: string[] = []

afterAll(async () => {
  await Promise.all(temps.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

/** Everything `files` could name, plus the names npm includes on its own. */
const CANDIDATES = ['dist', 'README.md', 'LICENSE', 'action.yml', '.npmignore', '.gitignore']

let cached: string[] | undefined

async function packedPaths(): Promise<string[]> {
  if (cached) return cached
  const dir = await mkdtemp(path.join(tmpdir(), 'driftwatch-pack-'))
  temps.push(dir)

  const manifest = JSON.parse(
    (await exec('node', ['-p', 'JSON.stringify(require("./package.json"))'], { cwd: repoRoot }))
      .stdout,
  ) as Record<string, unknown>
  delete manifest.scripts
  await writeFile(path.join(dir, 'package.json'), JSON.stringify(manifest, null, 2), 'utf8')

  for (const name of CANDIDATES) {
    const from = path.join(repoRoot, name)
    if (existsSync(from)) await cp(from, path.join(dir, name), { recursive: true })
  }

  const { stdout } = await exec('npm', ['pack', '--dry-run', '--json'], {
    cwd: dir,
    maxBuffer: 32 * 1024 * 1024,
  })
  const tarball = (JSON.parse(stdout) as { files: { path: string }[] }[]).at(0)
  if (!tarball) throw new Error(`npm pack produced no tarball entry: ${stdout}`)
  cached = tarball.files.map((f) => f.path)
  return cached
}

describe('the published package', () => {
  it('does not ship action.yml', async () => {
    /**
     * `action.yml` is a GitHub Action manifest and GitHub reads it from the REPOSITORY at the
     * referenced tag, never from npm. A copy in the tarball would put a second, always-wrong
     * version of it in users' node_modules: on main it carries a version PLACEHOLDER rather than
     * a version, because the release workflow substitutes the real one when it cuts the tag.
     *
     * That is the class two broken releases came from — a second copy of something, free to
     * disagree with the one that runs. It shipped in 0.6.0–0.6.2 harmlessly, being unused.
     */
    expect(await packedPaths()).not.toContain('action.yml')
  }, 60_000)

  it('ships the CLI, both bins and the licence, and no build metadata', async () => {
    const paths = await packedPaths()
    expect(paths).toContain('dist/cli/index.js')
    expect(paths).toContain('dist/adapters/github/action-bin.js')
    expect(paths).toContain('LICENSE')
    expect(paths).toContain('README.md')
    // `!dist/**/*.map` — source maps point at paths that do not exist on the user's machine.
    expect(paths.filter((p) => p.endsWith('.map'))).toEqual([])
  }, 60_000)

  it('declares every bin against a file the tarball actually carries', async () => {
    const { bin } = JSON.parse(
      (await exec('node', ['-p', 'JSON.stringify(require("./package.json"))'], { cwd: repoRoot }))
        .stdout,
    ) as { bin: Record<string, string> }
    const paths = await packedPaths()
    // A bin naming a file the tarball omits is a package that installs and cannot run.
    for (const [name, target] of Object.entries(bin)) {
      expect(paths, name).toContain(target.replace(/^\.\//, ''))
    }
    expect(Object.keys(bin)).toContain('driftwatch-action')
  }, 60_000)
})
