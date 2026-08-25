#!/usr/bin/env node
/**
 * The movement doctrine, reproducible on your own machine.
 *
 * The README claims driftwatch finds 3 planted regressions among 10 commits without accusing any
 * of the 7 innocent ones. This is that claim, executable: it builds the history, replays it, and
 * prints what the tool concluded beside what was actually planted.
 *
 * Everything happens in a temporary directory that is removed on the way out. Nothing touches the
 * repository you run it from, and nothing is pushed anywhere.
 *
 *     npm run demo:movement
 *
 * Cost: under 10 seconds and a few MB. The build is a deliberately tiny stand-in — a script that
 * writes a payload file — because what is being demonstrated is the DECISION (which commits get
 * named), not Next.js's compiler. The original proof at M7 ran the same shape against real
 * Next.js builds and took 8 minutes and 367 MB, which is why it is not a CI fixture.
 */

import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cli = path.join(repoRoot, 'dist', 'cli', 'index.js')

/**
 * Ten commits. Three of them make the shipped bundle bigger; the other seven change files the
 * build never reads. A perfect run names exactly the three.
 */
const HISTORY = [
  { message: 'feat: initial app', bytes: 20_000, guilty: false },
  { message: 'docs: contributing guide', bytes: 20_000, guilty: false },
  { message: 'chore: tidy the readme', bytes: 20_000, guilty: false },
  { message: 'feat: add the charting library', bytes: 46_000, guilty: true },
  { message: 'docs: architecture notes', bytes: 46_000, guilty: false },
  { message: 'chore: update the changelog', bytes: 46_000, guilty: false },
  { message: 'feat: icon set for the dashboard', bytes: 74_000, guilty: true },
  { message: 'docs: fix a typo', bytes: 74_000, guilty: false },
  { message: 'feat: polyfill for the date picker', bytes: 103_000, guilty: true },
  { message: 'chore: bump the year in the licence', bytes: 103_000, guilty: false },
]

async function main() {
  if (!existsSync(cli)) {
    console.error(`No build found at ${path.relative(repoRoot, cli)}.\n\nRun it through npm, which builds first:\n\n    npm run demo:movement\n`)
    process.exitCode = 1
    return
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'driftwatch-movement-demo-'))
  try {
    const planted = await buildHistory(dir)
    console.log(`\nBuilt ${HISTORY.length} commits in ${dir}`)
    console.log('Planted regressions (the bundle grows at these three, and nowhere else):')
    for (const { sha, message } of planted) console.log(`  ${sha.slice(0, 7)}  ${message}`)

    console.log('\nReplaying — measuring every commit as it was…\n')
    await run(['replay', '--last', String(HISTORY.length), '--yes', '--write-perf-data', '--no-serve', '--no-browser', '--cwd', dir], dir)

    console.log('\nWhat the movement report concluded:\n')
    await run(['trend', '--moves', '--no-fetch', '--cwd', dir], dir)

    // The verdict is COMPUTED, not asserted: the planted shas are compared against the shas the
    // tool named, so this script prints the README's claim rather than restating it.
    await scoreIt(dir, planted)

    console.log(
      'The wall-clock metrics are listed as "not judged": build time drifts with the machine across\n' +
        'a replay, so naming a commit for it would be a claim the instrument cannot support (spec §10).\n',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
    console.log('Temporary repository removed.')
  }
}

async function buildHistory(dir) {
  const write = async (rel, contents) => {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true })
    await writeFile(path.join(dir, rel), contents, 'utf8')
  }
  const git = (...args) => exec('git', ['-C', dir, ...args])

  await exec('git', ['init', '-q', '-b', 'main', dir])
  await git('config', 'user.email', 'demo@driftwatch.local')
  await git('config', 'user.name', 'driftwatch demo')

  await write('package.json', JSON.stringify({ name: 'movement-demo', scripts: { build: 'node build.js' } }, null, 2))
  await write('next.config.mjs', 'export default {}\n')
  await write('package-lock.json', JSON.stringify({ name: 'movement-demo', lockfileVersion: 3, requires: true, packages: { '': { name: 'movement-demo' } } }, null, 2))
  await write('.gitignore', 'node_modules/\n.next/\n.perf/\n')
  // node_modules exists but is untracked: driftwatch clones it rather than installing.
  await write('node_modules/.keep', '')

  const planted = []
  for (const [i, commit] of HISTORY.entries()) {
    // The build writes exactly `bytes` into the client bundle. A "guilty" commit raises it; an
    // innocent one only touches a file the build never reads.
    await write('build.js', `const fs = require('fs')
fs.mkdirSync('.next/static', { recursive: true })
fs.writeFileSync('.next/static/app.js', 'x'.repeat(${commit.bytes}))
`)
    await write('NOTES.md', `${commit.message}\n\nRevision ${i + 1} of the demo history.\n`)
    await git('add', '-A')
    await git('commit', '-q', '-m', commit.message)
    if (commit.guilty) {
      const { stdout } = await git('rev-parse', 'HEAD')
      planted.push({ sha: stdout.trim(), message: commit.message })
    }
  }
  return planted
}

/** Reads the movement report as JSON and scores it against what was actually planted. */
async function scoreIt(dir, planted) {
  const { stdout } = await exec(process.execPath, [cli, 'trend', '--moves', '--no-fetch', '--json', '--cwd', dir], {
    cwd: dir,
    maxBuffer: 64 * 1024 * 1024,
  })
  const report = JSON.parse(stdout)
  const bundle = report.movements.moved.find((m) => m.id === 'client_bundle_size')
  const named = new Set((bundle?.movements ?? []).map((m) => m.toSha))
  const plantedShas = new Set(planted.map((p) => p.sha))

  const found = [...plantedShas].filter((sha) => named.has(sha)).length
  const innocentsAccused = [...named].filter((sha) => !plantedShas.has(sha)).length
  const innocents = HISTORY.length - planted.length

  console.log(`\n  ${found} of ${planted.length} planted regressions found.`)
  console.log(`  ${innocentsAccused} of ${innocents} innocent commits falsely accused.`)
  console.log(
    found === planted.length && innocentsAccused === 0
      ? '  Exactly the planted commits, and only those.\n'
      : '  MISMATCH — the report and the plan disagree.\n',
  )
}

/** Streams straight to the terminal: the point is to watch the tool work. */
function run(args, cwd) {
  return new Promise((resolve) => {
    spawn(process.execPath, [cli, ...args], { cwd, stdio: 'inherit' }).on('close', () => resolve())
  })
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
