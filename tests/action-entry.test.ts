import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { exitCodeFor } from '../src/adapters/github/action-entry.js'
import { parseActionEvent } from '../src/adapters/github/event.js'
import { preflightBase } from '../src/adapters/github/preflight.js'
import { PUBLISHED_ACTION, renderWorkflow } from '../src/adapters/github/workflow-template.js'
import { writeGithubWorkflow } from '../src/cli/init-command.js'
import { detectProject, hostLabelsFromEnv, protocolMismatches } from '../src/core/index.js'
import type { MeasurementProtocol } from '../src/core/index.js'

const exec = promisify(execFile)
const temps: string[] = []

async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'driftwatch-action-'))
  temps.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(temps.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const PR_PAYLOAD = JSON.stringify({
  pull_request: {
    number: 7,
    base: { sha: 'b'.repeat(40), ref: 'main' },
    head: { sha: 'h'.repeat(40), ref: 'feature', repo: { full_name: 'ahmed/driftwatch' } },
  },
})

describe('event parsing', () => {
  it('extracts the PR coordinates from a pull_request event', async () => {
    const event = await parseActionEvent(
      {
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_REPOSITORY: 'ahmed/driftwatch',
        GITHUB_EVENT_PATH: '/event.json',
      },
      async () => PR_PAYLOAD,
    )

    expect(event).toEqual({
      kind: 'pull-request',
      owner: 'ahmed',
      repo: 'driftwatch',
      prNumber: 7,
      baseSha: 'b'.repeat(40),
      baseRef: 'main',
      headSha: 'h'.repeat(40),
      headRef: 'feature',
      fromFork: false,
    })
  })

  it('a push to the default branch becomes record mode', async () => {
    const event = await parseActionEvent(
      {
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REPOSITORY: 'ahmed/driftwatch',
        GITHUB_EVENT_PATH: '/event.json',
      },
      async () =>
        JSON.stringify({
          ref: 'refs/heads/main',
          after: 'c'.repeat(40),
          repository: { default_branch: 'main' },
        }),
    )
    expect(event).toEqual({
      kind: 'record-push',
      owner: 'ahmed',
      repo: 'driftwatch',
      sha: 'c'.repeat(40),
      branch: 'main',
    })
  })

  it('a push to a non-default branch is a reasoned no-op', async () => {
    const event = await parseActionEvent(
      {
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REPOSITORY: 'ahmed/driftwatch',
        GITHUB_EVENT_PATH: '/event.json',
      },
      async () =>
        JSON.stringify({
          ref: 'refs/heads/feature',
          after: 'c'.repeat(40),
          repository: { default_branch: 'main' },
        }),
    )
    expect(event.kind).toBe('not-a-pr')
    if (event.kind === 'not-a-pr') expect(event.reason).toMatch(/default branch/)
  })

  it('a schedule event is the drift-alert run, and needs no payload to parse', async () => {
    // Alerting's whole input is the recorded history; reading an event payload would only invent
    // a way to fail. GITHUB_EVENT_PATH is deliberately absent here.
    for (const name of ['schedule', 'workflow_dispatch']) {
      const event = await parseActionEvent({ GITHUB_EVENT_NAME: name, GITHUB_REPOSITORY: 'acme/app' })
      expect(event.kind, name).toBe('scheduled-alerts')
      if (event.kind === 'scheduled-alerts') {
        expect(event.owner).toBe('acme')
        expect(event.repo).toBe('app')
      }
    }
  })

  it('an event driftwatch has no mode for is still a clean no-op', async () => {
    const event = await parseActionEvent({ GITHUB_EVENT_NAME: 'issue_comment' })
    expect(event.kind).toBe('not-a-pr')
    if (event.kind === 'not-a-pr') expect(event.reason).toMatch(/"issue_comment".*nothing to do/)
  })

  it('malformed payload degrades to a reasoned no-op', async () => {
    const event = await parseActionEvent(
      {
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_REPOSITORY: 'a/b',
        GITHUB_EVENT_PATH: '/event.json',
      },
      async () => '{broken',
    )
    expect(event.kind).toBe('not-a-pr')
    if (event.kind === 'not-a-pr') expect(event.reason).toMatch(/could not read the event payload/)
  })

  it('a payload without a pull_request block is refused with the reason', async () => {
    const event = await parseActionEvent(
      {
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_REPOSITORY: 'a/b',
        GITHUB_EVENT_PATH: '/event.json',
      },
      async () => '{"action": "opened"}',
    )
    expect(event.kind).toBe('not-a-pr')
    if (event.kind === 'not-a-pr') expect(event.reason).toMatch(/no complete pull_request block/)
  })
})

describe('base preflight', () => {
  it('passes when the base commit is present', async () => {
    const dir = await scratch()
    await exec('git', ['init', '-q'], { cwd: dir })
    await exec('git', ['-C', dir, 'config', 'user.email', 't@t'])
    await exec('git', ['-C', dir, 'config', 'user.name', 't'])
    await writeFile(path.join(dir, 'a.txt'), 'x')
    await exec('git', ['-C', dir, 'add', '-A'])
    await exec('git', ['-C', dir, 'commit', '-q', '-m', 'c'])
    const sha = (await exec('git', ['-C', dir, 'rev-parse', 'HEAD'])).stdout.trim()

    expect(await preflightBase(dir, sha)).toEqual({ ok: true })
  })

  it('a missing base fails with the exact fix, not a description', async () => {
    const dir = await scratch()
    await exec('git', ['init', '-q'], { cwd: dir })

    const result = await preflightBase(dir, 'f'.repeat(40))

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.fix).toContain('fetch-depth: 0')
      expect(result.fix).toContain('actions/checkout')
    }
  })
})

