import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { AI_KEY_ENV } from './tier.js'

const exec = promisify(execFile)

/**
 * Where the AI tier's key comes from (spec §9e step A) — and, just as importantly, where it must
 * never come from.
 *
 * Three sources, in order of how explicitly they say "use this key for driftwatch":
 *
 *  1. `DRIFTWATCH_API_KEY` — explicit, tool-specific, wins over everything.
 *  2. `key_command` in perf.yml — explicit for this project: a command whose STDOUT is the key
 *     (`op read op://vault/deepseek/key`). The output is used and never stored, never logged, and
 *     never written to the result JSON.
 *  3. A per-provider variable the user already has set for something else — `DEEPSEEK_API_KEY`,
 *     `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`. These are FALLBACKS: they say nothing about
 *     driftwatch, so they lose to anything that does.
 *
 * **A literal key in perf.yml is refused, never accepted-with-a-warning** — see `literalKeyInConfig`.
 * The absence of a key remains a normal state (the free tier), not an error.
 */

export type KeySource =
  | { readonly kind: 'env'; readonly name: string }
  | { readonly kind: 'key_command'; readonly command: string }
  | { readonly kind: 'none' }

export interface ResolvedKey {
  readonly key: string | null
  readonly source: KeySource
  /**
   * Set when a source was configured but could not produce a key — a `key_command` that failed,
   * or that printed nothing. Distinct from "no key configured": one is the free tier, the other
   * is a broken setup the user asked for and must be told about.
   */
  readonly problem: string | null
}

/** Per-provider variables users already have. Order is fixed so resolution is deterministic. */
export const PROVIDER_KEY_ENV: Readonly<Record<string, string>> = {
  deepseek: 'DEEPSEEK_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
}

export interface KeyConfig {
  readonly provider: string
  readonly key_command: string | null
}

export async function resolveAiKey(
  config: KeyConfig,
  env: NodeJS.ProcessEnv = process.env,
  run: (command: string) => Promise<string> = runKeyCommand,
): Promise<ResolvedKey> {
  const direct = env[AI_KEY_ENV]?.trim()
  if (direct) return { key: direct, source: { kind: 'env', name: AI_KEY_ENV }, problem: null }

  if (config.key_command?.trim()) {
    const command = config.key_command.trim()
    try {
      const output = (await run(command)).trim()
      if (!output) {
        return {
          key: null,
          source: { kind: 'key_command', command },
          problem: `key_command produced no output. It must print the key on stdout and nothing else.`,
        }
      }
      return { key: output, source: { kind: 'key_command', command }, problem: null }
    } catch (error) {
      return {
        key: null,
        source: { kind: 'key_command', command },
        // The command's own stderr is the useful part; a password manager says "not signed in".
        problem: `key_command failed: ${firstLine((error as Error).message)}`,
      }
    }
  }

  const fallback = PROVIDER_KEY_ENV[config.provider]
  const viaProvider = fallback ? env[fallback]?.trim() : undefined
  if (fallback && viaProvider) return { key: viaProvider, source: { kind: 'env', name: fallback }, problem: null }

  return { key: null, source: { kind: 'none' }, problem: null }
}

/**
 * Human phrasing for where a key came from — used by failure stanzas and by `doctor`.
 *
 * `redactCommand` drops the command text. A `key_command` is not a secret, but it is a VAULT
 * PATH — it names where the secret lives, which is exactly the thing worth not pasting into a
 * terminal a user is about to screenshot into a bug report. Diagnostics redact it; a stanza
 * telling the user what they configured does not need to.
 */
export function describeKeySource(source: KeySource, options: { readonly redactCommand?: boolean } = {}): string {
  switch (source.kind) {
    case 'env':
      return `the ${source.name} environment variable`
    case 'key_command':
      return options.redactCommand ? 'the key_command in perf.yml' : `perf.yml key_command (\`${source.command}\`)`
    case 'none':
      return 'nowhere — no key is configured'
  }
}

/**
 * Key-shaped values in perf.yml. **Refusing is the point:** perf.yml is committed, so a key in it
 * is already shared with everyone who can read the repo, and a warning would be read once and
 * ignored while the key stayed there. Someone will try it — the spec says so — and the tool's job
 * is to stop before the first run rather than to be right about it afterwards.
 *
 * Returns the offending key path, or null.
 */
export function literalKeyInConfig(record: Record<string, unknown>): { readonly field: string; readonly why: string } | null {
  for (const [field, value] of Object.entries(record)) {
    if (typeof value !== 'string') continue

    if (looksLikeApiKey(value)) {
      return {
        field,
        why: `its value looks like an API key (${maskKey(value)})`,
      }
    }
    // A field NAMED like a secret is refused even when the value is unrecognisable: we would
    // rather refuse a harmless string than let one real key through because it had no prefix.
    if (/^(api_?key|key|token|secret|password)$/i.test(field) && value.trim() !== '') {
      return { field, why: 'a field with this name holds a secret, and perf.yml is committed' }
    }
  }
  return null
}

/** Prefixes every provider we support (and the ones users may paste) actually issue. */
export function looksLikeApiKey(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.includes(' ')) return false // a command, not a key
  return /^(sk-|sk_|pk-|gsk_|xai-|AIza|ghp_|api-)[A-Za-z0-9_-]{12,}$/.test(trimmed)
}

/** Never print a key. Enough to recognise which one it was, not enough to use it. */
export function maskKey(value: string): string {
  const trimmed = value.trim()
  const head = trimmed.slice(0, Math.min(6, trimmed.length))
  return `${head}…${trimmed.length} chars`
}

export function literalKeyRefusal(field: string, why: string, configFile: string): string {
  return [
    `refusing to run: ${configFile} contains what looks like an API key.`,
    '',
    `  ${field}: ${why}`,
    '',
    `${configFile} is committed to your repository, so a key there is already shared with everyone`,
    'who can read it. Remove the value, then supply the key one of these ways:',
    '',
    `    export ${AI_KEY_ENV}=<your key>             # this shell, or your CI secrets`,
    '    key_command: op read op://vault/ai/key    # in perf.yml — the output is used, never stored',
    '',
    'Then rotate the key that was in the file: it should be treated as leaked.',
  ].join('\n')
}

async function runKeyCommand(command: string): Promise<string> {
  // Shell semantics on purpose: `op read …`, `pass show …` and `security find-generic-password`
  // are what people already have, and they are written as shell lines.
  const { stdout } = await exec(process.platform === 'win32' ? 'cmd' : '/bin/sh', [
    process.platform === 'win32' ? '/c' : '-c',
    command,
  ], { timeout: 20_000, maxBuffer: 1024 * 64 })
  return stdout
}

function firstLine(message: string): string {
  return message.split('\n').find((line) => line.trim() !== '') ?? message
}
