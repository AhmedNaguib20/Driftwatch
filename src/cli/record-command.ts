import { performance } from 'node:perf_hooks'
import pc from 'picocolors'
import { recordRun, writeLastRecordSeconds } from '../core/index.js'
import { renderResult } from './render-table.js'

/** `driftwatch record` — the local trend point. Measurement only; publishing is CI's job. */
export async function recordCommand(flags: {
  json: boolean
  serve: boolean
  browser: boolean
  cwd: string
}): Promise<void> {
  const progress = (message: string) => console.error(pc.dim(`→ ${message}`))

  try {
    const started = performance.now()
    const result = await recordRun({
      cwd: flags.cwd,
      serve: flags.serve,
      browser: flags.browser,
      progress,
    })
    // Feeds `driftwatch replay`'s upfront cost estimate — measured, never guessed (spec §10).
    await writeLastRecordSeconds(result.project.root, (performance.now() - started) / 1000).catch(() => {})
    console.log(flags.json ? JSON.stringify(result, null, 2) : renderResult(result))
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
    console.error(pc.red(`driftwatch could not complete the recording: ${message}`))
    if (flags.json) console.log(JSON.stringify({ error: 'driftwatch failed before producing a result' }))
  }
}
