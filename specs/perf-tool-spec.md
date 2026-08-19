# Driftwatch — Project Spec

*Working name. CLI command: `npx driftwatch run`*

> Living document. Update it whenever a decision is made or changed.
> Version 19 — 2026-08-19 — M2 complete; M3 in progress (renderer done, API client next)

---

## 1. Vision

A tool that plugs into a project's CI pipeline and, on every push:

1. **Measures** code performance — real, executed measurement, not prediction.
2. **Compares** the result against a baseline (previous push / main branch).
3. **Explains** — when a regression is detected, uses AI to identify which code change caused it.
4. **Suggests** a concrete fix.

### The differentiator

Existing tools (github-action-benchmark, Bencher, CodSpeed) tell you *that* performance dropped.
They do not tell you *why* or *how to fix it*. That gap — **code → performance → fix**, inside the CI
loop — is the product.

### Explicit non-goal

Do **not** compete with Datadog / New Relic on general production monitoring. Stay in the CI /
pre-merge niche.

---

## 2. Core Product Principles

| Principle | Meaning |
|---|---|
| Works on any codebase | No language lock-in. Value on day one, any repo. |
| Runs anywhere | Local terminal first; CI platforms are adapters over the same core. |
| Near-zero config | User writes no config. The tool detects and generates its own. |
| Measured, not guessed | Every claim is backed by a number we actually observed. |
| Honest confidence | Never state a cause with false certainty. Surface a confidence level. |
| Prioritized, not overwhelming | Show the top 3 issues by impact, not a list of 40. |

**Trust is the whole product.** One confidently wrong root-cause analysis destroys credibility.

---

## 3. Architecture

### 3.1 Core / adapter split — the load-bearing decision

Two things get conflated and must not be:

| | Knows about | Contains |
|---|---|---|
| **Core** (platform-agnostic) | nothing about GitHub, CI, or hosting | detection, measurement, baseline comparison, AI analysis |
| **Adapters** (thin) | one platform each | how it's invoked, where the diff comes from, where results are published |

The core is a **standalone CLI that outputs structured JSON**. It never knows what a "PR comment"
is — an adapter turns JSON into a comment. Adding a platform is then days of work, not months.

**Three things quietly create GitHub lock-in — avoid all three:**

1. **Result storage.** Storing JSON in a `perf-data` branch is portable (plain Git). Using GitHub
   Artifacts or Pages is not. Stay on Git.
2. **Output formatting.** Core emits JSON only. Each adapter renders it.
3. **Auth.** GitHub App vs tokens vs Azure service connections differ the most and generalise the
   least. Keep every credential path inside the adapter.

**Strategy: ship the `github` adapter only.** GitHub holds most open source and most small/medium
teams — the launch market. Azure DevOps means large enterprises, who buy through sales and security
review, not through an MVP. Build the split now; build other adapters when there's demand.

### 3.2 Local-first CLI

**The CLI is the product; CI is one consumer of it.** This is a framing decision, not a feature —
the tool is not "a CI product with a local mode."

```
npx driftwatch run          # measure working tree vs HEAD, print to terminal
npx driftwatch run --base main
npx driftwatch run --json   # machine-readable, for scripting and adapters
npx driftwatch init         # detect stack, write perf.yml
```

Requirements:

- **Zero install to try** — `npx` (and equivalents per ecosystem). No account, no signup, no push.
- **Nothing leaves the machine** except AI analysis, and only with the user's own key (BYOK).
  Explicitly document what is sent. Support `--no-ai` for a fully offline run.
- **Same core, same numbers** as CI. A local run and a CI run of the same commit must agree.
- **Results cached** in `.perf/` (auto-added to `.gitignore`) so repeat runs are fast.

#### Why this matters commercially

This is the funnel, not a convenience. A developer runs one command, sees real numbers about their
own project in a minute, and *then* installs the CI integration. Try-before-install removes the
hardest step in adoption: nobody has to be convinced to add a bot to their repo before seeing value.

#### Local-specific problems to solve

- **Baseline locally.** Comparing working tree against `main` means building both. Use
  `git worktree` to check out the base into a temp dir and build there — never stash or touch the
  user's working directory. Losing someone's uncommitted work once ends the product.
- **Noise is worse than in CI.** A laptop with Chrome, Docker, and a dev server running is a hostile
  measurement environment. Same mitigations as §5 plus: detect high background load and label the
  run "noisy" rather than reporting a confident delta.
- **First run is slow** (two builds). Cache the base result keyed by commit SHA, so the second run
  onward compares against cache and finishes fast. Say what's happening while it runs.

#### Terminal output

Same content hierarchy as the PR comment (§6.1): verdict line, changed metrics only, cause with
confidence, suggested fix. Colour-coded, aligned, respects `NO_COLOR` and non-TTY output.

### 3.3 Detection-first

On install (or on `init`), the tool scans the repo (`package.json`, `requirements.txt`, `go.mod`,
lockfiles, CI config) and infers language, framework, package manager, build commands, and entry
points. It then generates one file:

```yaml
# perf.yml (auto-generated — edit only if you want to)
detect: nextjs
measure: [build_time, bundle_size, test_timings, api_latency]
threshold: 5%
block_merge: false   # warn only; teams opt in to blocking
provider: deepseek   # deepseek | anthropic | openai — pluggable (§7.1)
model: deepseek-chat # user-overridable (BYOK — their key, their choice)
```

Model to imitate: **Dependabot** — it works before you ask it to.

### 3.4 Baseline behaviour

The first run after installation **is** the baseline. Project age is irrelevant — a 5-year-old repo
works exactly like a new one.

---

## 4. Measurement — three layers

**Decided: the product measures by executing code. Static-only analysis was considered and
rejected as the core (see §9).**

### Layer 1 — Universal metrics (day one, every repo, nothing new to run)

These are read from work the CI **already performs**. We add no new steps, we just record numbers:

- build time
- output / bundle size
- test suite runtime
- install time, memory usage during build

Indirect signals — they prove something changed, not how fast the code runs. Their job is instant
coverage and trend data on any repo.

### Layer 2 — Real performance measurement

