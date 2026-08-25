import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { capabilitiesOf } from '../src/core/index.js'
import { DISCLOSURE_END, DISCLOSURE_START, renderDisclosure } from '../src/ai/disclosure.js'
import { CONTEXT_SECTIONS, TRIAGE_PATCH_HEADING } from '../src/ai/analyse/sections.js'
import { SECRET_BASENAME_PATTERNS } from '../src/ai/analyse/secrets.js'

/**
 * README's "What leaves your machine" is standing documentation of the per-run contextManifest.
 * These tests keep it honest against the code and the golden context files — if the context
 * changes shape or the secret list changes, the README must change in the same commit.
 */

const root = path.resolve(import.meta.dirname, '..')

describe('README — What leaves your machine', () => {
  it('is byte-identical to what the code generates', async () => {
    const readmePath = path.join(root, 'README.md')
    let readme = await readFile(readmePath, 'utf8')
    const generated = renderDisclosure()

    if (process.env.UPDATE_README === '1') {
      const from = readme.indexOf(DISCLOSURE_START)
      const to = readme.indexOf(DISCLOSURE_END) + DISCLOSURE_END.length
      readme = readme.slice(0, from) + generated + readme.slice(to)
      await writeFile(readmePath, readme, 'utf8')
    }

    // The disclosure is the section a privacy-conscious reader judges the product by, so it is
    // generated from the code that does the sending rather than maintained by hand. Prose that
    // can drift from behaviour is a claim, not a disclosure (spec §9e step E).
    expect(readme).toContain(generated)
  })

  it('documents every context section the assembler actually emits, and no others', async () => {
    const documented = new Set(CONTEXT_SECTIONS.map((s) => s.heading))
    for (const name of ['context-deep.md', 'context-triage.md']) {
      const golden = await readFile(path.join(root, 'tests', 'golden', name), 'utf8')
      for (const heading of [...golden.matchAll(/^## .+$/gm)].map((m) => m[0])) {
        const known = documented.has(heading) || heading === TRIAGE_PATCH_HEADING
        expect(known, `${name}: "${heading}" is sent but not documented in sections.ts`).toBe(true)
      }
    }
    // And nothing documented has quietly stopped being sent.
    const deep = await readFile(path.join(root, 'tests', 'golden', 'context-deep.md'), 'utf8')
    for (const section of CONTEXT_SECTIONS) {
      expect(deep, `"${section.heading}" is documented but absent from the deep context`).toContain(section.heading)
    }
  })

  it('pairs every secret pattern with a label, so the list cannot drift from the filter', () => {
    expect(SECRET_BASENAME_PATTERNS.length).toBeGreaterThan(5)
    for (const { pattern, label } of SECRET_BASENAME_PATTERNS) {
      expect(pattern).toBeInstanceOf(RegExp)
      expect(label.trim().length, String(pattern)).toBeGreaterThan(0)
      expect(renderDisclosure()).toContain(label)
    }
  })

  it('names the destination honestly, jurisdiction included', () => {
    const disclosure = renderDisclosure()
    // Flagged at M2 as a real adoption blocker. Stated neutrally; the reader decides.
    expect(disclosure).toContain('a Chinese company')
    expect(disclosure).toContain('OpenAI (a US company)')
    expect(disclosure).toContain('there is no')
    expect(disclosure).toContain('driftwatch backend')
    // The things that never travel, however the run is configured.
    expect(disclosure).toContain('your API key, the `key_command`, and that command\'s output')
    expect(disclosure).toContain('absolute paths')
    expect(disclosure).toContain('contextManifest')
  })
})

describe('the feature matrix in the README is the one in the code', () => {
  it('lists every capability on the side its tier declares — or fails until it does', async () => {
    const readme = await readFile(path.join(import.meta.dirname, '..', 'README.md'), 'utf8')
    const block = readme.split('<!-- feature-matrix')[1]?.split('<!-- /feature-matrix -->')[0] ?? ''

    // The promise is sold in this table, so it is checked against CAPABILITIES rather than
    // proof-read: a capability that changes tier changes the README or fails here (spec §9e).
    const free = capabilitiesOf('measurement').map((c) => c.label)
    const paid = capabilitiesOf('ai').map((c) => c.label)

    for (const label of [...free, ...paid]) expect(block, label).toContain(label)

    const rows = block.split('\n').filter((l) => l.trim().startsWith('|') && !l.includes('---'))
    const left = rows.map((r) => r.split('|')[1]?.trim()).filter(Boolean)
    const right = rows.map((r) => r.split('|')[2]?.trim()).filter(Boolean)

    expect(left.filter((l) => l !== 'Needs no key')).toEqual(free)
    expect(right.filter((l) => l !== 'Needs your own key')).toEqual(paid)
  })
})
