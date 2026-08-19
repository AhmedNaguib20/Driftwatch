import pc from 'picocolors'
import { recordRun } from '../core/index.js'
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
    const result = await recordRun({
      cwd: flags.cwd,
      serve: flags.serve,
      browser: flags.browser,
      progress,
    })
    console.log(flags.json ? JSON.stringify(result, null, 2) : renderResult(result))
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
    console.error(pc.red(`driftwatch could not complete the recording: ${message}`))
    if (flags.json) console.log(JSON.stringify({ error: 'driftwatch failed before producing a result' }))
  }
}