**Design constraint that drives the ordering below: most target repos have no usable test suite.**
A repo with good coverage usually belongs to an organised team that already owns perf tooling. The
5-year-old repo with no tests is the one actually in pain — and it is the larger market. Nothing in
Layer 2 may *depend* on tests existing.

#### 2a — Run the app (primary entry point)

Build the project, boot it, and drive it. No tests required — only an entry point, which the
detector can infer (Next.js routes come straight from the file structure).

| Kind | What it measures | How |
|---|---|---|
| Browser-level | LCP, TBT, interaction latency per route | Lighthouse / Playwright |
| Request-level | latency, throughput per endpoint | boot the server in CI, drive load |

This works identically on repos with and without tests, and it lands on JS/TS — the first adapter.
**This is the MVP's real-measurement path.**

#### 2b — Per-test timings (bonus, when tests exist)

Time each test individually and compare across pushes. Where a suite exists this is free: tests
execute real code, giving hundreds of measurement points with zero config and nothing new for the
user to write. A test that suddenly slows 40% points straight at the responsible code.
Valuable, but **never a prerequisite**.

#### 2c — AI-generated benchmarks (opt-in)

AI reads the codebase, identifies the hottest functions (frequently called, loop-heavy,
data-processing), and opens a PR containing ready benchmark files for review.

> **Trap to handle explicitly:** generated benchmarks need invented input data. A benchmark built
> around a 10-element array when production passes 10,000 will report a slow function as fast. The
> UI must label generated inputs as synthetic and make them easy to edit.

#### 2d — Build-time profiling

Even with no tests and no entry point, the build itself executes plenty of code — which stage costs
time, where memory spikes. Weakest signal, but always available.

**Framing opportunity:** when a repo has no tests and no obvious entry point, don't fail — offer.
*"This project has no tests. Precise measurement needs an entry point — want me to open a PR with a
smoke test?"* Absence of tests becomes an onboarding moment rather than a dead end.

**Adapter order:** JS/TS first (largest market, our home turf), then Python, then Go/Rust.

### Layer 3 — Instruction counting (opt-in, precision tier)

Run code inside a simulator (Valgrind / cachegrind) and count CPU instructions instead of measuring
seconds.

- **Why:** the number is deterministic regardless of machine load, so a 1% change is detectable with
  full confidence. This is what CodSpeed built its product on.
- **Cost:** code runs 20–50× slower under the simulator; measures CPU work only, so it misses I/O
  and network effects.
- **Status:** opt-in, for teams where performance is critical.

---

## 5. The CI noise problem

Shared CI runners vary 20–30% run to run on identical code. False alarms would kill the tool within
a week. Three mitigations, in increasing strength:

1. **Multiple runs, take the median. (IMPLEMENTED — median of 3, decided at M1 step 2.)**
   Single samples spread 2.25–4.5% on the fixture — a lone sample cannot stay inside the 2% floor.
   The first build after a fresh `node_modules` clone is systematically ~25% slower (cold OS page
   cache); the median discards that warm-up identically on both sides. Raw samples ride in the
   result (`sampleValues`) so consumers can see the spread. `BUILD_SAMPLES = 3` is a code constant,
   not config — like the noise floor, it is a property of the instrument, not a preference.
   Cost: ~35s per side instead of ~13s.
2. **Measure baseline and PR in the same job on the same machine — and in the same invocation.**
   Cancels most machine variance. Same-invocation pairs measure consistently under 1% apart; the
   same machine drifts several percent over an hour (thermals, background load), so "same machine"
   alone is not enough. **No reported delta may span a time gap** — see §5.1 fifth instance.
3. **Instruction counting (Layer 3).** Eliminates the problem entirely for CPU-bound work.

Anything below a ~2% delta is treated as noise and not reported. **Additionally, each metric class
carries its own absolute quantum — the instrument's resolution, a code constant, never config**
(generalized at M4 step 1 from the M1 build quantum):

| Metric class | Quantum | Basis (measured) |
|---|---|---|
| `build_time` | 100 ms | 15ms builds spread 43% run-to-run; process-spawn territory |
| `route_latency:*` | 5 ms | observed ±1ms sampling noise (same-process sequential fetch), ×5 |
| `lcp:*`, `fcp:*` | 25 ms | ≤7ms spread across boots on 1.7s values (simulated throttling); relative floor governs above 1.25s |
| `tbt:*` | 50 ms | values quantize near zero (±2ms on ~2ms); real TBT regressions are tens-to-hundreds ms |
| `transfer_size:*` | 1 KB | ±2 **bytes** observed; ≥1KB is a real asset change |

A single global quantum would gut whichever class it wasn't calibrated for — 100ms would suppress a
4ms route regressing 25×. A 4ms route now reports at ≥9ms (+125%); a 200ms route at +2%.

**The warm-up law (named at M4 step 2, third occurrence):** *every fresh execution context runs its
first iteration slow — discard it.* Builds (cold OS page cache, +25%), servers (JIT/module warm-up,
6→4ms), and now Lighthouse traces (first run after boot: LCP 2707ms vs 1702 steady). One discarded
warm-up per context per side (`LIGHTHOUSE_WARMUP = 1`, ~+5s) so the median never depends on
absorbing a +1000ms outlier. Simulated throttling vindicated: trace-computed LCP/FCP spread ≤7ms on
1.7s values across independent boots.

**Warm-up law, per-route (M4 acceptance):** the LH warm-up initially touched only the first route —
a fresh boot's *second* route can still trace hot once (observed: a base-side LCP outlier reported a
fake −8.7% "improvement"; no verdict impact, but a reported-delta artifact). Decision: **per-route
warm-up + `LIGHTHOUSE_SAMPLES` 3→2** — the law applied at the correct granularity (the fresh context
is the per-route trace), and since the spread data already showed 2 samples stay in noise once
warmed, net run count per route is unchanged (1+2 = 3). Correct estimator, ~zero added wall-clock.

**Acceptance-flushed fixes (M4):** policy skips (`excluded: true` — SSG/dynamic/cap/user-disabled)
no longer gate the verdict; only real failures (boot/build) make a run inconclusive. And
`predictProtocol` must stay parity-locked with measured protocols (a `browser: none` default left
the base cache silently dead — every run re-measured; caught only via `measurementPath` in the
JSON). A Chrome upgrade stranding caches is intended behaviour, now test-asserted.

