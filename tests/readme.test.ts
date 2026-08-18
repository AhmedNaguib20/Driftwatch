import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * README's "What leaves your machine" is standing documentation of the per-run contextManifest.
 * These tests keep it honest against the code and the golden context files — if the context
 * changes shape or the secret list changes, the README must change in the same commit.
 */

const root = path.resolve(import.meta.dirname, '..')

describe('README — What leaves your machine', () => {
  it('names every section the golden deep context actually contains', async () => {
    const readme = await readFile(path.join(root, 'README.md'), 'utf8')
    const deepGolden = await readFile(path.join(root, 'tests', 'golden', 'context-deep.md'), 'utf8')

    const sections = [...deepGolden.matchAll(/^## (.+)$/gm)].map((m) => m[1]!)
    expect(sections.length).toBeGreaterThan(4)

    const coverage: Record<string, RegExp> = {
      'Measured verdict': /measured verdict|metric values/i,
      Metrics: /metric values/i,
      'Raw samples': /raw samples/i,
      'Measurement protocols': /measurement protocols/i,
      'Detection evidence': /evidence trail/i,
      'Dependency changes': /package-level summary\*{0,2} of lockfile/i,
      Diffstat: /diffstat/i,
      Patches: /full patches/i,
    }
    for (const section of sections) {
      const key = Object.keys(coverage).find((k) => section.startsWith(k))
      expect(key, `golden context section "${section}" has no README coverage entry`).toBeDefined()
      expect(readme).toMatch(coverage[key!]!)
    }
  })

  it('lists the secret-withholding patterns that the code actually enforces', async () => {
    const readme = await readFile(path.join(root, 'README.md'), 'utf8')
    const secretsSource = await readFile(
      path.join(root, 'src', 'ai', 'analyse', 'secrets.ts'),
      'utf8',
    )

    // Every pattern family in secrets.ts must be named in the README.
    const families = [
      ['env', /`\.env` and `\.env\.\*`/],
      ['pem|key|p12|pfx|jks|keystore', /\*\.pem[\s\S]*\*\.key[\s\S]*\*\.p12[\s\S]*\*\.pfx[\s\S]*\*\.jks[\s\S]*\*\.keystore/],
      ['id_', /id_rsa\*/],
      ['netrc', /\.netrc/],
      ['npmrc', /\.npmrc/],
      ['credential', /credential/],
      ['secret', /secrets/],
    ] as const
    for (const [marker, readmePattern] of families) {
      expect(secretsSource).toMatch(new RegExp(marker))
      expect(readme, `README must document the "${marker}" secret family`).toMatch(readmePattern)
    }
  })

  it('documents the key env var and the no-ai escape hatch', async () => {
    const readme = await readFile(path.join(root, 'README.md'), 'utf8')
    expect(readme).toContain('DRIFTWATCH_API_KEY')
    expect(readme).toContain('--no-ai')
    expect(readme).toContain('DRIFTWATCH_NO_AI')
    expect(readme).toMatch(/never in `perf\.yml`/)
  })
})
