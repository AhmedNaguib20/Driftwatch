import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import pc from 'picocolors'
import {
  assessDrift,
  buildTimelines,
  detectProject,
  readPerfDataIndex,
  renderDashboard,
} from '../core/index.js'

/** `driftwatch dashboard [--open]` — the same dashboard CI publishes, written to .perf/ locally. */
export async function dashboardCommand(flags: {
  open: boolean
  fetch: boolean
  cwd: string
}): Promise<void> {
  const profile = await detectProject({ cwd: flags.cwd })
  if (!profile.gitRoot) {
    console.error(pc.yellow('not inside a git repository — there is no perf-data branch to read'))
    return
  }

  const read = await readPerfDataIndex(profile.gitRoot, { fetch: flags.fetch })
  if ('unavailable' in read) {
    console.log(pc.yellow(read.unavailable))
    return
  }

  const reports = buildTimelines(read.index).map((timeline) => ({ timeline, drift: assessDrift(timeline) }))
  const html = renderDashboard({
    reports,
    index: read.index,
    generatedAt: new Date().toISOString(),
    sourceLabel: read.index.entries.at(-1)?.branch ?? null,
  })

  const target = path.join(profile.gitRoot, '.perf', 'dashboard.html')
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, html, 'utf8')
  console.log(`${pc.green('wrote')} ${path.relative(process.cwd(), target)} (${read.index.entries.length} recorded commit(s))`)

  if (flags.open) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
    spawn(opener, [target], { detached: true, stdio: 'ignore' }).unref()
  }
}