describe('exit codes', () => {
  type ExitInput = Parameters<typeof exitCodeFor>[0]
  const input = (verdict: ExitInput['verdict'], block_merge: boolean): ExitInput =>
    ({ verdict, config: { block_merge } }) as ExitInput

  it('exit 0 for every verdict while block_merge is false', () => {
    for (const verdict of ['ok', 'regression', 'inconclusive'] as const) {
      expect(exitCodeFor(input(verdict, false))).toBe(0)
    }
  })

  it('exit 1 only for block_merge:true + regression', () => {
    expect(exitCodeFor(input('regression', true))).toBe(1)
    expect(exitCodeFor(input('ok', true))).toBe(0)
    expect(exitCodeFor(input('inconclusive', true))).toBe(0)
  })
})

describe('host labels — cross-runner comparisons stay refusable', () => {
  it('parses, trims, and sorts the generic env contract', () => {
    expect(hostLabelsFromEnv({ DRIFTWATCH_HOST_LABELS: 'os:Linux, image:ubuntu24, arch:X64' })).toEqual([
      'arch:X64',
      'image:ubuntu24',
      'os:Linux',
    ])
    expect(hostLabelsFromEnv({})).toEqual([])
  })

  it('differing host labels are a protocol mismatch', () => {
    const proto = (hostLabels: string[]): MeasurementProtocol => ({
      version: 1, workspace: 'worktree', cacheState: 'cold', nodeModules: 'cloned',
      gitMetadata: 'absent', nodeVersion: 'v20', platform: 'linux', arch: 'x64',
      buildCommand: 'b', buildSamples: 3, warmupSamples: 1, routeSamples: 5, routeWarmupSamples: 1, browser: 'none', lighthouseProfile: 'none', hostLabels, env: {},
    })

    const diffs = protocolMismatches(proto(['os:Linux']), proto(['os:macOS']))
    expect(diffs).toEqual(['hostLabels: os:Linux (base) vs os:macOS (current)'])
  })
})

describe('the generated workflow runs in a repo that is not ours', () => {
  it('references the PUBLISHED action, never the local one', () => {
    const theirs = renderWorkflow({ projectDir: '.', self: false })

    // `uses: ./` looks for an action.yml the user does not have, so a workflow carrying it fails
    // on their first push. It shipped that way from M3 to v0.6.0 because this repo — the only
    // place it was ever generated — is the one place it happens to be correct.
    expect(theirs).not.toContain('uses: ./')
    expect(theirs).not.toContain('npm ci && npm run build')
    expect(theirs).toContain(`uses: ${PUBLISHED_ACTION}`)
  })

  it('pins the action to an exact tag, for the same reason it pins Chrome', () => {
    const theirs = renderWorkflow({ projectDir: '.', self: false })

    // driftwatch's own version is part of the protocol hash, so a floating tag would let an
    // upgrade split a user's trend into a segment they did not cause and cannot explain.
    // Scoped to OUR action: third-party actions pinned to a major (checkout@v4) are normal.
    const ours = theirs.split('\n').filter((l) => l.includes('AhmedNaguib20/Driftwatch@'))
    expect(ours.length).toBeGreaterThan(0)
    for (const line of ours) expect(line).toMatch(/@v\d+\.\d+\.\d+$/)
  })

  it('keeps the LOCAL action only for driftwatch itself', () => {
    const ours = renderWorkflow({ projectDir: '.', self: true })

    // Here the opposite is required: a pull request must measure the code it changes, not the
    // last release.
    expect(ours).toContain('uses: ./')
    expect(ours).not.toContain(PUBLISHED_ACTION)
  })

  it('both jobs get the same treatment — the measure job and the alerts job', () => {
    const theirs = renderWorkflow({ projectDir: '.', self: false })
    expect([...theirs.matchAll(new RegExp(`uses: ${PUBLISHED_ACTION}`, 'g'))]).toHaveLength(2)
  })
})

