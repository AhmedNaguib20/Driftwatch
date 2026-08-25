import { disclosureLine } from './disclosure.js'
import { describeKeySource } from './key.js'
import type { ResolvedKey } from './key.js'
import { AI_KEY_ENV, capabilitiesOf } from './tier.js'

/**
 * `driftwatch doctor` — the contract, and the half of it that needs no network (spec §9e step B).
 *
 * **It reports. It never fixes and never writes.** A diagnostic that changes things cannot be run
 * twice with the same meaning, and a user reaches for it precisely when they do not trust what is
 * happening.
 *
 * The key half lives in core so the keyless path never loads the AI module graph — the same rule
 * that makes `--no-ai` provable (hard rule 6). Provider checks live in `src/ai/doctor.ts` and are
 * imported only once a key has been found.
 *
 * **No key is not a failure.** It is the free tier working exactly as designed, reported as such,
 * exit 0. A user who never wanted AI must never see a red doctor.
 */

export type CheckState = 'ok' | 'warn' | 'fail' | 'info'

export interface DoctorCheck {
  readonly id: string
  readonly label: string
  readonly state: CheckState
  readonly detail: string
  /** Present on every failing check: what to do, in the stanza style (spec §9a). */
  readonly fix?: string
}

export interface DoctorReport {
  /** True when a key was found — not whether it works, which the provider checks decide. */
  readonly tierEnabled: boolean
  readonly checks: readonly DoctorCheck[]
  /** 0 when healthy AND when there is simply no key; 1 only when a configured thing is broken. */
  readonly exitCode: 0 | 1
}

export function reportFrom(checks: readonly DoctorCheck[], tierEnabled: boolean): DoctorReport {
  return { tierEnabled, checks, exitCode: checks.some((c) => c.state === 'fail') ? 1 : 0 }
}

/**
 * The key checks: is a key available, and where did it come from?
 *
 * Three outcomes, and the middle one is the one that earns this command its existence:
 *
 *  - a key, from a named source → ok
 *  - a source the user CONFIGURED that could not produce a key → **fail**. This is not the free
 *    tier; it is a setup they asked for and did not get, and reporting it as "no key" would hide
 *    a broken password-manager command behind a message about pricing.
 *  - nothing configured at all → info, and the free tier is described in full.
 */
export function keyChecks(resolved: ResolvedKey, provider: string): DoctorCheck[] {
  if (resolved.problem) {
    return [
      {
        id: 'key',
        label: 'API key',
        state: 'fail',
        // Redacted: a key_command names where the secret lives, and a diagnostic is the output
        // most likely to be pasted into an issue.
        detail: `configured via ${describeKeySource(resolved.source, { redactCommand: true })}, but it did not produce one — ${resolved.problem}`,
        fix: [
          'Run your `key_command` from perf.yml yourself and see what it prints.',
          '',
          'It must print the key on stdout and nothing else. A password manager that is not signed',
          'in usually says so on stderr — which is the line quoted above.',
        ].join('\n'),
      },
    ]
  }

  if (!resolved.key) {
    const free = capabilitiesOf('measurement').map((c) => c.label)
    return [
      {
        id: 'key',
        label: 'API key',
        state: 'info',
        detail: 'not configured — the free tier is fully working, and nothing below it needs one',
        fix: [
          `Everything driftwatch measures runs without a key: ${free.join('; ')}.`,
          '',
          'AI explanation is the optional tier. To turn it on:',
          '',
          `    export ${AI_KEY_ENV}=<your DeepSeek or OpenAI key>`,
          '',
          `Or, to keep it out of your shell history, put a command in perf.yml:`,
          '',
          '    key_command: op read op://vault/deepseek/key',
        ].join('\n'),
      },
    ]
  }

  return [
    {
      id: 'key',
      label: 'API key',
      state: 'ok',
      detail: `found, from ${describeKeySource(resolved.source, { redactCommand: true })} (provider: ${provider})`,
    },
    {
      // A privacy claim only a README reader ever sees is not a disclosure. Someone checking
      // whether the tier works is exactly the reader who should be told where their diff goes.
      id: 'destination',
      label: 'destination',
      state: 'info',
      detail: disclosureLine(provider),
      fix: 'README, "What leaves your machine", lists every field that travels and every one that never does.',
    },
  ]
}
