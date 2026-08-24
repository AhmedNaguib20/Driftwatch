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

## What needs a key, and what doesn't

**Driftwatch measures for free, forever, with no API key.** Explanation is an optional tier that
runs on your own key. Nothing below the left column ever asks you for one, and a keyless run never
mentions the tier — except once, on a regression it could have explained.

<!-- feature-matrix: generated from src/core/tier.ts; a test fails if these drift apart -->

| Needs no key | Needs your own key |
| --- | --- |
| measurement, comparison, verdicts, thresholds | analysis (cause, confidence, evidence, suggested fix) |
| PR comment, CI check, step summary | verified auto-fix PRs |
| record, replay, movement report | `driftwatch eval` |
| trends, dashboard, drift alerting |  |

<!-- /feature-matrix -->

## AI analysis

When a run confirms a regression, driftwatch can explain it: triage decides whether the diff
plausibly explains the measured delta, deep analysis names the cause with a calibrated
confidence, cites its evidence, and suggests a fix. Bring your own key:

```bash
export DRIFTWATCH_API_KEY=<your DeepSeek or OpenAI key>
```

Driftwatch looks for the key in three places, in this order:

1. **`DRIFTWATCH_API_KEY`** in the environment — your shell, or your CI secrets.
2. **`key_command` in `perf.yml`** — a command whose stdout is the key, so a password manager can
   supply it and it never touches a file: `key_command: op read op://vault/ai/key`. The output is
   used and never stored, never logged, never written to the result JSON.
3. **A per-provider variable you already have set** — `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`,
   `ANTHROPIC_API_KEY`, matching the `provider` in `perf.yml`. These are fallbacks: they say
   nothing about driftwatch, so anything that does wins over them.

**Never put the key itself in `perf.yml`.** That file is committed, so a key in it is already
shared with everyone who can read the repository — driftwatch refuses to run if it finds one there
and tells you to rotate it. Provider and model are set in `perf.yml` (`provider: deepseek`,
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

## Trends — where has main been going?

PR runs answer "did this change regress?". Trend data answers a different question: every push to
the default branch is measured absolutely (record mode) and appended to a `perf-data` branch in
your own repo — plain Git, no backend. The branch also carries a self-contained `index.html`
dashboard: point GitHub Pages at `perf-data` / root and it is always current, or render it
locally:

```bash
npx driftwatch record          # measure this commit absolutely (no comparison, no AI)
npx driftwatch trend           # per-metric drift within the latest protocol segment
npx driftwatch dashboard --open
```

Trend language is *drift*, never "regression" — a drift is an observation over landed history, not
a verdict about one change. Timelines split into segments whenever the measurement protocol
changes (Node, platform, browser build, runner labels, driftwatch version); no line is ever drawn
across a break, and drift is only judged within one segment. Under 3 points is not a trend and is
reported as exactly that.

## Requirements

Node 20+, git. Next.js projects are supported today; more frameworks as milestones land.
Lighthouse metrics additionally need Chrome — in CI the generated workflow pins one
(see the workflow comments for why the pin exists and how to bump it deliberately).

## Environment variables

| Variable | Effect |
|---|---|
| `DRIFTWATCH_API_KEY` | Your provider key. Analysis runs only when it is set; nothing is sent without it. |
| `DRIFTWATCH_NO_AI=1` | Fully offline run — the AI module graph is never loaded. Same as `--no-ai`. |
| `DRIFTWATCH_HOST_LABELS` | Machine-class labels (CI runners set these). Present ⇒ CI browser-metric quanta; they also join the protocol identity, so a comparison never crosses machine classes silently. |
| `DRIFTWATCH_ALLOW_STALE=1` | Run a compiled build that is older than its source. Driftwatch refuses by default — a stale `dist/` once ran for five days while both the tool and its authors believed a fix was live. |
| `DRIFTWATCH_DEBUG_WIRE=1` | Print what actually crossed the wire to the AI provider: the request's `max_tokens`, and the response's `finish_reason`, `usage`, and content length. The API key is never among the logged fields. This is the flag that settled a failure misreported as "invalid JSON" for two milestones — when a model answer looks wrong, check the wire before changing a prompt. |
| `DRIFTWATCH_DEV=1` + `DRIFTWATCH_DEV_FIX_DIFF=<path>` | Development only: substitute a diff for the AI's suggested fix before verification, so the "a plausible fix that must NOT open a PR" case stays reproducible. Every surface stamps `devOverride`, so no output of such a run can pass as organic. |

### Which build am I running?

Every report identifies the build that produced it — terminal header, eval header, PR-comment
footer, and the `build` block of the result JSON:

```
driftwatch v0.6.0 (dist built 2026-08-24 07:29Z)   # the compiled binary
driftwatch v0.6.0 (from source)                    # tsx / vitest, running TypeScript directly
```

`npx driftwatch` rebuilds automatically (the `prepare` hook), so the common path cannot go stale.
Any path that skips the install — running `dist/` directly, or a checkout whose source has moved
since the last build — is refused with the exact command to fix it.
