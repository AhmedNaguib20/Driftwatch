import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import type { Command } from '../detect/types.js'
import type { CommandOutcome } from './types.js'

/**
 * Runs a build/install command and times it.
 *
 * No shell: commands come from the profile as bin + args and are spawned directly, so nothing in a
 * repo's package.json can smuggle shell syntax past us into an interpreter we didn't intend.
 *
 * The environment driftwatch adds is part of the measurement protocol — the caller passes it in
 * explicitly and records it, so both sides of a comparison run with the same additions.
 */

const OUTPUT_TAIL_BYTES = 8_192

export interface RunOptions {
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly timeoutMs: number
}

export async function runCommand(command: Command, options: RunOptions): Promise<CommandOutcome> {
  const started = performance.now()

  return new Promise((resolve) => {
    const child = spawn(command.bin, [...command.args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let tail = ''
    const keep = (chunk: Buffer) => {
      tail = (tail + chunk.toString('utf8')).slice(-OUTPUT_TAIL_BYTES)
    }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)

    const timer = setTimeout(() => {
      tail += `\n[driftwatch] timed out after ${options.timeoutMs}ms — killed`
      child.kill('SIGKILL')
    }, options.timeoutMs)

    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({
        command,
        exitCode: null,
        durationMs: performance.now() - started,
        outputTail: `${tail}\n[driftwatch] failed to start: ${error.message}`.trim(),
      })
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        command,
        exitCode: code,
        durationMs: performance.now() - started,
        outputTail: tail.trim(),
      })
    })
  })
}

export function formatCommand(command: Command): string {
  return [command.bin, ...command.args].join(' ')
}
