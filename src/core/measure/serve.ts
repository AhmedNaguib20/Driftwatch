import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Command } from '../detect/types.js'

/**
 * Boots the BUILT app inside a measurement workspace — `next start` on the completed build, never
 * dev mode: dev servers compile on demand, which would measure compilation, not serving.
 *
 * Lifecycle discipline mirrors the worktrees: stopped on completion AND on error, and a marker
 * file lets the next run sweep servers a crashed driftwatch left behind. A leaked server holds a
 * port and burns CPU forever.
 */

export const SERVE_READY_TIMEOUT_MS = 60_000
const READY_POLL_INTERVAL_MS = 250
const MARKER_PREFIX = 'driftwatch-serve-'

export interface ServerHandle {
  readonly url: string
  readonly port: number
  /** Last chunk of interleaved stdout+stderr — for skip reasons when things go wrong later. */
  logsTail(): string
  stop(): Promise<void>
}

export type ServeOutcome =
  | { readonly ok: true; readonly server: ServerHandle }
  | { readonly ok: false; readonly reason: string }

export async function startServer(
  workspaceDir: string,
  serveCommand: Command,
  env: Readonly<Record<string, string>>,
): Promise<ServeOutcome> {
  const port = await freePort()
  const url = `http://127.0.0.1:${port}`

  // Detached process group: `next start` spawns children; killing the group gets them all.
  const child = spawn(serveCommand.bin, [...serveCommand.args, '-p', String(port)], {
    cwd: workspaceDir,
    env: { ...process.env, ...env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })

  let tail = ''
  const keep = (chunk: Buffer) => {
    tail = (tail + chunk.toString('utf8')).slice(-8_192)
  }
  child.stdout?.on('data', keep)
  child.stderr?.on('data', keep)

  let exited = false
  child.on('close', () => {
    exited = true
  })
  child.on('error', () => {
    exited = true
  })

  const marker = await writeMarker(child.pid)

  const stop = async () => {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
    if (marker) await rm(marker, { force: true }).catch(() => {})
  }

  // Readiness: poll the root route until it answers 200, hard timeout.
  const deadline = Date.now() + SERVE_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (exited) {
      await stop()
      return { ok: false, reason: `server exited before becoming ready; last output:\n${lastLines(tail)}` }
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      if (response.status === 200) {
        await response.arrayBuffer().catch(() => {})
        return {
          ok: true,
          server: { url, port, logsTail: () => tail, stop },
        }
      }
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS))
  }

  await stop()
  return {
    ok: false,
    reason: `server did not answer 200 on / within ${SERVE_READY_TIMEOUT_MS / 1000}s; last output:\n${lastLines(tail)}`,
  }
}

function lastLines(tail: string): string {
  return tail.split('\n').slice(-12).join('\n')
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => (port ? resolve(port) : reject(new Error('no free port'))))
    })
    probe.on('error', reject)
  })
}

/** Ownership marker beside the temp trees, so a later run can reap a crashed run's server. */
async function writeMarker(serverPid: number | undefined): Promise<string | null> {
  if (!serverPid) return null
  try {
    const dir = await mkdtemp(path.join(tmpdir(), MARKER_PREFIX))
    const file = path.join(dir, 'owner.json')
    await writeFile(file, JSON.stringify({ serverPid, ownerPid: process.pid }), 'utf8')
    return dir
  } catch {
    return null
  }
}

/**
 * Reaps servers whose owning driftwatch died. Same shape as the worktree sweep; the extra
 * paranoia is real: pids get reused, so a stale pid is only killed if it still looks like a node
 * process (via ps) — better to leak a rare server than to kill an innocent bystander.
 */
export async function sweepStaleServers(
  isNodeProcess: (pid: number) => Promise<boolean> = looksLikeNode,
): Promise<number[]> {
  const killed: number[] = []
  let entries: string[]
  try {
    entries = (await readdir(tmpdir())).filter((name) => name.startsWith(MARKER_PREFIX))
  } catch {
    return killed
  }

  for (const entry of entries) {
    const dir = path.join(tmpdir(), entry)
    try {
      const { serverPid, ownerPid } = JSON.parse(
        await readFile(path.join(dir, 'owner.json'), 'utf8'),
      ) as { serverPid?: number; ownerPid?: number }

      if (typeof ownerPid === 'number' && ownerPid !== process.pid && !alive(ownerPid)) {
        if (typeof serverPid === 'number' && alive(serverPid) && (await isNodeProcess(serverPid))) {
          try {
            process.kill(-serverPid, 'SIGKILL')
          } catch {
            try {
              process.kill(serverPid, 'SIGKILL')
            } catch {
              /* gone */
            }
          }
          killed.push(serverPid)
        }
        await rm(dir, { recursive: true, force: true })
      }
    } catch {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }
  return killed
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function looksLikeNode(pid: number): Promise<boolean> {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  try {
    const { stdout } = await promisify(execFile)('ps', ['-p', String(pid), '-o', 'command='])
    return /node|next/.test(stdout)
  } catch {
    return false
  }
}
