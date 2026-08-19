import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * The upfront cost estimate (spec §10: "expensive → user picks N, estimate + confirmation") is
 * derived from THIS machine's own last record-mode measurement — never a guess presented as a
 * number (rule 3 applies to time too). No prior run → the estimate honestly says so.
 */

const STATS_FILE = 'replay-stats.json'

export interface ReplayEstimate {
  readonly commits: number
  /** Per-commit seconds from the last record run on this machine; null when unknown. */
  readonly perCommitSeconds: number | null
  readonly totalSeconds: number | null
}

export async function readLastRecordSeconds(projectRoot: string): Promise<number | null> {
  try {
    const raw = await readFile(path.join(projectRoot, '.perf', STATS_FILE), 'utf8')
    const parsed = JSON.parse(raw) as { lastRecordSeconds?: number }
    return typeof parsed.lastRecordSeconds === 'number' && parsed.lastRecordSeconds > 0
      ? parsed.lastRecordSeconds
      : null
  } catch {
    return null
  }
}

export async function writeLastRecordSeconds(projectRoot: string, seconds: number): Promise<void> {
  const dir = path.join(projectRoot, '.perf')
  await mkdir(dir, { recursive: true })
  await writeFile(
    path.join(dir, STATS_FILE),
    JSON.stringify({ lastRecordSeconds: Math.round(seconds * 10) / 10 }, null, 2) + '\n',
    'utf8',
  )
}

export function estimate(commits: number, perCommitSeconds: number | null): ReplayEstimate {
  return {
    commits,
    perCommitSeconds,
    totalSeconds: perCommitSeconds === null ? null : Math.round(commits * perCommitSeconds),
  }
}

export function describeEstimate(e: ReplayEstimate): string {
  if (e.totalSeconds === null) {
    return `${e.commits} commit(s) × unknown duration — no record run has been measured on this machine yet; the first commit will calibrate the projection`
  }
  const minutes = e.totalSeconds / 60
  const span = minutes >= 90 ? `≈ ${(minutes / 60).toFixed(1)} hours` : `≈ ${Math.max(1, Math.round(minutes))} minute(s)`
  return `${e.commits} commit(s) × ~${Math.round(e.perCommitSeconds!)}s (measured from your machine's last record run) ${span}`
}
