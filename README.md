# Driftwatch

Measures your project's build performance on every run, compares it against a baseline commit,
and — when a regression is confirmed — uses AI to explain what caused it and suggest a fix.

```bash
npx driftwatch run              # measure working tree vs main, print the verdict
npx driftwatch run --base dev   # different baseline
npx driftwatch run --json       # machine-readable schema-v1.1 result
npx driftwatch run --no-ai      # fully offline run — the AI code is never even loaded
npx driftwatch init             # detect the stack, write perf.yml
```

Exit code is always 0 (warn-only). Deltas under the 2% noise floor are reported as "no change";
both sides of every comparison are measured cold, in temp copies, under an identical recorded
protocol — never in your working directory.

## AI analysis

When a run confirms a regression, driftwatch can explain it: triage decides whether the diff
plausibly explains the measured delta, deep analysis names the cause with a calibrated
confidence, cites its evidence, and suggests a fix. Bring your own key:

```bash
export DRIFTWATCH_API_KEY=<your DeepSeek or OpenAI key>
```

The key lives in that environment variable only — never in `perf.yml`, never on disk, never in
the result JSON. Provider and model are set in `perf.yml` (`provider: deepseek`,
`model: deepseek-chat`). Token counts and an estimated cost are printed with every analysis.

## What leaves your machine

**Nothing, unless AI analysis actually runs.** It runs only when: a regression was confirmed,
AND analysis is enabled (no `--no-ai` / `DRIFTWATCH_NO_AI=1`), AND `DRIFTWATCH_API_KEY` is set.
Everything else — detection, measurement, baseline comparison — is fully local. `--no-ai` is
enforced at the module level: the AI code is never loaded, which the test suite proves.

When analysis does run, the request to your chosen provider contains exactly:

- the measured verdict, metric values, raw samples, and both measurement protocols
- the detection evidence trail (which files told us what — e.g. "framework: nextjs [package.json]")
- a **diffstat** of every changed file between the base commit and your working tree (+/- counts)
- **full patches** for the most-relevant changed files, within a fixed token budget
- a **package-level summary** of lockfile changes (added/removed/bumped with versions)

Never sent, regardless of budget:

- **secret-pattern files** — content withheld, diffstat line only. The patterns (matched on the
  file's basename, case-insensitive): `.env` and `.env.*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`,
  `*.jks`, `*.keystore`, `id_rsa*` / `id_dsa*` / `id_ecdsa*` / `id_ed25519*`, `.netrc`,
  `.npmrc`, anything containing `credential`, `secrets`/`secret.*`
- **binary file content** (detected from content, not extension)
- **raw lockfile patches** (only the package summary travels)
- absolute paths, usernames, timestamps, or your API key

Every run records a `contextManifest` in the result JSON (`--json`) listing each file's fate —
`full`, `truncated`, `diffstat-only`, `withheld`, or `binary` — with reasons and token counts.
The manifest is the authoritative per-run answer to "what was sent"; this section is its
standing summary, and the test suite keeps the two in sync.

## Requirements

Node 20+, git. M1/M2 support Next.js projects; more frameworks as milestones land.
