import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

import { exitCodeFor } from '../src/adapters/github/action-entry.js'
import { parseActionEvent } from '../src/adapters/github/event.js'
import { preflightBase } from '../src/adapters/github/preflight.js'
import { renderWorkflow } from '../src/adapters/github/workflow-template.js'
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
