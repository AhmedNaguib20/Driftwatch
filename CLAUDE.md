# Driftwatch

Measures code performance on every push, compares against a baseline, and uses AI to explain
regressions and suggest fixes.

Full reasoning lives in `specs/perf-tool-spec.md`. **Read it before making design decisions.**
This file is the short version — the rules that must hold in every session.

---

## Hard rules

1. **Core knows nothing about GitHub, CI, or any platform.** `src/core/**` must never import from
   `src/adapters/**`. Core takes input, returns JSON. Enforced by lint rule.
2. **Never touch the user's working directory. No exceptions.** No `git stash`, no checkout of their
   branch, no deleting generated dirs, no writing outside `.perf/`. **Both** sides of a comparison
   are measured in temp copies — the base via `git worktree`, the current tree via a filtered copy.
   The rule is absolute because one exception becomes many.
3. **Never report a number we didn't measure.** No estimates presented as measurements. If a metric
   failed to collect, say so — don't omit it silently.
4. **Deltas under 2% are noise.** Don't report them.
5. **Protocol symmetry.** Both sides of a comparison must be measured under an identical, recorded
   protocol; where they can't be identical, force both to the state achievable on both. Clear the
   build cache on both sides (`build time (cold)`). Refuse to report a delta across mismatched
   protocols — flag it instead. See spec §5.1.
6. **Nothing leaves the machine except AI analysis**, and only with the user's own key. `--no-ai`
   must produce a fully offline run.
7. **The CLI is the product.** CI is one consumer of it. Every capability must work locally first.

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

- **Small, focused files.** One module does one thing; split before a file grows past ~200 lines.
  Prefer several clear functions over one clever one. Readability beats brevity; no dead code, no
  speculative abstractions for future milestones.
- Result JSON is the contract between core and every consumer. Version it from day one.
- Every detection conclusion carries its evidence (which file, what it said). The AI stage will
  cite this trail; preserve it through every transformation.
- Every measurement records: value, unit, how it was collected, and a confidence/noise flag.
- Errors never abort a run. A failed metric is marked `skipped` with a reason; the rest continue.
- Config file is `perf.yml` at repo root, fully optional — sensible defaults without it.

---

## Milestones

**M1 — Walking skeleton — COMPLETE (`517de82`, 100 tests).** Acceptance passed: fresh run and
cached/screened run both report "no change" on an unchanged tree; a real regression escalates to a
fresh same-invocation confirm. Timing quantum added: deltas under 100ms absolute are noise
regardless of percentage.
  - [x] Scaffold, boundary lint rule, Next.js fixture (commit `4adad5a`)
  - [x] Stability of build measurement validated: 1.2% warm / 0.0% cold spread
  - [x] `detect/` — project profile with per-conclusion evidence trail (commit `7358e9c`)
  - [x] `measure/` — temp-copy workspace, median of 3, protocol recorded (commit `9955fdd`)
  - [x] `baseline/` — worktree via same measure path, lockfile rule, (SHA, protocol) cache,
        crash-safe sweep (commit `1484c20`)
  - [x] `report/` — schema v1, five verdicts, §5.1 refusal, golden-file contract (commit `0f0567d`)
  - [ ] cli/ — plus warm-up sample + confirm-before-report escalation (spec §5.1 fifth instance)
**M2 — AI analysis (current).** Triage → deep analysis → cause + confidence + suggested fix in the
terminal. Provider-pluggable (`src/ai/providers/`), DeepSeek first (OpenAI-compatible). Hard rule 6
applies in full: BYOK env key, `--no-ai` fully offline, docs state exactly what is sent.
  - [x] providers/ — transport-level `chat()` interface, one OpenAI-format client for
        deepseek+openai, key hygiene tested, strict-JSON with one corrective retry (`b02b12a`).
        Design note: the provider boundary is a JSON-completion transport; the semantic
        analyse shapes and all prompts live in `analyse/` — that is what enforces §7.1.
  - [ ] analyse/ context assembly → two-stage flow → surfacing
**M3 — GitHub Action adapter.** Self-updating PR comment + non-blocking check.
**M4 — Real measurement (Layer 2a).** Boot the app, measure routes with Lighthouse/Playwright.
**M5 — Trends + static dashboard.** JSON in a `perf-data` branch; static site reads it.

Do not start a milestone before the previous one's definition of done is met.

---

## M1 — Definition of done

`npx driftwatch run` inside a Next.js project:

1. Detects the stack and writes a `perf.yml` if absent.
2. Measures **build time** and **bundle size** for the working tree.
3. Checks out the base commit (default: `main`) into a `git worktree`, measures it **through the
   same measurement path as the working tree**, caches the result keyed by (commit SHA, protocol
   hash) — a protocol change invalidates the cache.
4. Prints a terminal table: metric, base, current, delta — deltas under 2% shown as "no change".
5. Exits 0 always (warn-only; `block_merge` is not implemented yet).
6. `--json` prints the result JSON instead.

**No AI in M1.** The point of this milestone is proving the measurement is stable enough to build
on. Acceptance: run it twice on an unchanged tree and the reported delta must be "no change" every
time — **including the second run, where the base comes from cache**. Time-based deltas are never
reported across a time gap: a cached-base comparison that crosses the floor escalates to a fresh
same-invocation re-measure of both sides and reports only the confirmed result (spec §5.1, fifth
instance).

## Why M1 is first

The riskiest assumption in the whole product is that CI/local measurement is stable enough to
detect real regressions without crying wolf. If that fails, nothing downstream matters. Prove it
before building anything on top.
