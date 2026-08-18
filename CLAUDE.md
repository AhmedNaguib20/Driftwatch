# Driftwatch

Measures code performance on every push, compares against a baseline, and uses AI to explain
regressions and suggest fixes.

Full reasoning lives in `specs/perf-tool-spec.md`. **Read it before making design decisions.**
This file is the short version — the rules that must hold in every session.

---

## Hard rules

1. **Core knows nothing about GitHub, CI, or any platform.** `src/core/**` must never import from
   `src/adapters/**`. Core takes input, returns JSON. Enforced by lint rule.
2. **Never touch the user's working directory.** No `git stash`, no checkout of their branch, no
   writing outside `.perf/`. Baseline builds happen in a `git worktree` in a temp dir. Losing
   someone's uncommitted work ends the product.
3. **Never report a number we didn't measure.** No estimates presented as measurements. If a metric
   failed to collect, say so — don't omit it silently.
4. **Deltas under 2% are noise.** Don't report them.
5. **Nothing leaves the machine except AI analysis**, and only with the user's own key. `--no-ai`
   must produce a fully offline run.
6. **The CLI is the product.** CI is one consumer of it. Every capability must work locally first.

---

## Stack

- TypeScript, Node 20+, ESM
- Single npm package `driftwatch`, run via `npx driftwatch`
- `commander` (CLI), `yaml` (config), `picocolors` (output — respect `NO_COLOR` and non-TTY)
- `vitest` for tests
- AI: provider-pluggable. DeepSeek during development (OpenAI-compatible API).
  Never write provider-specific logic outside `src/ai/providers/`.

## Structure

```
src/
  cli/            # command parsing, terminal rendering
  core/
    detect/       # stack + entrypoint detection → project profile
    measure/      # metric collectors
    baseline/     # git worktree, caching, comparison
    report/       # builds the result JSON (the contract everything else consumes)
  ai/
    providers/    # deepseek | anthropic | openai — one interface
    analyse/      # triage + deep analysis prompts
  adapters/
    github/       # Action entry, PR comment rendering, check status
specs/            # design docs — the source of truth
```

## Conventions

- Result JSON is the contract between core and every consumer. Version it from day one.
- Every measurement records: value, unit, how it was collected, and a confidence/noise flag.
- Errors never abort a run. A failed metric is marked `skipped` with a reason; the rest continue.
- Config file is `perf.yml` at repo root, fully optional — sensible defaults without it.

---

## Milestones

**M1 — Walking skeleton (current).** See "Definition of done" below.
**M2 — AI analysis.** Triage → deep analysis → cause + confidence + suggested fix in the terminal.
**M3 — GitHub Action adapter.** Self-updating PR comment + non-blocking check.
**M4 — Real measurement (Layer 2a).** Boot the app, measure routes with Lighthouse/Playwright.
**M5 — Trends + static dashboard.** JSON in a `perf-data` branch; static site reads it.

Do not start a milestone before the previous one's definition of done is met.

---

## M1 — Definition of done

`npx driftwatch run` inside a Next.js project:

1. Detects the stack and writes a `perf.yml` if absent.
2. Measures **build time** and **bundle size** for the working tree.
3. Checks out the base commit (default: `main`) into a `git worktree`, measures it the same way,
   caches the result keyed by commit SHA.
4. Prints a terminal table: metric, base, current, delta — deltas under 2% shown as "no change".
5. Exits 0 always (warn-only; `block_merge` is not implemented yet).
6. `--json` prints the result JSON instead.

**No AI in M1.** The point of this milestone is proving the measurement is stable enough to build
on: run it twice on an unchanged tree and the reported delta must be "no change" every time.

## Why M1 is first

The riskiest assumption in the whole product is that CI/local measurement is stable enough to
detect real regressions without crying wolf. If that fails, nothing downstream matters. Prove it
before building anything on top.
