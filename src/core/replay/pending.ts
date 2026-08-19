import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ResultJson } from '../report/types.js'

/**
 * Interrupt safety (spec §10): every measured commit lands in `.perf/replay-pending/<sha>.json`
 * the moment its measurement finishes. A Ctrl-C loses nothing — the next replay loads pending
 * results instead of re-measuring, and the directory is cleared only after the batch lands in
 * perf-data.
 */

export interface PendingEntry {
  readonly sha: string
  /** Present for a measured commit; absent when the commit was skipped. */
  readonly result?: ResultJson
  /** Present when measurement failed — reason with log tail (spec §10: never abort). */
  readonly skipReason?: string
}

export function pendingDir(projectRoot: string): string {
  return path.join(projectRoot, '.perf', 'replay-pending')
}

export async function savePending(projectRoot: string, entry: PendingEntry): Promise<void> {
  const dir = pendingDir(projectRoot)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, `${entry.sha}.json`), JSON.stringify(entry, null, 2) + '\n', 'utf8')
}

export async function loadPending(projectRoot: string): Promise<Map<string, PendingEntry>> {
  const dir = pendingDir(projectRoot)
  const loaded = new Map<string, PendingEntry>()
  const files = await readdir(dir).catch(() => [] as string[])
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    try {
      const entry = JSON.parse(await readFile(path.join(dir, file), 'utf8')) as PendingEntry
      if (entry.sha) loaded.set(entry.sha, entry)
    } catch {
      // A torn write from the interrupt itself — re-measure that commit rather than trust it.
    }
  }
  return loaded
}

export async function clearPending(projectRoot: string): Promise<void> {
  await rm(pendingDir(projectRoot), { recursive: true, force: true })
}
