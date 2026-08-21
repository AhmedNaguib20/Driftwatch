import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import pc from 'picocolors'
import { WORKFLOW_PATH, renderWorkflow } from '../adapters/github/workflow-template.js'
import { configFromProfile, detectProject, writeConfigIfAbsent } from '../core/index.js'
import type { ProjectProfile } from '../core/index.js'

/** `driftwatch init` — detect the stack, print what was concluded and why, write perf.yml. */
export async function initCommand(options: {
  cwd: string
  json: boolean
  github?: boolean
  force?: boolean
}): Promise<void> {
  const profile = await detectProject({ cwd: options.cwd })

  if (options.json) {
    console.log(JSON.stringify(profile, null, 2))
    return
  }

  printProfile(profile)

  // `init` is the ONLY command that writes to the user's tree, and it names every file it
  // touches (spec §9a — `run`'s silent perf.yml was the trial's headline finding).
  const result = await writeConfigIfAbsent(profile.projectRoot, configFromProfile(profile))
  const rel = path.relative(process.cwd(), result.path) || result.path
  console.log(
    result.created
      ? `\n${pc.green('wrote')} ${rel} ${pc.dim('(the only file init creates unless --github is given)')}`
      : `\n${pc.dim('kept')}  ${rel} ${pc.dim(`(${result.reason})`)}`,
  )

  if (options.github) {
    await writeGithubWorkflow(profile, options.force ?? false)
  }
}

/**
 * Writes the CI workflow. An existing file is THEIR file (rule 2 applies to workflows too): show
 * what would change and refuse without --force.
 */
export async function writeGithubWorkflow(
  profile: ProjectProfile,
  force: boolean,
): Promise<void> {
  const root = profile.gitRoot ?? profile.projectRoot
  const target = path.join(root, WORKFLOW_PATH)
  const rendered = renderWorkflow(profile.pathInRepo ?? '.')

  const existing = await readFile(target, 'utf8').catch(() => null)
  if (existing !== null && !force) {
    if (existing === rendered) {
      console.log(`${pc.dim('kept')}  ${WORKFLOW_PATH} ${pc.dim('(already up to date)')}`)
      return
    }
    console.log(`\n${pc.yellow('refusing to overwrite')} ${WORKFLOW_PATH} — it differs from what init would write.`)
    console.log(pc.dim('What would change (- yours, + generated):'))
    console.log(naiveDiff(existing, rendered))
    console.log(`\nRe-run with ${pc.bold('--force')} to overwrite.`)
    return
  }

  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, rendered, 'utf8')
  console.log(`${pc.green('wrote')} ${WORKFLOW_PATH}`)
}

/** Line-level diff, enough to show what --force would destroy. Not a patch — a preview. */
function naiveDiff(theirs: string, generated: string): string {
  const a = theirs.split('\n')
  const b = generated.split('\n')
  const out: string[] = []
  const max = Math.max(a.length, b.length)
  for (let i = 0; i < max; i += 1) {
    if (a[i] === b[i]) continue
    if (a[i] !== undefined) out.push(pc.red(`- ${a[i]}`))
    if (b[i] !== undefined) out.push(pc.green(`+ ${b[i]}`))
  }
  return out.slice(0, 40).join('\n') + (out.length > 40 ? pc.dim(`\n… ${out.length - 40} more differing lines`) : '')
}

function printProfile(profile: ProjectProfile): void {
  const rows: [string, string][] = [
    ['project', profile.projectRoot],
    ['framework', profile.frameworkVersion
      ? `${profile.framework} ${profile.frameworkVersion}`
      : profile.framework],
    ['package manager', profile.lockfile
      ? `${profile.packageManager} (${profile.lockfile})`
      : `${profile.packageManager} (no lockfile)`],
    ['build', profile.commands.build
      ? [profile.commands.build.bin, ...profile.commands.build.args].join(' ')
      : pc.yellow('none')],
    ['routes', profile.routes.length > 0 ? String(profile.routes.length) : pc.dim('none found')],
    ['metrics', profile.supportedMetrics.length > 0
      ? profile.supportedMetrics.join(', ')
      : pc.yellow('none available')],
  ]

  const width = Math.max(...rows.map(([label]) => label.length))
  for (const [label, value] of rows) {
    console.log(`${pc.dim(label.padEnd(width))}  ${value}`)
  }

  if (profile.evidence.length > 0) {
    console.log(`\n${pc.dim('evidence')}`)
    for (const item of profile.evidence) {
      const detail = item.detail ? pc.dim(` \u2014 ${item.detail}`) : ''
      console.log(`  ${item.fact} ${pc.dim(`[${item.source}]`)}${detail}`)
    }
  }

  for (const warning of profile.warnings) {
    console.log(`\n${pc.yellow('warning')} ${warning}`)
  }
}