**CI wall-clock stance (M4 step 2):** wire now, revisit after **one real CI observation**. Never
pre-trim on a projection.

**The observation (PR #5, M4 close):** total job 7m18s; Layer 2a ≈ **55s/side on CI** — comfortably
inside the guardrail; **no trimming warranted**. The dominant cost is build sampling (~128s/side,
63% of the job; the runner builds 3.5× slower than local) — an M1 decision, not a Layer 2a problem.
Per-class behaviour on the runner: `transfer_size` byte-identical across environments (the fully
deterministic class); **TBT is machine-class-local** — ~140ms on CI vs 1–2ms locally (simulated
throttling computes from the observed trace; slow CPU inflates it), cross-side spread ±8ms under
the quantum, cross-environment already refused via hostLabels — contained by design, but TBT values
only mean anything within one machine class; route quantum absorbed 4× runner noise as calibrated;
LCP at 1.9s values is governed by the 2% floor over the 25ms quantum (the layering working) — LCP
wobble is a **watch-item**, one observation isn't spread data.

**Eval-history reading rule (M4 close):** temperature-0 DeepSeek still varies between invocations
(run-c passed at 0.9 then 0.7, same correct cause). Confidence bands in expected.json exist for
exactly this; when comparing eval runs over time, judge pass/fail and cause quality, not exact
confidence values. (Eval replays captured measurement data — measurement changes can't shift it;
only prompts and provider can.)

**Route-latency scope note (M4 step 1):** request-level latency on prerendered (SSG) routes
measures the file server, not the app — 1–2ms responses where ±1ms is 50–100% relative. Route
selection therefore prioritizes dynamic/SSR routes; prerendered routes are excluded from
`route_latency` by default (their regressions surface in `bundle_size`, and client-side cost lands
with Lighthouse). Warm-up-then-median holds for servers exactly as for builds: every fresh boot runs
6→5ms before settling at 4 (JIT/module warm-up) — §5.1's pattern, discarded identically. K=5 with
1 warm-up, sequential fetches only (parallel requests contend). Route metrics stay non-key until
the full Layer 2a picture exists.

### 5.1 Protocol symmetry — the general law

**Both sides of a comparison must be measured under an identical, explicitly recorded protocol.
Where the two sides cannot be made identical, the protocol is forced to the state that *is*
achievable on both.**

Run-to-run jitter (§5) is only half the noise problem. The other half is **asymmetry**: two sides
measured under different conditions produce a large, perfectly repeatable, completely fake delta.
Jitter is visible and noisy; asymmetry is invisible and looks like a real finding. It is the more
dangerous of the two.

Every result must record *how* each side was collected, and the tool must refuse to report a delta
when the two protocols don't match — flag it instead.

#### First instance: build cache (DECIDED — measured 2026-08-18)

Measured on the M1 Next.js fixture, 5 runs:

| Mode | Times | Spread |
|---|---|---|
| Warm (`.next` kept) | 6.81s, 6.80s, 6.88s | 1.2% |
| Cold (`.next` removed) | 8.75s, 8.75s | 0.0% |
| **Warm vs cold** | | **22% apart** |

Each mode is stable well inside the 2% floor — **M1's core assumption holds.** But a fresh
`git worktree` baseline can never be warm, while the working tree usually is. Comparing as-is
reports a 22% regression on identical code.

**Decision: clear the build cache on both sides before every measured build.** It is the only state
achievable on both. Costs ~2s.

Two things this buys beyond symmetry:
- Cold builds are the **more sensitive** instrument — a warm build hides cached work, so a
  regression in already-compiled code wouldn't surface at all.
- The number must be **labelled `build time (cold)`** in output. It is a comparison instrument, not
  the build time the developer experiences daily. Presenting it as the latter is its own kind of
  lying.

#### How symmetry is achieved: measure both sides in temp copies (DECIDED)

Forcing a cold build on the working tree appears to require deleting the user's `.next` — putting
hard rule 5 in direct conflict with hard rule 2 (never touch the working directory).

**Resolution: don't measure the working tree in place. Copy it to a temp dir and measure the copy,
exactly as the baseline worktree is measured.**

Rejected alternatives: deleting `.next` in place (fast, but carves an exception into rule 2 —
once the tool may modify the working directory *under some conditions*, that principle is gone);
moving it aside and restoring (preserves the cache, but a crash mid-run leaves the user's project in
a state the tool created).

*Why the expensive option wins:*

- **Symmetry becomes structural, not disciplinary.** Both sides are temp copies built the same way,
  so protocol equality holds by construction. Per §5.1, asymmetry is the *invisible* failure mode —
  "we'll revisit if we see the two sides behave differently" is not a viable detection strategy,
  because you won't see it.
- **Rule 2 stays absolute.** A rule with no exceptions is enforceable; a rule with one exception
  accumulates more.
- **It closes asymmetries beyond the cache** — stray editor artifacts, local untracked files, build
  tools that bake in absolute paths.
- **The cost is small.** Excluding `node_modules`, `.next`, and `.git`, a source tree copy is
  typically under a second against an 8s cold build.

*Implementation requirements:*
- The copy must faithfully represent uncommitted state — including untracked-but-not-ignored files.
  `git archive` alone is insufficient.
- Apply the `node_modules` rule below to the copy, same as to the worktree.
- Some tooling reads `.git` (release detection, version stamping). Detect that case and handle it
  explicitly rather than silently producing different behaviour on the copy.

#### Third instance: the baseline cache (decide at M1 step 3)

Base-side results are cached keyed by commit SHA — but a cached number is only reusable if it was
measured **under the same protocol**. A base measured last month on Node 20 compared against today's
current side on Node 22 is a protocol mismatch wearing a cache hit as a disguise.

**Rule: the cache key is `(commit SHA, protocol hash)`** — the protocol hash covering node version,
platform/arch, sample count, cache/install state, and the measuring tool's own version. A protocol
change silently invalidates old entries; stale entries are re-measured, never compared against.

#### Second instance: `node_modules` (decide at M1 step 3)

A worktree has no `node_modules`, and install time is far noisier than build time. Proposed rule —
**let the lockfile decide**:

- **Lockfile identical between base and current** → dependencies are not what changed. Clone the
  existing `node_modules` into the worktree (copy-on-write where available — never symlink: builds
  write caches through a symlink into the real tree), skip install entirely, measure build only.
- **Lockfile differs** → dependencies *are* part of the change and must be measured. Fresh install
  on both sides, and flag "dependencies changed" in the result so the AI stage knows.

Install time stays a **separate metric**, never folded into build time.

*Implemented notes (M1 step 3):* install is measured as a **single sample** — a repeat install hits
the package manager's machine-wide cache and measures something else, and clearing that cache is
off-limits (it belongs to the user, not the tool). The shared-cache caveat rides in `collectedBy`.
No lockfile at all → `dependenciesChanged: null` — unknown is reported as unknown.

#### Fourth instance: path-embedding build output (DECIDED — found at M1 step 3)

Build tools bake **absolute paths and run diagnostics into their output**: Next.js `.nft.json`
dependency traces, source maps, `required-server-files.json`, and a ~500KB `.next/trace` of
run-dependent timing. Two consequences on temp-copy measurement:

- Bundle size differed 1.3% on identical code, perfectly repeatably, because the two sides' temp
  paths had different lengths. **This is the §5.1 signature: stable, plausible, fake.**
- Fixes: (a) both sides' temp layouts mirror each other — same-length prefixes, identical suffix
  (`driftwatch-curr-XXXXXX/tree/<path>` vs `driftwatch-base-XXXXXX/tree/<path>`); (b) run-dependent
  diagnostics (`trace`) are excluded from weighing as diagnostics-not-output.

This is a general phenomenon, not a Next.js quirk — expect it in every ecosystem adapter.

#### Fifth instance: temporal drift — the cache is a screening tool (DECIDED — M1 step 4)

Found running the unchanged fixture twice: fresh-vs-fresh was clean, but fresh-current vs
**cached** base reported −4% to −8% build deltas. Two causes: the OS warm-up occasionally bleeds
into sample 2 (contaminating the median), and the machine itself drifts ~4% over an evening. A
cached base is measured at a different time — the **temporal** version of the asymmetry §5.1 kills.

**Decision (A + C):**

- **A — warm-up sample.** One discarded build before the 3 measured samples, both sides. A
  contaminated median is an estimator bug, full stop. Cost ~+9s/side.
- **C — confirm-before-report.** Cached-base comparison is a **fast screening path only**. If every
  metric is under the floor → report "no change" (the common case, stays fast). If any metric
  crosses the floor → re-measure **both sides fresh in the same invocation** and report only the
  confirmed result. A suspected regression pays ~70s for a temporally-local comparison; a confirmed
  delta never spans a time gap. The fresh base measurement replaces the cache entry.

Rejected: widening the floor for cached comparisons — honest but blunts the instrument; a real 4%
regression becomes invisible whenever the cache is warm.

Bundle size is immune to all of this (byte counts don't drift); the escalation applies to
time-based metrics only.

#### Sixth instance: install-order cache asymmetry (DECIDED — M3 live proof)

On CI, install time reported −38.8% "improvements" on **unchanged** dependencies: within one run,
the base side installs first (cold package-manager cache), current second (warm). §5.1-shaped:
stable, plausible, pure artifact. **Decision: when the package-manager cache state cannot be shown
equal between sides, the install delta is `not_comparable` ("package-manager cache state differs
between sides") — values still reported, no delta, never a percentage.** A warm-up install was
rejected: doubling install cost for a contextual metric that never drives the verdict buys nothing.

#### Cache integrity rules (M1 step 3)

- **Failed builds are never cached.** A transient OOM must not become the permanent truth about a
  SHA.
- `DRIFTWATCH_VERSION` in the protocol hash is the **methodology version**: released bumps strand
  stale entries correctly. Within a dev iteration, changing a collector's meaning requires clearing
  `.perf/` by hand — acceptable for development, but any released change to what a metric means MUST
  bump the version.
- `.perf/.gitignore` containing `*` keeps the cache out of version control without touching the
  user's `.gitignore` (rule 2).

**DECIDED — runs inside the user's own CI.** Instruction counting removes machine variance without
dedicated hardware, so the accuracy argument for owning infrastructure no longer holds. Cheaper for
us, simpler for the user, and consistent with the data-stays-in-your-repo model (§6.3).

---

## 6. Output surfaces

Principle: **deliver the result to the developer, don't wait for them to come to it.** Developers
live in the PR, not on our website.

### 6.1 PR comment — primary surface (build first)

A single comment that **updates itself in place** on every push (never a new comment per push).
Structure:

- one-line verdict at the top (what happened, which threshold was crossed)
- comparison table — only changed metrics, plus explicit "no change" rows so the user knows we
  looked
- AI root cause with a visible confidence level, and a collapsed section explaining **why not
  higher** — stating what we could not isolate
- suggested fix as a ready diff, with expected saving in numbers
- heavy detail inside collapsed `<details>` blocks — including "what was sent to the AI provider"
  (the contextManifest as reader-facing accounting)
- the "why not higher" block renders **only facts we hold** (remaining suspects, truncation,
  downgrades) and is omitted entirely when there is nothing honest to say — boilerplate uncertainty
  is fabrication in reverse
- footer: baseline commit, trend link, open-fix-PR link, adjust-threshold link

Mockup built: `pr-comment-mockup.html`.

*Implemented (M3 step 1, `76a8723`):* pure renderer over schema 1.1; five golden files are the
adapter's contract. Judgment calls recorded: **"Why N% and not higher" renders only facts we hold**
(remaining ranked suspects, truncated context, downgraded fixes) and is omitted at ≥0.9 or when
empty — boilerplate uncertainty would be rule 3 in reverse; mockup links to unbuilt features
(trend, open-fix-PR) omitted rather than dead; `|` in skip reasons escaped (markdown-table
explosion bug caught by golding); fork-PR no-key line renders the measurement as standing on its
own; marker `<!-- driftwatch:comment -->` leads every rendering for upsert targeting.

#### API client notes (M3 step 2, `73e4830`)

- Rate limits: one retry honouring `Retry-After`, **capped at 30s** — beyond that it's an outage,
  and hanging the user's CI job to wait out a window is worse than reporting it. Both 429 and
  GitHub's 403-with-remaining-0 variant detected.
- Self-heal: multiple marker comments (past bug, race) → update the first, delete the rest, count
  in warnings.
- **Commit-status fallback has no neutral state**: warn-only regression maps to `success` with the
  truth in the description text (`⚠ ... (warn-only)`); `failure` stays reserved for opted-in
  blocking. Surface choice reported in warnings.
- `publishResult()` never throws: comment 403 → check-only; check 403 → status fallback; all down →
  warnings, exit unchanged. **The user's CI run cannot be failed by our publishing.**

#### Rendering redesign (email evidence, 2026-08-19 — DONE, `692156d`)

Real-email evidence (Gmail, PR #5 before / PR #6 after) drove four changes, all improving the PR
page too: **policy-skip rows grouped** (one row + an Excluded-rows details block — five identical
SSG sentences had blown up the table); **methodology stated once per metric** in the accounting
(identical across sides *by construction* — §5.1; per-side lines carry only values + samples);
**role split** — the comment is the readable surface (verdict, table, AI, slim details), the
step summary is the accounting surface (full per-side collectedBy, linking back to comment and
check; "How measured" in the comment is two sentences + a link); **verdict line untouched** — it
is the proven email preview and must stay self-sufficient. Details blocks arrive *expanded* in
mail clients; design for that always.

### 6.2 CI check

A status check carrying the same verdict, so teams can block merges on it.

**DECIDED — warns by default, never blocks on install.** The check reports a neutral/warning status
even when the threshold is crossed. `block_merge` exists in `perf.yml` and is set to `false` by
default; a team turns it on once they trust the numbers.

*Reason:* a newly installed tool that blocks merges gets uninstalled, not fixed. Trust has to be
earned by being right for a few weeks first. The cost of this choice is that the tool is ignorable
early on — mitigated by making the PR comment itself impossible to miss (§6.1).

#### M3 live-proof findings (2026-08-19, PR #4)

Proven live: one comment (id 5336172502) told both truths at the same URL — regression
(+6.1% bundle, lodash analysed at 70% with the ~140KB arithmetic) then, after the fix push,
updated **in place** to no-change; check flipped neutral → success. Caught and fixed en route:
**project-dir bug** (the action measured repo root, not the project dir — detection walks up,
never down; exposed by an honest inconclusive, fixed via action input baked into the generated
workflow); **Node runtime drift** (GitHub force-ran node20 actions on Node 24 — the protocol
recorded it on both sides, which is precisely its job).

### 6.5 Distribution — GitHub Action (DECIDED)

Ship as a plain GitHub Action, not a GitHub App.

*Why:* no OAuth, no hosting, no permission model to operate. The user adds a YAML file and it runs —
and it runs **inside their own CI**, which is exactly the §5 decision. A GitHub App only becomes
necessary for centrally-held state (team dashboards, alerting, subscriptions), all of which is
post-MVP. Because of the §3.1 split, moving to an App later is adapter work, not a rebuild.

#### Action entry notes (M3 step 3, `8e1adcd`)

- **Warn-only applies to measurement verdicts, not setup failures.** A preflight error (base commit
  missing from a shallow clone) exits 1 with the exact fix stanza to paste — a misconfigured setup
  that exits 0 renders a green check forever and nobody learns the tool isn't measuring.
- Base in CI = the event payload's base **SHA** (pinned; the branch tip may move), labelled with the
  branch name via `--base-label`. Bug fixed en route: `ConfigReport.base` reported perf.yml's
  default even when `--base` overrode it.
- Runner identity via generic `DRIFTWATCH_HOST_LABELS` env — core never learns what a "runner" is
  (rule 1 preserved). Labels sorted, join the protocol hash → cross-runner deltas refused, stale
  runner caches strand. `DRIFTWATCH_VERSION` → 0.3.0 accordingly.
- `init --github` refuses to overwrite an existing workflow without `--force` (rule 2 extends to
  their workflows), and the generated file states that without the AI key, regressions are still
  measured — just not explained.

### 6.3 Static dashboard (no backend)

Store measurement results as JSON in a dedicated branch in the user's own repo (`perf-data`), and
serve a statically-exported dashboard (Next.js → GitHub Pages) that reads it.

- No server, no database, no auth
- Data belongs to the user, in their repo
- Consistent with zero-config and BYOK
- Precedent: `github-action-benchmark` does exactly this

Covers what a PR comment can't: trends over time, Git History Replay charts, branch comparison.

#### perf-data branch (M5 step 1 — DONE, `5f9f72f`/`8e190b8`, validated live)

- **Two modes in the contract** (schema 1.2): `compare` (PR runs — ephemeral comparisons) vs
  `record` (push to default branch — the absolute measurement of each landed commit). Record's
  verdict is **`recorded`, not `ok`** — no comparison happened, so "ok" would report a judgement
  never made (rule 3). Prose leaves in the contract (reasons, labels) are existence-locked, not
  wording-locked; machine fields stay value-locked.
- Orphan `perf-data` branch, `results/<short-sha>.json` + `index.json` (append-only; per-entry key
  medians **+ protocol identity** — node, platform, browser, hostLabels, version — so a chart can
  refuse cross-protocol segments without fetching result files). `"tool": "driftwatch"` ownership
  marker; a foreign perf-data branch → refusal, never overwrite. Races: pre-push fetch serializes
  the common case, one refetch-reapply retry, then warn and give up (a missing trend point is
  recoverable; a corrupted index is not).
- Record-mode install rule: no base lockfile to consult → clone `node_modules` when present,
  install when absent (found live: a bare CI checkout produced an empty trend point).
- Live data is already exercising the design: runner Chrome 151.0.7922.**108** vs local **.140** —
  same major, different build — the exact segmentation case step 2 exists for. The empty first
  entry is preserved deliberately: truthful history, and real test data for sparse-entry handling.
- `driftwatch record [--json]` locally (no push — publishing is CI's job).

#### Trend math (M5 step 2 — DONE, `1b89d6a`)

- Segmentation breaks on any of the five identity fields, **between consecutive points** — a
  protocol that flips and flips back is three segments, never two. Breaks annotated with the exact
  fields ("browser: chrome/151….108 → .140" — the live pair is the golden's break case).
- Drift judged against the **same** exported floor+quantum table as PR runs (`quantumFor` — one
  source, never duplicated): 14 commits × +0.8% (each under the floor) reports **+11% drifting-up**
  — the headline promise; a 4ms route "drifting" +50% is correctly stable (+2ms < 5ms quantum).
  Drift never crosses a break. Language is structural: **"drift" for trends, "regression" for
  PRs** — different epistemics, different words; and `insufficient-data` carries `cumulative:
  null`, not an unlabeled number — publishing it would invite reading a trend into noise
  (< 3 points is not a trend).
- `driftwatch trend [--json]`: read-only (remote-tracking ref only). Today's honest output on the
  real branch: all 16 metrics `insufficient data (1 < 3 points)` — correct.

#### Static dashboard (M5 step 3 — DONE, `9c38bf1`)

- One self-contained HTML, zero network, **zero executable script** — the only `<script>` is an
  inert JSON island; charts are generation-time inline SVG with native `<title>` tooltips (hover
  works from `file://` with no JS). Renders step-2 structures verbatim; there is no browser
  computation to drift from the math layer.
- §5.1 rendered: segments as separate polylines, dashed break markers naming the changed fields,
  sparse gaps split the line (lone points draw as dots, never interpolated), drift chips with the
  number only when it exists, "drift" language throughout ("regression" test-asserted absent).
- CI regenerates `index.html` at the branch root per append; `driftwatch dashboard [--open]`
  locally. Pages setup is documented in workflow comments — repo settings are the user's.
- "Render it and look at it" caught what structural tests couldn't: short-vs-full sha mismatch
  pinned break markers to the left edge; latest-value labels clipped at the right boundary.

#### Runner lottery in trend data (found at M5 step 4 — DECIDED: measure first)

Three comment-only pushes reported `build_time +65.3%`, `tbt +536%` — not drift, **machine
lottery**: identical hostLabels, different physical VMs (19.9s vs 32.9s builds). PR comparisons are
immune *by design* (same invocation, same machine — the §5 mitigation working); trend points are
structurally exposed, and labels can't capture physical-VM variance. **Decision: record
Lighthouse's `benchmarkIndex` (a CPU-speed proxy it already computes) into every trend point as
normalization data — NOT into the identity hash** (that would fragment segments by VM). Collect
passively; decide normalization vs rolling-median vs document-and-accept from real data. Byte
metrics and FCP read stable through the same points — the lottery is a time-metric problem.

**Chrome pinning postscript:** pinned versions must be *validated*, not just chosen — CfT
`.138`'s DevTools endpoint resets connections; the pin is `.77` (works). The five-rung debugging
ladder was diagnosed entirely from skip reasons recorded in the trend points — the observability
explaining its own failures.

#### Shared-runner browser churn (found live, M5 step 3 → decided step 4)

The runner's Chrome moved three builds in one day (.108 → .137 → …), splitting trend segments
faster than they can reach 3 points — strict §5.1 identity would leave CI trend data permanently
"insufficient". **Decision: pin the browser in the generated workflow** (a setup action with a
fixed Chrome version, bumped deliberately) — protocol stability by construction, segmentation
stays strict. Relaxing identity to browser-major was rejected: build-level rendering changes are
exactly what §5.1 exists to refuse, and we have no spread data licensing the assumption they're
inert.

### 6.4 Hosted dashboard — later

Build only when monetizing teams (multi-repo, alerting, permissions), with paying users to justify it.

**Build order:** PR comment → CI check → static dashboard → hosted dashboard.

---

## 7. AI Analysis Pipeline

**Trigger rule: AI only runs on a detected regression.** Measurement itself is plain scripts, no AI.
Expect AI to fire on roughly 5–10% of pushes.

### Two-stage routing (REVISED after M2 acceptance — see §7.1c)

The original design gave triage two jobs: noise-gate ("real regression or CI noise?") and
suspect-naming. **The noise-gate job is dead**: since §5.1's fifth instance, a reported regression
is already *proven real by measurement* — confirm-before-report escalation, same-invocation, fresh
both sides. AI must never overrule measurement.

1. **Triage — suspect ranking only, never a gate.** Ranks changed files by likely contribution and
   flags out-of-diff hypotheses (deps/config/environment) as *hints for deep, not verdicts*. A
   confirmed regression ALWAYS proceeds to deep analysis.
2. **Deep analysis** — full patches for top suspects, produces cause + confidence + evidence + fix,
   and is the only stage allowed to conclude "the diff does not explain this."

Economics still hold: deep on every confirmed regression ≈ $0.006/run on DeepSeek at ~12K input
tokens, and regressions are 5–10% of pushes. Input: diff + benchmark deltas +
   relevant code (+ profiling data such as a flame graph). Output: root cause, confidence score,
   suggested fix.

**Why Sonnet, not Opus:** reading a diff plus benchmark deltas and inferring a cause is
medium-complexity reasoning, not open-ended research. Opus buys a marginal gain on hard cases at
roughly double the cost — not justified yet.

**The model is config-exposed** (`provider:` / `model:` in `perf.yml`). With BYOK the user pays, so
the choice is theirs. Once real usage data exists, revisit with numbers instead of guesses.

### 7.1 Provider abstraction — required from day one

**Implemented (M2 step 1, `b02b12a`):** the provider boundary is a JSON-completion *transport* —
`chat(request) → {text, tokens, model}` — not a semantic `analyse()`. The typed triage/deep shapes
and all prompts live in `analyse/`, above the boundary. This enforces provider-agnostic prompts
*structurally*: nothing above the boundary can tell DeepSeek from OpenAI (one OpenAI-format client
covers both; base URL + model + key differ in a registry). Key from `DRIFTWATCH_API_KEY` env only —
never config, never disk, never in results. Strict JSON via `response_format` plus one corrective
retry (the model sees its own rejected output and the named problem); token usage summed across
attempts so cost stays honest. Typed failures (`auth`/`http`/`network`/`timeout`/`malformed`)
degrade to `analysis: skipped` with reason — the verdict itself never depends on a provider being
reachable.

### 7.1a Context assembly (M2 step 2 — DONE, `b7f155e`)

- Diff is base SHA → **working tree** (uncommitted included — that is what was measured); binaries
  excluded by content.
- Token budget as code constants. Priority: metrics + sampleValues + protocols + evidence trail +
  full diffstat always; then full patches largest-impact-first until spent; lockfile diffs never
  raw — summarized to added/removed/bumped.
- **Deterministic assembly**: same inputs → byte-identical context (testable, cacheable).
- **Secret hygiene (rule 6 extension): measured, never transmitted.** Files matching secret
  patterns (`.env*`, `*.pem`, `*.key`, credential stores) contribute a diffstat line only, marked
  "content withheld".
- **contextManifest** recorded per run: what went in full, summarized, withheld, truncated, token
  estimate. This is how "docs state exactly what is sent" is honoured — the tool shows it per-run.
- Two pure functions: `assembleTriageContext()` (compact, **zero patch content** — its manifest
  marks everything `diffstat-only`, because the manifest states what was *sent*, not what was
  eligible) and `assembleDeepContext(suspects)` (triage-named suspects pre-empt the budget).
- *Implemented judgment calls:* budgets triage 4K / deep 24K / 8K per file, minimum useful slice
  500 tokens (below that a fragment is noise — omit and say so); chars/4 counts labelled
  **estimates** everywhere, measured counts come from the provider (rule 3 applied to tokens); no
  absolute paths in any context (they leak usernames); `.npmrc` counts as a secret (carries auth
  tokens); untracked-not-ignored files synthesized as new-file patches so the diff matches the
  measured file set; sampleValues shown raw with "medians are reported; judge the spread yourself".
- The golden files (`context-triage.md`, `context-deep.md`) double as the privacy documentation of
  exactly what a run sends.

**Development starts on DeepSeek** (free/cheap while iterating on prompts, and the key is already in
hand). Building hundreds of test analyses on a paid provider while the prompts are still bad is
wasted money.

This makes provider-swapping a **day-one architectural requirement**, not a later refactor:

- One internal interface: `analyse(context) -> {cause, confidence, fix}`. Nothing above it knows
  which provider ran.
- DeepSeek's API is OpenAI-compatible, so one OpenAI-format client covers DeepSeek and OpenAI;
  Anthropic needs a second thin client.
- **Never tune prompts to one provider's quirks.** A prompt that only works on DeepSeek is a lock-in
  disguised as a saving.
- Cost features differ (caching semantics, batch/off-peak discounts) — keep them inside the provider
  adapter, never in core logic.

**Two things to stay aware of:**

- *"Free right now" is a promotion, not a business model.* Fine for development; don't let launch
  economics depend on it. BYOK already insulates us.
- *Data residency.* Some teams will refuse a Chinese-hosted provider outright. Because the user
  brings their own key and picks the provider, this is their call — but the default in `perf.yml`
  should be chosen with that in mind at launch, and the docs must state plainly what gets sent
  where.

### 7.1b Two-stage flow (M2 step 3 — DONE, `3ba3ff0`)

- **Prompts are versioned artifacts**: `PROMPT_VERSION` rides in every stage's stats; golden file
  `prompts-v1.md` (rendered in full with real context) — version bumps produce a new file alongside
  the old, so §7.2 eval comparability starts here.
- Triage is told: *"this diff does not explain it" is a valuable answer, not a failure* — never
  invent a suspect; judge plausibility against the delta's **size**; the measurement itself is
  trustworthy (cold, same machine, median), so noise can't be lazily blamed unless the raw samples
  show it.
- Deep bakes in the calibration rubric, the magnitude check with **stated arithmetic** required in
  the evidence, dual citation (measurement + code), and the trust principle verbatim: overstating
  confidence is the worst failure mode; when in doubt, the lower band.
- **Fix rules enforced in code, not model obedience**: `enforceFixRules()` downgrades any diff
  below 0.8 confidence, or touching files the model wasn't shown, to prose — content preserved,
  downgrade named.
- Every exit honest: non-regression → skipped (guard); triage-no → inconclusive with the model's
  stopReason; provider error → skipped naming stage+reason; the measurement verdict never changes.
- Privacy **asserted by test**: the mock provider records every request; triage requests contain
  zero patch content.

### 7.1c The Run-B false negative — why triage lost its gate (M2 acceptance, 2026-08-19)

Acceptance Run B: a 4-line diff — `import _ from 'lodash'` + one `_.debounce` usage — caused a
measured, confirmed +6.1% bundle regression (~140KB: textbook full-lodash import). Triage saw only
the diffstat (`+4/-0`), applied the line-count-as-magnitude heuristic it had been taught ("a
one-line change rarely explains a 3× regression"), and stopped the pipeline: **honest, mechanically
correct reasoning from insufficient input — and still wrong**, misdirecting the user toward
environment-hunting. The failure was structural, not model error: diffstat-only triage is blind to
exactly the small-isolated-cause class that Run B was designed to test.

Three fixes (prompt/pipeline v2):
1. **Triage loses the gate** (see revised §7 routing) — measurement proves realness; AI only
   explains. Triage's stopReason becomes a hint passed into deep's context.
2. **Small diffs ride inline**: files under ~50 changed lines get their patch in the triage context.
   Run B's entire diff is 4 lines; the cost is trivial.
3. **Magnitude rule corrected**: import/dependency lines are *multipliers*, not line-counts — one
   import can pull in a library. Stated to the model with the lodash example.

Run A passed cleanly (cause correct, suspects ordered, arithmetic stated, 70% confidence
rubric-correct with two contributing suspects, fix stayed prose). Provider findings from the same
session: DeepSeek intermittently fences JSON despite json-mode → provider-agnostic tolerant
extraction (location-only, shape still strict); served model name can differ from requested
(`deepseek-v4-flash` for `deepseek-chat`) → record the served name and price by it.

### 7.2 Evaluation set — LIVE (`a5bad85`, M2 close)

`eval/cases/` with three cases + `driftwatch eval` (dev command, live provider, pass/fail per
expectation + tokens/cost): **run-a** (large obvious cause — PASS 0.7, correctly the two-suspect
band), **run-b** (4-line lodash import, v1's false negative — **PASS under v2**: named lodash as
multiplier, 0.9, diff fix confined to the page), **run-c** (lodash + dependenciesChanged — PASS
0.9). All first attempts; total M2 acceptance spend ~$0.03. The a5bad85 numbers are the v2
reference point: every future prompt change must beat them here before shipping. Cases captured
under schema 1.1 + warm-up protocol.

Before comparing providers by feel, assemble ~20 real regressions with known causes (harvest them
via Git History Replay, §10). Then provider choice becomes a measurement: *which model identified
the correct cause, how often, at what cost?*

This is the single highest-leverage thing to build early — it converts the model question from a
recurring opinion into a number, permanently.

### Cost model

- Per deep analysis: ~10–20K input tokens, ~1–2K output → roughly **$0.02–0.04**
- An active repo: **well under $1/month** in AI cost
- Optimizations: prompt caching (cache hits ≈ 10% of input price), Batch API (50% off — viable
  because CI analysis is not latency-sensitive)

---

## 8. Feature Roadmap

### MVP
- **Local CLI** (`npx driftwatch run`) — full measurement + terminal report, no account, no push
- Detection + auto-generated `perf.yml`
- Layer 1 universal metrics
- Layer 2a: build + run the app, measure routes (Lighthouse/Playwright) — no tests required
- Layer 2b: per-test timings where a suite exists (bonus, not a dependency)
- Baseline + threshold comparison, with noise handling (§5)
- `github` adapter: self-updating PR comment + CI check
- AI root-cause analysis with confidence score
- JS/TS adapter (build time, bundle size, Lighthouse)

### Post-MVP — ranked by expected impact
1. **Auto-fix PR — M6, IN PROGRESS.** *Step 1 (core verification, `c46eef9`) done:* `git apply
   --check` gates (never fuzzy-matched — a fix we had to bend is not the fix that was suggested);
   the fixed copy is a **third side** through the same measurement path, protocol-compared
   field-by-field — §5.1 applies to itself; three-way verdicts reuse the same floor+quanta
   ("restored" means what "no change" means everywhere); a worsening fix lands in `no-recovery`
   and can never count as `partial`; gate-outs are absent from the JSON — rule 3 is about
   reporting attempts, not non-events. Real e2e: the live PR #6 lodash fix verified `restored`,
   ~140KB recovered, fixed within 2KB of base. Verification runs only at the enforceFixRules bar
   (diff fix, ≥0.8), only on regressed metrics. Schema minor 3. Before
   opening any fix PR, apply the AI's diff in a fresh temp copy and MEASURE it — same protocol,
   same invocation, three-way comparison (fixed vs current vs base). The PR opens carrying its own
   measured evidence ("this fix was measured: bundle returns 2.33→2.20MB") or does not open at all,
   with the failure reported honestly. Every other AI tool proposes hoped-for fixes; we have the
   one thing they don't — a trusted measurement machine to prove ours. Measurement proves the AI's
   own suggestions: the trust principle closing its own loop.
2. **Trend detection** — catch slow decay (1% per commit, 30% over three months). Nobody does this
   well; highest-value insight.
3. **Cost translation** — express regressions in money, not milliseconds. Milliseconds don't get
   budget approved; dollars do.
4. **Pre-merge prediction** — flag likely regressions before merge.
5. **Git History Replay** — see §10.
6. **Layer 3 instruction counting** — precision tier.

---

## 9. Rejected approaches (and why)

| Approach | Why rejected |
|---|---|
| Static analysis only (no execution) | Predicts problems, can't measure them. No numbers, no push-to-push comparison, can't see runtime data sizes, misses regressions from dependency or config changes, and no ground truth to verify the AI's claim against. May return later as a *complement* to measurement, never as the core. |
| **Self-hosting** open-weight models on our own GPUs | Hosting cost usually exceeds API cost below large volume. *Note: this rejects self-hosting, not open-weight models as such — using DeepSeek's hosted API is a different decision and is the current dev default (§7.1).* |
| Competing on production monitoring | Datadog/New Relic own it. Our niche is the CI loop. |

---

## 10. Git History Replay (onboarding feature for existing projects)

Checkout, build, and measure the last N commits to reconstruct a performance timeline
retroactively. Delivers a "wow" moment in the first hour instead of after a month of data
collection: *"Your performance started degrading 6 months ago, at commit abc123."*

**Constraints to design for:**
- Expensive (hours of CI minutes) → keep it **optional**, let the user pick N
- Old commits may fail to build (stale deps, different runtime versions) → mark as `skipped` and
  continue; never abort the run

---

## 11. Business Model

- **Initial: BYOK** (user supplies their own API key). Zero AI cost to us; developers are used to
  this model.
- **Later: bundled paid tier**, priced above true cost. Per §7, margins are comfortable.

---

## 12. Open Decisions

| # | Question | Status |
|---|---|---|
| ~~1~~ | ~~User's CI vs own infrastructure?~~ | **RESOLVED — user's CI** (§5) |
| ~~6~~ | ~~Multi-platform support?~~ | **RESOLVED — core/adapter split, `github` adapter only at launch** (§3.1) |
| ~~2~~ | ~~CI check blocks or warns?~~ | **RESOLVED — warns; `block_merge: false` by default** (§6.2) |
| ~~3~~ | ~~Model for deep analysis?~~ | **RESOLVED — provider-pluggable; DeepSeek for dev, decide launch default by eval set** (§7.1, §7.2) |
| ~~4~~ | ~~GitHub App vs. plain Action?~~ | **RESOLVED — Action** (§6.5) |
| ~~5~~ | ~~Product name?~~ | **RESOLVED — Driftwatch** (npm + scope confirmed free 2026-08-18) |

---

## 13. Working Method

- Planning and decisions happen in conversation; specs live in files.
- Claude Code reads `CLAUDE.md` + `specs/`, not conversation memory — every decision must land in a
  file to survive.
- Record decisions **when made**, with the **reason**. In two months the "why" matters more than the
  "what".
