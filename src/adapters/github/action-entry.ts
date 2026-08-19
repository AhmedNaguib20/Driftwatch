import { spawn } from 'node:child_process'
import { appendFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ResultJson } from '../../core/index.js'
import { parseActionEvent } from './event.js'
import { preflightBase } from './preflight.js'
import { publishResult } from './publish.js'
import { renderComment } from './render-comment.js'

/**
 * The Action entry (action.yml → this file). Thin: parse event → preflight → run the CLI with
 * --json (the adapter consumes the contract exactly as any external consumer would) → publish →
 * step summary. Exit 0 on every measured path; exit 1 only for block_merge:true + regression, or
 * for setup errors that make measurement impossible (a silently green broken setup is worse).
 */

export async function main(): Promise<void> {
  const event = await parseActionEvent(process.env)
  if (event.kind === 'not-a-pr') {
    console.log(`driftwatch: ${event.reason}`)
    return
  }

  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd()
  // Actions passes inputs as INPUT_<NAME>; detection walks UP from cwd, never down, so a nested
  // project (monorepo, fixtures) must be pointed at explicitly.
  const projectDir = process.env['INPUT_PROJECT-DIR']?.trim() || '.'
  const projectCwd = path.resolve(workspace, projectDir)

  const preflight = await preflightBase(workspace, event.baseSha)
  if (!preflight.ok) {
    console.error(`driftwatch: ${preflight.fix}`)
    process.exitCode = 1
    return
  }

  // Runner identity into the measurement protocol via the generic env contract — cross-runner
  // comparisons stay refusable (§5.1) without core ever knowing what a "runner" is.
  const hostLabels = [
    process.env.RUNNER_OS && `os:${process.env.RUNNER_OS}`,
    process.env.RUNNER_ARCH && `arch:${process.env.RUNNER_ARCH}`,
    process.env.ImageOS && `image:${process.env.ImageOS}`,
    process.env.RUNNER_ENVIRONMENT && `env:${process.env.RUNNER_ENVIRONMENT}`,
  ].filter(Boolean)

  const result = await runCli(projectCwd, event.baseSha, event.baseRef, hostLabels.join(','))
  if (!result) {
    process.exitCode = 1
    return
  }

  console.log(`driftwatch: verdict ${result.verdict}`)

  const token = process.env.GITHUB_TOKEN
  if (token) {
    const outcome = await publishResult(result, {
      owner: event.owner,
      repo: event.repo,
      prNumber: event.prNumber,
      headSha: event.headSha,
      blockMerge: result.config.block_merge,
      token,
    })
    if (outcome.commentUrl) console.log(`driftwatch: comment ${outcome.commentUrl}`)
    if (outcome.checkUrl) console.log(`driftwatch: check ${outcome.checkUrl}`)
    for (const warning of outcome.warnings) console.error(`driftwatch: warning: ${warning}`)
  } else {
    console.error('driftwatch: warning: GITHUB_TOKEN is not set — nothing was posted to the PR')
  }

  // Free visibility even when both surfaces failed: the job's own summary page.
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, renderComment(result) + '\n', 'utf8')
  }

  process.exitCode = exitCodeFor(result)
}

/** Exit 1 only when the team explicitly opted into blocking and a regression was confirmed. */
export function exitCodeFor(result: Pick<ResultJson, 'verdict' | 'config'>): number {
  return result.config.block_merge && result.verdict === 'regression' ? 1 : 0
}

/**
 * Runs the CLI as a child with stderr INHERITED — progress streams into the CI log live, with the
 * runner's own timestamps intact. (The first Layer 2a observation ran 7 minutes with a silent log
 * because this buffered stderr and dumped it at the end.) stdout is captured: it carries the JSON.
 */
async function runCli(
  cwd: string,
  baseSha: string,
  baseRef: string,
  hostLabels: string,
): Promise<ResultJson | null> {
  const cliPath = path.resolve(fileURLToPath(import.meta.url), '../../../cli/index.js')
  const args = [cliPath, 'run', '--json', '--base', baseSha, '--base-label', baseRef, '--cwd', cwd]

  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, DRIFTWATCH_HOST_LABELS: hostLabels },
      stdio: ['ignore', 'pipe', 'inherit'],
    })

    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      console.error(`driftwatch: the measurement run failed to start: ${error.message}`)
      resolve(null)
    })
    child.on('close', (code) => {
      if (code !== 0) {
        console.error(`driftwatch: the measurement run exited with code ${code}`)
        resolve(null)
        return
      }
      try {
        resolve(JSON.parse(stdout) as ResultJson)
      } catch {
        console.error('driftwatch: the measurement run produced unparseable JSON')
        resolve(null)
      }
    })
  })
}

// action.yml invokes this file directly.
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`driftwatch: unexpected failure: ${(error as Error).stack}`)
    process.exitCode = 1
  })
}
