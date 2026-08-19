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
**M2 — AI analysis — COMPLETE (eval green, `a5bad85`).** Triage → deep analysis → cause + confidence + suggested fix in the
terminal. Provider-pluggable (`src/ai/providers/`), DeepSeek first (OpenAI-compatible). Hard rule 6
applies in full: BYOK env key, `--no-ai` fully offline, docs state exactly what is sent.
  - [x] providers/ — transport-level `chat()` interface, one OpenAI-format client for
        deepseek+openai, key hygiene tested, strict-JSON with one corrective retry (`b02b12a`).
        Design note: the provider boundary is a JSON-completion transport; the semantic
        analyse shapes and all prompts live in `analyse/` — that is what enforces §7.1.
  - [x] analyse/ context assembly — deterministic, budgeted, secret-withholding, manifest
        (`b7f155e`)
  - [x] two-stage flow — versioned prompts (`prompts-v1.md`), calibration + magnitude arithmetic,
        fix rules enforced in code, every exit honest (`3ba3ff0`)
  - [x] surfacing + --no-ai + first-run UX (done; first-run UX verified live)
  - [x] live acceptance: Run A PASSED; Run B FALSE NEGATIVE → structural fix decided (spec §7.1c):
        triage is a suspect-ranker, never a gate — confirmed regressions always reach deep; small
        diffs (<~50 lines) ride inline in triage; magnitude rule: imports are multipliers.
  - [x] prompts v2 + de-gated pipeline (`5232516`) + eval set live (`a5bad85`) — all three cases
        PASS, run-b names lodash at 0.9 with the fix confined to the page. v2 is the eval baseline.
**M3 — GitHub Action adapter — COMPLETE (live proof: PR #4, comment 5336172502 told both truths in place).** Self-updating PR comment + non-blocking check, rendering
the same result JSON. Adapter consumes `--json` output only — the core/adapter boundary is already
lint-enforced; keep it that way.
  - [x] renderer — pure fn over schema 1.1, five goldens as contract, honest-omission rules
        (`76a8723`)
  - [x] API client — upsert w/ self-heal, checks + status fallback, publishResult never fails the
        user's CI (`73e4830`)
  - [x] action entry + init --github (`8e1adcd`) — setup errors exit 1 with the fix stanza
        (warn-only covers verdicts, not misconfiguration); base = pinned event SHA; runner labels
        via DRIFTWATCH_HOST_LABELS join the protocol hash
  - [x] live PR proof — same comment, both states, same URL; project-dir bug + Node-drift finding
        fixed en route. Install-order asymmetry → §5.1 sixth instance: cache state not provably
        equal ⇒ install delta not_comparable.
  - [x] markdown renderer (`76a8723`) — five goldens are the adapter contract; pipe-escaping in
        table cells; "why not higher" renders only held facts (omitted over padded — fabricated
        uncertainty is rule 3 in reverse); dead links omitted until their features exist.
  - [ ] GitHub API client (upsert + check) → action entry → live PR proof
**M4 — Real measurement, Layer 2a — COMPLETE (acceptance green ×3; 15 metrics; zero adapter changes needed — the schema contract held).** Boot the built app, measure routes. Order: serve +
readiness + request-level route latency first (no browser); browser metrics (Lighthouse) second.
Every §5.1 discipline applies: same-invocation pairs, medians, protocol recorded, refusal on
mismatch.
  - [x] serve + route latency (`f0b5bb8`, fixture `/live` route `7f1bc76`) — spread measured:
        dynamic routes rock-stable (4×4ms medians), statics are file-server noise. DECIDED:
        per-class quanta (route_latency: 5ms), dynamic/SSR routes prioritized, SSG excluded by
        default, route metrics non-key until Lighthouse lands.
  - [x] Lighthouse spread measured (`chrome/151`) — quantum rows decided (lcp/fcp 25ms, tbt 50ms,
        transfer 1KB), LIGHTHOUSE_WARMUP=1, warm-up law named (third occurrence), CI budget:
        wire now, revisit after one real CI run
  - [x] verdict wiring + acceptance: (a) unchanged ×2 all-quiet incl. screening; (b) +80ms handler
        → route metric + AI at 95% with arithmetic; (c) client lodash → LCP/transfer/bundle caught
        it, SSG-exclusion bet paid, TBT correctly under quantum. Fixes: excluded-vs-failed skips,
        predictProtocol parity (cache was silently dead with browser on). Per-route LH warm-up +
        SAMPLES 3→2 (net zero). run-d in the eval set.
**M5 — Trends + static dashboard (current).** JSON in a `perf-data` branch; static site reads it.
Carried-in backlog: LCP-jitter watch-item (collect CI spread passively); TBT machine-class note in
spec §5. (stderr streaming: fixed, `74d74af`.)
  - [x] perf-data branch + record mode (`5f9f72f`, install fix `8e190b8`) — validated live on the
        real repo: 2 entries, 16 metrics incl. Layer 2a, protocol identity per entry. Schema 1.2,
        verdict `recorded`.
  - [x] trend math (`1b89d6a`) — five-field segmentation between consecutive points, drift vs the
        shared quantumFor table, drift never crosses breaks, cumulative:null under 3 points,
        "drift"/"regression" language split. Real branch self-accumulating points per push.
  - [ ] static dashboard (renders step-2 structures only) → live proof

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
