import { AI_KEY_ENV, DESTINATIONS } from '../core/index.js'
import { CONTEXT_SECTIONS } from './analyse/sections.js'
import { SECRET_BASENAME_PATTERNS } from './analyse/secrets.js'

/**
 * The privacy disclosure — GENERATED from the code that does the sending (spec §9e step E).
 *
 * This is the section a privacy-conscious reader judges the whole product by, which is exactly
 * why it is not prose someone maintains by hand. It is built from the context sections the
 * assembler emits, the secret patterns the filter enforces, and the provider table, and a test
 * fails if the README and this function disagree. Documentation that can drift from the code is
 * a claim, not a disclosure.
 *
 * Regenerate with:  UPDATE_README=1 npx vitest run tests/readme.test.ts
 */

export const DISCLOSURE_START = '<!-- disclosure: generated from src/ai/disclosure.ts — run `UPDATE_README=1 npx vitest run tests/readme.test.ts` -->'
export const DISCLOSURE_END = '<!-- /disclosure -->'

export function renderDisclosure(): string {
  return [
    DISCLOSURE_START,
    '',
    `**Nothing leaves your machine without an API key.** Measurement, comparison, verdicts, trends,`,
    'the dashboard and drift alerting are entirely local and always will be — that is the free tier,',
    'and it does not phone anywhere.',
    '',
    'With a key configured, exactly one thing sends data: **AI analysis of a confirmed regression.**',
    'It runs only when a regression was measured, analysis is enabled (no `--no-ai` /',
    `\`DRIFTWATCH_NO_AI=1\`), and ${AI_KEY_ENV} resolves to a key. \`--no-ai\` is enforced at the module`,
    'level — the AI code is never even loaded — which the test suite proves rather than promises.',
    '',
    '### Where it goes',
    '',
    ...DESTINATIONS.map((d) => `- \`provider: ${d.provider}\` → ${d.who}`),
    '',
    'Your key, your account, your provider\'s terms. Driftwatch adds no server of its own: there is no',
    'driftwatch backend, and no copy of your data is kept anywhere by this tool.',
    '',
    '### What is sent',
    '',
    'On an analysed regression, the request contains:',
    '',
    ...CONTEXT_SECTIONS.map((s) => `- ${s.discloses}`),
    '',
    '### What is withheld, always',
    '',
    'Files whose **basename** matches any of these have their content withheld. They still appear in',
    'the diffstat — the model may know the file changed; it may never see what is in it:',
    '',
    ...SECRET_BASENAME_PATTERNS.map((s) => `- ${s.label}`),
    '',
    'Also never sent, under any setting or budget:',
    '',
    `- your API key, the \`key_command\`, and that command's output`,
    '- binary file content (detected from content, not extension)',
    '- raw lockfile patches — only the package-level summary travels',
    '- absolute paths, and anything outside the diff between the base commit and your working tree',
    '',
    '### The receipt',
    '',
    'This section says what driftwatch does. Every run also records a `contextManifest` in the result',
    'JSON (`--json`) listing each file\'s fate — `full`, `truncated`, `diffstat-only`, `withheld` or',
    '`binary` — with reasons and token counts. That is what happened on **your** run, and it is the',
    'authoritative answer.',
    '',
    DISCLOSURE_END,
  ].join('\n')
}