describe('init --github workflow file', () => {
  it('matches its golden file', async () => {
    const rendered = renderWorkflow()
    const golden = path.join(import.meta.dirname, 'golden', 'workflow-driftwatch.yml')
    if (process.env.UPDATE_GOLDEN === '1') await writeFile(golden, rendered, 'utf8')
    expect(rendered).toBe(await readFile(golden, 'utf8'))
    // The two non-negotiables, asserted independently of the golden:
    expect(rendered).toContain('fetch-depth: 0')
    expect(rendered).toContain('cancel-in-progress: true')
    expect(rendered).not.toMatch(/ghp_|sk-/) // no literal secrets, ever
  })

  it('writes when absent, refuses when present and different, obeys --force', async () => {
    const dir = await scratch()
    await exec('git', ['init', '-q'], { cwd: dir })
    await writeFile(path.join(dir, 'package.json'), '{}')
    const profile = await detectProject({ cwd: dir })
    const target = path.join(dir, '.github', 'workflows', 'driftwatch.yml')

    await writeGithubWorkflow(profile, false)
    expect(await readFile(target, 'utf8')).toBe(renderWorkflow())

    // Their edit survives a plain re-run…
    await writeFile(target, 'name: theirs\n', 'utf8')
    await writeGithubWorkflow(profile, false)
    expect(await readFile(target, 'utf8')).toBe('name: theirs\n')

    // …and --force overwrites it.
    await writeGithubWorkflow(profile, true)
    expect(await readFile(target, 'utf8')).toBe(renderWorkflow())
  })
})

describe('fork detection', () => {
  it('a head repo different from the base repo flags fromFork', async () => {
    const event = await parseActionEvent(
      {
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_REPOSITORY: 'ahmed/driftwatch',
        GITHUB_EVENT_PATH: '/event.json',
      },
      async () =>
        JSON.stringify({
          pull_request: {
            number: 7,
            base: { sha: 'b'.repeat(40), ref: 'main' },
            head: { sha: 'h'.repeat(40), ref: 'feature', repo: { full_name: 'stranger/driftwatch-fork' } },
          },
        }),
    )
    expect(event.kind).toBe('pull-request')
    if (event.kind === 'pull-request') expect(event.fromFork).toBe(true)
  })
})

describe('action.yml runs the published package, not a second copy of it', () => {
  const actionYml = readFileSync(path.join(import.meta.dirname, '..', 'action.yml'), 'utf8')
  const action = parse(actionYml) as {
    runs: { using: string; steps: { shell?: string; run: string; env?: Record<string, string> }[] }
    inputs: Record<string, unknown>
  }

  /**
   * Two releases shipped an Action that could not execute, both because the tag carried a
   * hand-built copy of the product: v0.6.0 without `dist/`, then v0.6.1 with `dist/` and no
   * `node_modules/`. Neither was reachable from a unit test, because both were about what the
   * TAG contained rather than what the source said. What IS testable is the property that
   * removes the whole class: the Action installs the published package (hard rule 7) and names
   * its version by substitution rather than by hand.
   */
  it('is a composite action that installs the npm package', () => {
    expect(action.runs.using).toBe('composite')
    for (const step of action.runs.steps) expect(step.shell).toBe('bash')
    expect(actionYml).toContain('npx --yes --prefer-online --package "@ahmednaguib/driftwatch@$VERSION"')
    expect(actionYml).toContain('driftwatch-action')
    // The old mechanism, gone. Scoped to `runs:` — the comments above it describe what went
    // wrong and must be free to name `dist/`; what matters is that nothing EXECUTES from it.
    expect(JSON.stringify(action.runs)).not.toContain('dist/')
  })

  it('carries a placeholder on main, never a written-out version', () => {
    // A hand-written version can drift from package.json; the release workflow substitutes this
    // one. If someone replaces it with a literal, tag and package can disagree again.
    // Asserted against the VERSION assignment, which is where the release workflow substitutes.
    // The first form of this checked that no literal `@…/driftwatch@1.2.3` appeared anywhere —
    // which is true of every possible file, since the npx line interpolates $VERSION. A negative
    // assertion that nothing could ever violate is not a test.
    expect(actionYml).toContain("VERSION='__DRIFTWATCH_VERSION__'")
    expect(actionYml).not.toMatch(/VERSION='\d+\.\d+\.\d+'/)
  })

  it('passes the project-dir input through by name, since composite steps get no INPUT_ vars', () => {
    const step = action.runs.steps.at(0)
    expect(step?.env?.['DRIFTWATCH_PROJECT_DIR']).toBe('${{ inputs.project-dir }}')
    expect(Object.keys(action.inputs)).toContain('project-dir')
  })
})
