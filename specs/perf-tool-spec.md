# Driftwatch — Project Spec

*Working name. CLI command: `npx driftwatch run`*

> Living document. Update it whenever a decision is made or changed.
> Version 66 — 2026-08-24 — warm-up/sampleValues precision (README verification); README §1–§5 drafted. Prior: workspace identifiers anonymised too; README shape agreed. Prior: audit clean on secrets; trial project anonymised, history kept. Prior: M12 launch opened: public + Apache-2.0 decided, name re-verified. Prior: **M11 CLOSED.** AI is a clean optional tier; disclosure generated from code. Next: launch. Prior: M11 step D: named provider conditions; a wrong name is worse than no name. Prior: M11 step C: cost projection as an audited upper bound + refusing cap. Prior: M11 step B: doctor (no key exits 0, cost as a named ceiling). Prior: test doctrine applied and swept; timeout reasoning. Prior: M11 step A: key resolution + literal-key refusal; test doctrine on timing assertions. Prior: M11 step 1 done: tier contract + keyless audit (five findings fixed). Prior: M11 opened: AI as a clean optional BYOK tier (pre-launch). Prior: **M10 CLOSED** (391 tests). Product thesis complete. Next: launch. Prior: decision audit (two slips fixed, now a periodic practice); per-class relevance live. Prior: M10 step 1: alert thresholds + per-class causal protocol relevance. Prior: guards closed (schema 2.1, build identity everywhere); M10 drift alerting next. Prior: **M9 CLOSED, eval 4/4.** Stale-build trap → every output identifies its build. Prior: M9 implemented: output caps sized from measurement, truncation named via finish_reason. Prior: **M8 CLOSED** (334 tests; eval 3/4, run-a = TRIAGE_MAX_OUTPUT truncation, promoted to next work). Prior: M8 validated live on the trial project (inconclusive-context + staging detection); live eval outstanding. Prior: M8 step 4: metric split (schema 2.0), verdict licensing, byte classes exempt from the relative floor. Prior: M8 step 3 done (the trial project measured!); five trial findings decided. Prior: M8 step 2 done: failure legibility, fix stanzas. Prior: M8 step 1 done: three uninvited writes closed, consent doctrine. Prior: M1–M7 closed; **M8 opened from the the trial project real-world trial** (§9a):
> rule-2 fix, monorepo support, failure legibility. Prior: Version 41 — **M1–M7 all CLOSED.
> 293 tests.**
> M1 measurement · M2 AI analysis · M3 GitHub Action · M4 Layer 2a · M5 trends+dashboard ·
> M6 verified auto-fix · M7 git history replay. Latest decisions: movement doctrine (§10),
> the second de-gating (roadmap #1), environment-conditional quanta (§5).
> Pre-launch items: TRIAGE_MAX_OUTPUT vs model verbosity; Pages/visibility.
> *(Header note: versions 20–40 were announced in planning but the header line itself went
> unbumped — the section content for all of them did land. Renumbered accurately here.)*

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
   cache). **Precision (caught while drafting the README):** the discarded warm-up runs *before*
   the timed set, so `sampleValues` holds three timed builds — and the first of those is still
   high (`[11143, 8629, 8724]`), because it continues warming OS caches. The median, not the
   warm-up alone, is what absorbs it. Raw samples ride in the
   result (`sampleValues`) so consumers can see the spread. `BUILD_SAMPLES = 3` is a code constant,
   not config — like the noise floor, it is a property of the instrument, not a preference.
   Cost: ~35s per side instead of ~13s.
2. **Measure baseline and PR in the same job on the same machine — and in the same invocation.**
   Cancels most machine variance. Same-invocation pairs measure consistently under 1% apart; the
   same machine drifts several percent over an hour (thermals, background load), so "same machine"
   alone is not enough. **No reported delta may span a time gap** — see §5.1 fifth instance.
3. **Instruction counting (Layer 3).** Eliminates the problem entirely for CPU-bound work.

Anything below a ~2% delta is treated as noise and not reported — **except the deterministic byte
classes** (`client_bundle_size`, `build_output_size`, `transfer_size:*`), which are exempt from the
relative floor and gated by their 1KB quantum alone (decided M8 step 4). *Why:* the floor is a
**noise** rule, and bytes carry no noise (±2 bytes observed). Keeping it would have made the tool
blind to its own canonical case — on a 9.6 MB client bundle, 2% is ~197KB, so the 140KB
lodash regression that M2 and M6 were built around scores 1.42% and reports "no change". A rule
that hides the founding example on any large app is mis-scoped, not conservative. (Related
correction: that "~140KB of lodash" was ~70KB client + ~70KB server — the old all-of-`.next`
metric counted both.) **Additionally, each metric class
carries its own absolute quantum — the instrument's resolution, a code constant, never config**
(generalized at M4 step 1 from the M1 build quantum):

| Metric class | Quantum | Basis (measured) |
|---|---|---|
| `build_time` | 100 ms | 15ms builds spread 43% run-to-run; process-spawn territory |
| `route_latency:*` | 5 ms | observed ±1ms sampling noise (same-process sequential fetch), ×5 |
| `lcp:*`, `fcp:*` | 25 ms local / **200 ms on CI** | local: ≤7ms spread across boots; CI (measured, M6 acceptance): swings of −9.7%…+17.8% on byte-identical trees |
| `tbt:*` | 50 ms local / **100 ms on CI** | local: ±2ms; CI: +83% observed on identical code — machine-class noise |

**Environment-conditional quanta (decided M6 acceptance):** the quantum is the instrument's
resolution, and *the machine is part of the instrument* — shared CI runners are a coarser
instrument for browser timings. Conditioned on host class (CI = `DRIFTWATCH_HOST_LABELS` present;
local = absent), recorded in the protocol, a `DRIFTWATCH_VERSION` bump (caches strand — intended).
Basis is one session of passive CI data; keep collecting and revisit the values, not the
principle. Consequence accepted honestly: sub-200ms LCP regressions are invisible on CI — the
instrument there cannot resolve them, and pretending otherwise produced both false banners and
false recovery certifications.
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

#### Repo-setting requirement for auto_fix (M6)

Fix PRs from Actions require the repo setting "Allow GitHub Actions to create and approve pull
requests" (403s without it). Flagged when enabled on our own repo; the generated workflow must
document it as an auto_fix prerequisite — settings remain the user's to flip.

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
1. **Auto-fix PR — M6, CLOSED (2026-08-19).** *Step 1 (core verification, `c46eef9`) done:* `git apply
   --check` gates (never fuzzy-matched — a fix we had to bend is not the fix that was suggested);
   the fixed copy is a **third side** through the same measurement path, protocol-compared
   field-by-field — §5.1 applies to itself; three-way verdicts reuse the same floor+quanta
   ("restored" means what "no change" means everywhere); a worsening fix lands in `no-recovery`
   and can never count as `partial`; gate-outs are absent from the JSON — rule 3 is about
   reporting attempts, not non-events. Real e2e: the live PR #6 lodash fix verified `restored`,
   ~140KB recovered, fixed within 2KB of base. Verification runs only at the enforceFixRules bar
   (diff fix, ≥0.8) — **superseded, see the second de-gating below** — only on regressed metrics.
   Schema minor 3.
   *Step 2 (GitHub side, `ef74e8c`):* `auto_fix: off|propose` (default off); gate-outs make **zero
   API calls** (tested); branch `driftwatch/fix-pr<N>` off the verified PR head carrying **exactly
   the measured bytes**, re-gated by `git apply --check` at push time; the PR opens INTO the PR
   branch; body-marker upsert + stale-diff self-close; fork PRs skip honestly. `contents: write`
   already existed for record mode — dual purpose documented, not conditionally included.
   *THE SECOND DE-GATING (decided mid-acceptance):* the ≥0.8 confidence bar on verification was a
   **pre-M6 rule** — it protected users when the model's self-confidence was the only evidence. M6
   makes that evidence obsolete: **a 0.7-confidence diff that verifies `restored` is stronger than
   a 0.9 diff never measured.** Same shape as M2's triage de-gating. Rule: verification runs on any
   structurally valid diff fix on a confirmed regression (the cost gate stays); **the fix-PR gate
   is verification outcome only** (`restored`/`partial`). The 0.8 bar survives as a *display* rule;
   a prose-displayed diff that verifies upgrades to the full diff with its measured numbers —
   measurement earned the display confidence couldn't. Confidence is self-report shown beside the
   measured outcome ("model confidence 70% — measured: restored"), never a gate on measured
   evidence.
   *Acceptance (seven takes, six findings):* **the resolution gate** — a row whose current↔base gap
   fits inside the combined noise radii can never certify recovery in either direction (B4 opened a
   PR titled "partially recovers bundle size 2.34 MB → 2.34 MB"); B5 proved the gate right and the
   local browser quanta wrong for CI → environment-conditional quanta (§5). Run A closed the full
   loop live: fix PR #9, deliberate merge, the original comment flipped to no-change in place. Run B
   closed deterministically: sabotaged diff → `no-recovery` → **no PR, zero API calls** → honest
   comment line. Also: fix PRs from Actions require the repo setting "Allow GitHub Actions to create
   and approve pull requests" — documented as an `auto_fix` prerequisite, never flipped by us.
   Before
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
5. **Git History Replay** — see §10. **← M7, CLOSED.**
6. **Layer 3 instruction counting** — precision tier.

---

## 9. Rejected approaches (and why)

| Approach | Why rejected |
|---|---|
| Static analysis only (no execution) | Predicts problems, can't measure them. No numbers, no push-to-push comparison, can't see runtime data sizes, misses regressions from dependency or config changes, and no ground truth to verify the AI's claim against. May return later as a *complement* to measurement, never as the core. |
| **Self-hosting** open-weight models on our own GPUs | Hosting cost usually exceeds API cost below large volume. *Note: this rejects self-hosting, not open-weight models as such — using DeepSeek's hosted API is a different decision and is the current dev default (§7.1).* |
| Competing on production monitoring | Datadog/New Relic own it. Our niche is the CI loop. |

---

## 9a. Real-world trial (a real 12-package pnpm monorepo, 2026-08-20) — the findings that became M8

First contact with a codebase we didn't build. Nothing measured (8/8 metrics skipped in 8.3s) — and
the trial was worth more than any green run.

**🔴 Rule-2 violation — the headline.** `driftwatch run` wrote `perf.yml` into the user's working
tree, untracked, on his feature branch, **and never said so**. It is M1's specified behaviour
("writes a perf.yml if absent") and it is still a violation *in spirit*: `run`'s contract is
measure-don't-touch, and a silent file appears in `git status` days later as a mystery.
**Rule: `run` never writes to the user's tree. Config generation belongs to `init` alone, which
announces every file it writes.** Absent config → run on defaults and say so in one line.

*The audit found three writes, not one (M8 step 1, `b278014`):* `run` → `perf.yml` (the reported
one); `replay --harvest` → `eval/candidates/` at repo root (same sin, unreported → moved to
`.perf/eval-candidates/`); and `record`/`replay` → **creating the `perf-data` orphan branch**
uninvited — the worst of the three, since a branch is harder to notice and harder to undo than an
untracked file. The trial run only escaped the last two because it died at install first.

**Consent doctrine (decided):** *creating* the perf-data branch requires explicit consent
(`--write-perf-data`); *appending* to a branch that already exists was consented when it was
created. CI record mode keeps implicit consent — installing a workflow with `contents: write` **is**
the act of consent, and a prompt in CI would hang. The refusal shape is the model for every future
gate: **do the work, refuse the write, and say exactly how to keep it** — measured results wait in
`.perf/replay-pending/`, so consenting later writes them without re-measuring. Guarantees are
phrased as the user experiences them: `git status --porcelain` byte-identical across `run`,
`record`, and `replay`. M1's definition of done ("writes a perf.yml if absent" — the contract that
produced the violation) is marked **superseded**, not deleted, so the decision history stays
legible.

**The blocking gap: pnpm workspaces.** Detection guessed npm; npm cannot resolve `workspace:*`
(EUNSUPPORTEDPROTOCOL), so both sides failed identically. The symmetry machinery worked perfectly —
`protocolsMatch: true`, both sides failed the same way, correctly `inconclusive`, rule 3 held under
total failure, cleanup flawless. But "works on any codebase" does not survive contact with a
monorepo.

**Failure legibility — a named principle now:** *every failure must carry its own fix.* The M3/M6
error stanzas ship the exact YAML to paste; the measurement path ships none of that discipline.
Specific defects:
- The terminal shows `reason.split('\n')[0]` — for install failures the first line is *"install
  exited with code 1; last output:"*, a sentence ending in a colon that then delivers nothing. The
  real error (`EUNSUPPORTEDPROTOCOL`) lives only in `--json`, unhinted. **Render the last line, or
  drop the promising tail when the content can't be shown.**
- *"dependencies are not installed in the workspace"* — "workspace" means our temp copy; in a pnpm
  monorepo it means something else entirely. Guaranteed misread. **Rename the concept in
  user-facing text.**
- A knowable risk went unwarned: `workspace:*` + assumed-npm is a guaranteed failure, detectable at
  detect time.
- Eight `—` rows read as "ran and found nothing" rather than "never ran"; *"both sides measured
  fresh this run"* sits under a table where nothing was measured.

*Step 2 (failure legibility, `a6b4a46`) — DONE.* One shared `summariseReason` in core (terminal,
comment, details cannot drift); **a line ending in a colon is a promise** — trim it rather than show
it empty; the pointer names where the rest lives *and the summary genuinely carries the full
multi-line error, so the pointer never lies* (that was the difference between a fix and a cosmetic).
"workspace" renamed in every user-facing string (→ measurement copy / base checkout) — the collision
mattered precisely in the project type that hit it. Cells read `not measured`, with an explicit
"unavailable, not unchanged" line and measurement-assuming lines suppressed. **Fix stanzas** (schema
minor 5) for `workspace:*`+npm, frozen-lockfile, permissions, network, deps-missing,
no-build-output, no-server — deduplicated, grouped by remedy, and **emitted only where a remedy is
knowable: fabricated helpfulness is rule 3 in reverse.** Asymmetric failures keep their
`base:`/`current:` prefix — which side failed is the reader's first question (a test caught the
first attempt hiding it). Golden diff near-empty: every healthy path byte-identical, one new file
`comment-nothing-measured.md` preserving the trial failure as a permanent contract.

*Step 3 (monorepo support) — DONE. The trial project measured for the first time:* pnpm detected
from the root `packageManager` pin, root lockfile read, whole workspace copied, install at the root,
build in the app. 189s total, base 92s / current 94s — near-perfect symmetry on a 12-package
monorepo. `install time … not comparable` fired correctly (§5.1 sixth) on a real project.
**Cache-key bug found and fixed in the same step (`066cd08`)** — the (SHA, protocol hash) key
excluded the build command because "the tree at that commit determines it", true for one app per
repo and false the moment `--app` existed: `--app apps/admin` would have read the entry
`apps/web` wrote. **The key now includes the measured project.** A one-app assumption
hiding inside a protocol rule.

**Open decisions raised by the trial (M8 step 4+):**

| # | Finding | Decision |
|---|---|---|
*Step 4 (`e648ddb`, `02c329d`, `8f918bc`) — DONE, 329 tests.* Schema went to **major 2**: a rename
removes a field a 1.x consumer reads, and our own rule says a break bumps the major; the superset
test pins the break to exactly three explained differences so an *unplanned* break still fails.
Stale-base thresholds: **>50 commits behind OR >14 days old, either alone** — ~a sprint of team
activity, and two weeks is where a base predates the dependency bumps that make a delta somebody
else's; the plan hunts the likelier integration target (staging/develop before main) so the remedy
names the branch. Two judgement calls: **an `ok` run is softened too** (a stale base cannot license
"nothing changed" either), and a **measurement failure stays plain `inconclusive`** — softening it
would be an upgrade to a stronger word. Eval captures renamed to `build_output_size`, not
`client_bundle_size`: those 2.3 MB numbers weighed all of `.next`, and calling them a client payload
would assert something never measured.

*Live validation on the trial project (M8 close):* `inconclusive-context` fired on a real stale-base
comparison — both conditions, numbers in full, and **integration-target detection found `staging`
on real data**, which is exactly the branch the project's own CLAUDE.md names. Verdict wording:
*"measured, but not attributable — the numbers below are measured and stand; what they cannot do is
name this change as the cause."* `measurementPath: confirmed` also fired unprompted on someone
else's repo (cached base → floor crossed → both sides re-measured fresh, §5.1 fifth).

**The split changed the direction of the signal, not just the label:** client 1.41→1.48 MB
(+5.1%) vs build output 69.04→71.64 MB (+3.8%, under threshold). The old metric would have
shrugged at a change browsers actually feel; the headline is now 2% of the old number, and the
~72KB delta is reportable only because of the byte-class floor exemption. The two decisions
(split + exemption) only work together.

*Two further fixes from the same session:* the step-2 **last-line rule was calibrated on package
managers, which print errors last — build tools print a summary after the failure**, so a Next.js
build error rendered as "ƒ (Dynamic) server-rendered on demand"; it now selects the last line
carrying a failure signal, falling back to our own self-sufficient summary (`906614a`). And
**grouping must key on what is displayed, not on what it means internally** (`cea2186`): two groups
both labelled "dynamic segment" split because branch-only routes carried `(not present at base)`
in their underlying reason — two rows, same visible label, which is precisely what grouping exists
to prevent.

*M8-close eval (live, under schema 2.0 + prompts v2):* **3/4 PASS** — run-b 0.6, run-c 0.9,
run-d 0.7, all bands met, causes and fixes correct under the renamed metric; ~$0.008 total.
**run-a FAIL is transport, not analysis, and now twice-confirmed** (it also failed this way at
M6 close): triage returns invalid JSON because the response is *truncated mid-object* — the
captured text shows it had already correctly identified `lib/posts.ts` before the cut. Served-model
verbosity has outgrown `TRIAGE_MAX_OUTPUT`. **Promoted from pre-launch item to next work**: a
reproducible, model-drift-caused failure on the largest case, with the analysis provably correct
behind it. Fix direction: raise the cap, and make truncation a *named* failure ("response
truncated at N tokens") rather than generic "invalid JSON" — the retry currently re-sends a prompt
that cannot fit, so it burns a second call to fail identically.

*M9 (`45d8677`, 338 tests) — the diagnosis was wrong, and measuring corrected it.* Not model
drift in the "got worse at formatting" sense: triage ranks **one suspect per changed file at ~47
tokens**, so output scales with diff size — run-b (1 file) 104 tok, run-d (2) 146, run-c (3) 190,
**run-a (31 files) 1559 against a 1000 cap.** A diff-size cliff that only the largest case crosses,
which is exactly why it alone failed and why it reproduced. `TRIAGE_MAX_OUTPUT = 3200` (2× the
measured largest, ~66 files), basis recorded in a comment like `BUILD_SAMPLES`.
**Truncation is now a transport fact, not an inference**: the provider reads `finish_reason:
"length"` and surfaces `truncated` — a cut-off response is usually *also* unparseable, which is
precisely how this hid behind "invalid JSON" for two milestones. Retry policy: on truncation, retry
once with the cap **doubled** (same prompt); on malformed, keep the cap and send the corrective
prompt; never an identical request. One doubling only — a search would be guessing at the user's
expense. **The deep stage had the same ceiling, thinner than it looked**: a 150-line fix modelled
at 2360 against a 2500 cap (~94%); raised to 6000. Checking it pre-emptively was the point —
verbosity only grows.

*M9 CLOSED — eval 4/4 live.* run-a passes: triage out **1741** tokens against the modelled 1559
(12% over — the estimator is sound, and the 3200 cap keeps ~1.8× headroom), suspects named,
confidence 0.9, ~$0.013 for a 31-file diff. Deep outputs 312–554, far inside 6000.

**The stale-build trap — the real finding, and a new principle.** The first "M9 didn't work" eval
was executed by a **five-day-old `dist/`**: `bin` points at build output, nothing rebuilds it, and
nothing warns when `dist/` predates `src/`. Worse, the session had been running two different
entry points — `npx tsx src/…` for development, `npx driftwatch` (dist) for eval — so *the fix was
never in the binary under test*. The tell was the error text: the old generic message where the new
named one should have been. `--version` was hardcoded `0.2.0` while the package said 0.6.0, so the
one thing that could have revealed it lied.

**Principle: every output must identify the build that produced it.** Driftwatch records the
measurement protocol meticulously — node, browser, platform, tool version — and then let its own
eval run anonymously for five days. Protocol identity applies to the tool itself: version, build
timestamp, and entry point belong in every report. (Related but exonerated: `prompts v? · 0→0 tok`
is the *failure path's* shape, not a staleness signal — a skipped analysis records no stages. It is
still a real gap: a failed call consumed tokens and used a prompt version, and both are discarded.)

*Guards closed (`6880903`, 346 tests).* `build-identity.ts` owns version, entry point, build
timestamp, and the staleness check — **refusal, not warning** (a warning is what five days of
stale eval already ignored), with `DRIFTWATCH_ALLOW_STALE=1` as the hatch. Hook + guard compose:
the `prepare` hook keeps the common path fresh; the guard catches every path that skips install
(running `dist/` directly, a published install whose source moved, a mid-session edit). Build
identity now rides on **every** surface — terminal, eval header, comment footer, and a **required**
`build` block in the result JSON (schema 2.1): *a result that cannot name its own build no longer
type-checks.* Failed calls keep their receipts (tokens, model, promptVersion on `skipped`).
`DRIFTWATCH_DEBUG_WIRE` documented with the reason it exists: **check the wire before changing a
prompt.**

*Two holes the guard exposed:* the test suite spawned `dist/` **without building it** — the same
five-day bug in test form, green assertions about code that isn't under edit (vitest now builds via
globalSetup); and a test swallowed stderr, so the guard's own refusal surfaced as a bare
`expected 1 to be 0`. **A test that hides the error text costs more than the test saves.**

*Process rule adopted:* every command names its entry point and whether it needs a build —
`npx driftwatch` (dist, self-building), `node dist/…` (needs build, refuses if stale),
`npx tsx src/…` (source, header says "from source"), `npx vitest run` (both, builds first).

*Reporting discipline note:* the previous session's 72-minute run and build failure **did not
reproduce** (same command, 280s, symmetric samples) — reported as fact with the cause withheld,
and the cause turned out to be transient machine state. Withholding the cause was correct; the
retraction is recorded rather than quietly dropped.

| 1 | **"bundle size" is 69 MB and isn't a bundle** — it's all of `.next` minus cache (3,224 files, ~11 MB server, ~9.6 MB client JS). A server-only change moves the headline metric though nothing shipped to a browser changed. `collectedBy` is honest; the label oversells. | **Split the metric**: `client_bundle_size` (what ships to browsers — the headline) and `build_output_size` (everything). Renaming a headline metric is a schema break; do it now, before anyone depends on it. |
| 2 | **Stale base + changed dependencies still yields a confident verdict.** 143 commits / 2 months behind, 395 lockfile lines different, and the tool still says "regression +6.5%" with the dependency change as a quiet footnote. | Both are **verdict-softening conditions, not annotations**: when the base is far behind or the lockfile differs, the verdict downgrades to `inconclusive-context` — the numbers stand, the *attribution* doesn't. Same doctrine as movement-vs-drift: the strong claim needs a licence. |
| 3 | Terminal doesn't group identical policy skips (the comment renderer does) — 24 rows of noise around 4 of signal. | Group in the terminal too; one renderer rule, both surfaces. |
| 4 | `(full error: --json)` printed where there is **no error** — an absent base row for branch-only routes. | The pointer must not lie (v44 principle) — suppress it when there is nothing to point at. |
| 5 | The output never names which app was measured. | Header names the app in multi-app repos. |

**Stale-base finding.** Base defaulted to `main`, which was 143 commits / 2 months behind — the team
merges to `staging` and main lags until release. Even a successful comparison would have been
meaningless. **Warn when the resolved base is far behind the branch's likely integration target**
(and see open decision 2 — warning is not enough).

## 9b. Drift alerting — M10 (opened 2026-08-24)

**Design axis: the alerting threshold is not the reporting threshold.** An alert spends someone's
attention; a dashboard row costs nothing. Alerting exists *only* for what the PR flow cannot
structurally see — accumulation where every step stayed under the bar.

**Thresholds (step 1, `09068d8`) — justified by meaning, not by noise.** Measured first: every
byte-class segment in the real 39-entry branch drifts ≤0.01% cumulative, largest step 0.02%.
Nothing here is noise-constrained, so any line above ~0.1% yields zero false positives — which
means the numbers *cannot* be defended as "safely above noise" and must be defended by what they
mean:

| Constant | Value | Reason |
|---|---|---|
| cumulative | **10%** | 2× the PR threshold. At exactly 1× an alert could describe something one review might have caught; at 2×, combined with the step rule, it always represents accumulation no single PR could have blocked. |
| min points | **5** | Derived: with every step under 5%, reaching 10% needs ≥3 contributing steps (4 points), plus one wobble's margin. Reachable — 3 of 6 real segments clear it. |
| re-alert | **+10 points** | The second alert must be as big a claim as the first, or it is nagging. |
| resolve | **5%** (half) | Hysteresis. Clearing at 9.9% and re-firing at 10.1% teaches the reader to mute it. |
| shape | **net share ≥ 0.5** | `\|cumulative\| / sum(\|steps\|)`. |

*The shape rule changed under evidence:* a count-based rule ("≥60% of steps move with the drift")
died on real data — byte noise reached 8/13 same-direction, and a metric that ratchets up in four
jumps and dribbles down in five is real drift a count rejects. Magnitude-based, 0.5 sits above
every real-noise run (0.000–0.429) and below every shape genuinely going somewhere.

**Window trim** — the window starts after the last PR-visible step. If a commit crossed the
threshold alone, the PR flow had its chance; the alert's subject is only what accumulated since.
Without it, one loud commit either poisons the window forever or makes the headline a lie.
**Resolution is measured from where the alert was raised**, not the current window — a large
recovery step re-cutting the window and closing the alert as "superseded" is technically
defensible and useless to read.

**The payload carries three obligations:** it names what the PR flow missed (structurally true,
not hopeful); it never names a culprit commit (tendency, not attribution); and it counts only
measured points ("over 14 measured points spanning 16 commits", never folding unmeasured commits
into the number).

**Protocol relevance is per-class and causal (DECIDED, M10 step 1 finding 2).** Protocol identity
was global per-entry, so a Chrome bump split every metric's timeline — including
`client_bundle_size`, which Chrome cannot influence (4 of 5 breaks on the real branch). A field is
relevant to a metric class **if it can be a causal input to producing that number**, and the map is
declared per class with its reasoning, **defaulting to relevant**. This is not the M5 relaxation we
refused: that one asked whether Chrome *build* differences affect Lighthouse *rendering* (an
empirical assumption with no spread data behind it); this asks whether Chrome is an input to
`next build` (it is not). **Note the provenance split within the byte classes:**
`client_bundle_size` / `build_output_size` come from the build → browser irrelevant;
`transfer_size:*` comes from Lighthouse → browser **is** relevant. Relevance follows measurement
provenance, not metric units.

**Single-step rule kept though unreachable at defaults** (with max step <5% from the window trim
and cumulative ≥10%, one step can never be half the total). It becomes load-bearing when a team
raises `threshold` in `perf.yml`. Documented with its arithmetic rather than pretended to work.

### 9c. The decision audit (M10, 2026-08-24) — a permanent practice

Triggered by finding one decided-but-unimplemented rule. **The audit found a second, worse slip
from the same family**, and both are the M8 class: *a change voids a guarantee without touching
it.*

- **Never written:** the byte-class floor exemption (v46). Fixed — one `isFloorExempt(id)` serving
  `compareMetrics`, `drift.ts`, `movement.ts`; the founding case is now pinned
  (client_bundle_size +140KB on 9.6MB → `regressed`, was `no_change`).
- **Written correctly, then silently invalidated by a rename:** `DEFAULT_KEY_METRICS` still named
  `bundle_size`, retired by the M8 split. On a *default* config — the documented normal case — a
  client-bundle regression could not produce a regression verdict, **and since analysis runs only
  on that verdict, the AI never saw a bundle regression at all.** It survived three milestones
  because every run-verdict test used `build_time` as its key metric. Closed as a class, not an
  instance: `DEFAULT_KEY_METRICS` is now cross-checked against `isKnownMetric` — the registry that
  validates `perf.yml` had known the truth all along. A future rename fails a test instead of
  demoting a metric in silence.

**Rule adopted: the audit is periodic, not one-off.** Every decision recorded between an approval
and the next task lives in that gap; the survey is how the gap gets closed. Everything else
surveyed was verified present in code.

**Three items surfaced by the audit, now decided:**
1. *Expired, never re-decided:* "route metrics stay non-key until the full Layer 2a picture exists"
   — it exists, and they are still non-key. **Keep them non-key.** The original reason expired but
   a better one replaced it: CI browser/timing noise in verdicts is exactly what
   environment-conditional quanta and the movement doctrine spent two milestones keeping out.
   Recorded as decided-on-current-grounds, not as an unresolved leftover.
2. *Doc ≠ code:* conventions promised "a confidence/noise flag" per measurement; the code records
   samples + `sampleValues`, which is **richer**. Fix the doc, not the code — inventing a flag to
   satisfy prose would be a scalar summary of data we already carry in full.
3. *Stale prose:* two spec passages still name `bundle_size` post-split. Correct the prose.

**Per-class causal relevance — implemented and measured.** `relevance.ts` declares each class with
its collector and the fields that cannot be causal inputs, defaulting to relevant. Checked against
actual collectors first: `transfer_size:*` comes from `lighthouse.ts` → stays browser-relevant
despite being bytes; **`route_latency:*` turned out to use plain fetch against the booted server —
no browser on the path — so it joins the build side.** On the real 39-entry branch, breaks fell
**5 → 1** (only the driftwatch 0.5.0→0.6.0 bump survives); four were Chrome patch bumps splitting
lines Chrome had no part in producing. Browser metrics keep exactly their prior strictness. *Also
caught:* regenerating goldens deleted every protocol break from them, leaving the fixtures pinning
nothing about §5.1 — both now carry an `lcp:/` series so a Chrome bump is pinned splitting the line
Chrome actually measured.

### 9d. Drift alerting step 2 — the firing surface (`121a966`, 391 tests) — M10 CLOSED

**Surface: a GitHub issue, not a comment** — drift is about the default branch, so there is no PR
to attach to. One issue per open condition, upserted; the four states map onto its lifecycle
(fire → open, worsened → comment, resolved → close, superseded → close).

**"Superseded — not resolved" is the transition that matters**, and it is written to be weaker than
resolution on purpose: when the alert's starting point falls outside a comparable protocol segment,
*there is no measurement showing the drift came back down, and none showing it persists.* The claim
is retired **on provenance rather than on evidence**, names what changed under it (node v24 → v26),
and says it will be reported again as a new alert once 5 points accumulate under the current
protocol. A test asserts every occurrence of "resolved" in that body is preceded by "not".

**Finding the issue again uses a stored handle, not a search.** Search is indexing-lagged and
listing paginates past the marker on a busy repo — both produce duplicate issues, the one failure a
self-updating surface must not have. The handle is opaque to core (`{kind, ref}`), so hard rule 1
holds: core stores a string, the adapter gives it meaning. A 404 means a human deleted it → open a
fresh one, don't raise.

**State records what was said, not what was decided.** Only *delivered* events reach `alerts.json`;
a failed publish records nothing, so the next run says it again. The alternative — a condition
suppressed forever that nobody was ever told about — is the worse failure. Alerting never *creates*
`perf-data` (it reads a history that must already exist); test-asserted.

**The no-fire proof, run twice — with and without a token.** *A quiet run without credentials
proves nothing: silence has to be a decision, not a missing credential.* Same line both times, and
the decision itself was inspected for speaking events (0) before a live token was handed to it; a
unit test drives the same path with a token present and an exploding fetch → zero API calls.

```
driftwatch alerts: quiet — nothing created, nothing commented
(5 metric(s) assessed, none past the 10% line; 0 open condition(s); 13 never alerted (licence))
```

**Not proven live, and deliberately so:** an issue actually opening on the real repo — our own
history drifts ~0.01%, and the only way to force it would be to fabricate points on the real
perf-data branch. **Fabricating evidence to complete a proof is the one thing this project must
never do**; the firing path is proven on real git data in a scratch repo instead, and the real
first fire will be a real one.

## 9e. M11 — AI as a clean optional tier — CLOSED (`cf7f107`, 463 tests)

**The product promise, stated plainly: Driftwatch measures for free and forever without any API
key. AI explanation is an optional tier the user turns on with their own key.** BYOK has been the
design since day one, but it has never been *productised* — it works, and it is not yet clean.

**The feature matrix must be explicit, documented, and enforced:**

| Needs no key | Needs the user's key |
|---|---|
| measurement, comparison, verdicts, thresholds | analysis (cause / confidence / evidence / fix) |
| PR comment, CI check, step summary | verified auto-fix PRs (there is no fix to verify without analysis) |
| record, replay, movement report | `driftwatch eval` |
| trends, dashboard, drift alerting | |

Every keyless surface must be *fully* functional — not degraded, not nagging. A user who never adds
a key should experience a complete tool that mentions the optional tier once, in the one place it
is relevant (a regression it could have explained).

*Step 1 (`0bcbfb3`, 403 tests) — DONE.* Ten paths audited with every key variable deleted; nine
were already clean. **Five findings, all fixed:**
- **Every clean compare run named the tier** — "AI analysis skipped: analysis runs only on a
  regression verdict (spec §7)" on every green PR forever, with an internal spec reference leaking
  into user-facing text. Root cause was a **contract conflation**: "there was nothing to explain"
  was reported as `skipped`, the same outcome as "we called the provider and it failed". Split into
  `not_applicable` (silent on human surfaces, still in the JSON for machines) and `skipped` (a real
  attempt that cost tokens — still reported, because hiding spend is rule 3 in reverse).
- `--no-ai` nagged in the comment while staying silent in the terminal. Both silent.
- The keyless note framed the free tier as a **fork anomaly** ("normal for fork PRs") — a user who
  simply never bought the tier reads that as misconfiguration. Now tier-first, **and** `fromFork` is
  plumbed so a fork PR gets the accurate mechanism (repository secrets aren't exposed to fork runs)
  instead of advice to set a key it cannot see. *Deleting the fork text would have traded one wrong
  framing for another.*
- `auto_fix` with no key was a correct but unexplained no-op — now explained **inside the same
  mention**, since one key unlocks both; one breath, one mention.
- `driftwatch eval` threw a raw stack trace; refusing is right, the shape was not.

`src/core/tier.ts` is the single source of truth: each capability declares its tier, **each AI-tier
one declares why a key is unavoidable ("needs a key" is a claim, not a category)**, and the one
sentence any surface may say lives there. A test regenerates the README table from `CAPABILITIES`.
`tests/keyless.test.ts` asserts the **strong** form — not "it works without a key" but "it does not
mention the tier at all" — plus exactly one mention on a regression, and silence again once it's
gone.

*Step A — key handling (`316947b`, `9fd0a82`, 417 tests) — DONE.* Resolution lives in
`src/core/key.ts`, **not** `src/ai/` — the CLI must know whether the tier is available without
loading that module graph (hard rule 6). Three sources ordered by **how explicitly each says "use
this key for driftwatch"**: `DRIFTWATCH_API_KEY` (tool-specific, wins outright) → `key_command` in
`perf.yml` (project-explicit; stdout is the key, so a password manager supplies it and it never
touches a file) → `DEEPSEEK_/OPENAI_/ANTHROPIC_API_KEY` matched to the configured provider
(fallbacks say nothing about driftwatch, so they lose to anything that does — and an OpenAI key is
never silently used as a DeepSeek key). **A failing `key_command` is not the free tier**: "not
signed in" is a broken setup the user asked for, so it reports as a failure carrying the command's
own first line; only "nothing configured" stays `no_key`.

**Literal key in `perf.yml` → refuse before any measurement, exit 1.** Detection is deliberately
over-eager (key-shaped values anywhere, plus any secret-named field even when its value looks
harmless — better to refuse `api_key: hunter2` than let one real key through for want of a prefix).
The message masks what it found, offers both supply methods, and **tells the user to rotate**,
because by then the key is in the repository's history. Also: the key now travels as an argument
into `ai/` instead of being read from the environment there, and `aiKeyPresent()` was deleted — *a
second, narrower answer to "is the tier on?" is exactly how surfaces start disagreeing.* A test
proves neither the key nor the vault path reaches the result JSON, which is committed to
`perf-data` where a leak has a long half-life.

**Test doctrine (adopted here, generalised from three separate flakes):** *an assertion that
depends on a timing metric staying under the floor is a flaky test by construction.* Load makes a
50ms build cross the threshold and the tool then behaves **correctly** — the test is what's wrong.
Rule: tests assert against **deterministic byte classes**, or against the **policy as a pure
function** over known inputs, never against which branch a timed run happened to take. The same
licence doctrine that governs movement attribution governs our own assertions.

*Doctrine applied (`e5433b8`, 431 tests).* `escalation.test.ts` split the two things it was
conflating: the **policy** as a pure function, exhaustively (all 15 unit×verdict pairs, plus mixed
and empty tables — six tests became twenty, and no machine is involved), and the **plumbing**
without the branch (run one leaves a cache entry, run two reads it; the test accepts
`['screened','confirmed']` and then asserts the *invariants* of whichever was taken — screened ⇒
from cache, no escalation line; confirmed ⇒ escalation line, fresh base). The poisoned-cache test
keeps its escalation assertion (2× + 1000ms is outside every floor on any machine) but **lost its
tail**, which asserted what the confirming run then measured — the same disease one layer down.
Sweep: escalation was the only remaining instance; `serve` bounds a timing metric **only in the
direction load cannot move it** (`>= 5` for a 5ms sleep), which is the safe form. **A coarser
fixture is not a fix** — it lowers the probability, costs test time, and leaves the flaw.

*Timeouts:* a duration cap says nothing about correctness when it trips, so it belongs **well past
the loaded worst case**, not tuned near it (600s → 1200s for a 152s-unloaded test running parallel
with real builds). *And a filtered command that captures a FAIL without its assertion text is how a
red commit happens* — keep full output on failure.

*Step B — `driftwatch doctor` (`8ddeb00`, 442 tests) — DONE.* Reports, never fixes, never writes;
reads step A's resolver so no second answer to "is the tier on?" can appear. **No key exits 0** and
reads *"measurement is ready. The AI tier is off, which is a choice, not a fault"* — with the
capability list rendered from `tier.ts`, not maintained twice. Decisions worth keeping:
- **One call, several facts** — reachability, served model, and a real token count come from a
  single completion, not three probes: the cheapest honest way, and every number reported was
  measured rather than assumed.
- **A reply that arrives but won't parse is a warn, not a fail** — it proves reachability; calling
  it a connectivity problem sends someone to their firewall over a chatty model.
- **Cost is a ceiling, not a guess** — computed from the four constants that actually bound a run
  (both context budgets, both output caps), the line names them, and cites the one figure the eval
  set measured. An unpriced model says "cost unknown"; a real charge below display precision says
  `under $0.0001`, because `$0.0000` reads as free.
- **Served-vs-requested model is surfaced** (deepseek-chat → deepseek-v4-flash), the M6 lesson made
  visible at diagnosis time.
- Redaction goes one step past step A: doctor prints neither the key **nor the `key_command`** — a
  vault path names where the secret lives, and a diagnostic is the output most likely to be pasted
  into an issue. Added as an explicit option rather than changing step A's accepted behaviour.
- *Found and deleted:* `registry.ts` still exported its own `resolveApiKey` reading only
  `DRIFTWATCH_API_KEY` — dead at runtime but wrong (it returned `null` for a user with
  `DEEPSEEK_API_KEY` set), **with a test still pinning the pre-step-A contract as if correct.**
  Same disease as `aiKeyPresent`, same one the M10 audit caught: **a superseded implementation with
  a passing test is worse than no test.**

*Step C — cost projection + cap (`70bba0a`, 451 tests) — DONE.* `ai/cost.ts` holds the arithmetic
once: doctor prints the ceiling, the run projects the specific diff, and **a test asserts the two
cannot drift** (a projection's worst case is exactly doctor's ceiling). **An upper bound by
construction** — triage input is exact (the context is already assembled), its output scales at
M9's measured ~47 tok/changed file; deep is bounded by budget and cap because what deep is shown
depends on suspects triage hasn't named yet. **Overstating is the safe direction for a ceiling.**
Audited against the run it was modelled on: the 31-file case measured $0.0130, the projection
brackets it above within 4×, and *both bounds are asserted — if the model stops bracketing reality
the suite says so.*

`max_cost_per_run` (unset by default) **refuses — never truncates, never downgrades the model** —
with its own outcome `cost_capped`, following the step-1 lesson that distinct facts get distinct
names (it is neither `skipped` nor `not_applicable`). Reports projection, cap, the arithmetic, and
both remedies, once per surface, never as an error. **An unpriced model with a cap set is also
refused** — a projection that cannot be priced cannot be shown to be under the cap, and it says so
rather than inventing a number: *a ceiling that can't be honoured isn't quietly ignored.*

**Actual beside projected on every analysed run** — the token model is audited by reality in the
field, on every run, instead of by argument. **Cumulative spend is not tracked, and the README says
so in those words**: driftwatch doesn't know your provider bill and won't pretend to — a running
total we never measured is the same error as an estimate presented as a measurement.

*(Bug the suite caught: an absent cap field read as a configured ceiling — `undefined !== null` —
refusing every analysis on any result written before the field existed. Ten tests went red at once,
which is what made it obvious.)*

*Step D — named provider errors (`9d53697`, 461 tests) — DONE.* Five provider-agnostic
conditions; detection is not agnostic and stays inside `providers/` per §7.1:
`invalid_key` (401/403); `no_credit` — **DeepSeek's 402 + "Insufficient Balance" and OpenAI's 429 +
`insufficient_quota` are the same fact in different envelopes**; `rate_limited` (429, carrying
`Retry-After`, and saying plainly that driftwatch does not queue or retry across runs);
`unknown_model` — **detected from the payload, not the status**, because vendors phrase it four
ways and disagree on 400 vs 404; and `unknown`, which carries the provider's words verbatim.

**The default row is the principle: a wrong name is worse than no name** — it sends someone to
their billing page over a proxy problem. The unclassifiable case says plainly that driftwatch has
no named remedy, and keeps the generic stanza and the `DRIFTWATCH_DEBUG_WIRE` pointer.

Stanzas name the exact page, not "check your account", and **say that measurement is unaffected** —
for a keyless-tier product that is the thing the reader most needs to know. `invalid_key` names
**where the key came from** (step A's resolution): *"the key from `DEEPSEEK_API_KEY` was rejected"*
and *"your `key_command`'s output was rejected"* are different debugging sessions. The key is never
printed, asserted including inside the serialised error.

**One event, one description:** a test builds the expected stanza independently and asserts that
doctor's check and a mid-run `analysis: skipped` both equal it for the same mocked 402 — a user who
ran doctor yesterday and hits the failure today reads the same words. The measurement verdict is
untouched in both: *a provider with no credit says nothing about the code that was measured.*
(Two tests encoding pre-step-D behaviour were rewritten to the new contract rather than worked
around.)

*Step E — disclosure (`cf7f107`) — DONE, M11 CLOSED.* **Generated, not written**, and three
refactors were needed to make that true rather than decorative: context headings moved out of the
renderer into `sections.ts`, each paired with the line that discloses it — *so an undocumented
section throws in the code that would have sent it, rather than silently shipping*; secret patterns
became `{pattern, label}` pairs, because a regex and the words the README uses for it cannot drift
when they are the same object; the destination table moved to `core`.

**A near-miss worth keeping:** the first version had the PR comment importing `ai/disclosure.ts`,
which would have dragged the AI module graph into a keyless comment render — exactly what hard rule
6 exists to prevent, and something the `--no-ai` module test watches on the CLI path and might not
have caught. Caught before shipping, but only just.

**The destination is named plainly, jurisdiction included** (DeepSeek — a Chinese company; OpenAI
and Anthropic — US), stated neutrally so the reader decides. Nothing leaves without a key; with a
key, only on a confirmed regression; then the eight things that travel, the seven secret families
that never do, and the four never sent under any setting (the key, the `key_command` and its
output, absolute paths, anything outside the diff). The `contextManifest` is named as the receipt:
**the docs say what we do, the manifest says what we did on your run.** The same sentence appears in
the PR comment and in doctor, **present tense on purpose — printed both before anything is sent and
after it was, and one claim has to be true in both places.**

Tests: docs-vs-code equality; golden contexts contain exactly the documented sections and no others;
every pattern carries the label the README shows; and a canary planted in *every* documented secret
family cannot appear in either assembled context **even when the file is named as a suspect** —
*being asked for is not a reason to send it.*

*Unplanned live proof:* a fake key produced a real DeepSeek 401 that came back through step D's map
correctly — real vendor payload, named condition, right stanza, key source identified, and DeepSeek
masked the key in its own message, which was passed through verbatim without ever printing ours.

**Scope (as planned):**
1. **The contract & audit** — verify no non-AI path can fail, prompt, or warn because of a missing
   key; the one mention appears only on a regression. `auto_fix` with no key must be a clean,
   explained no-op, not an error.
2. **Key handling** — env only (`DRIFTWATCH_API_KEY`), plus per-provider fallbacks users already
   have set (`DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`). A `key_command` in
   `perf.yml` so a password manager can supply it (`op read …`) — the command's output is used and
   never stored. **Refuse to run if a literal key appears in `perf.yml`** and say why; someone will
   try it.
3. **Verification** — `driftwatch doctor`: is a key present and from where, is the provider
   reachable, does the model exist, one minimal call, and what a typical analysis costs. Without
   this, users debug blind.
4. **Cost transparency & control** — pre-flight estimate from M9's measured token model, per-run
   cost already shown, and an optional `max_cost_per_run` that refuses rather than surprises.
5. **Named errors with fixes** — 401 invalid key, **402 no credit (we hit this ourselves)**,
   429 rate limit, unknown model. Each with its stanza, per the failure-legibility rule.
6. **Disclosure** — README section on exactly what is sent (generated from the golden contexts),
   the secret-withholding list, and the per-run `contextManifest`.

## 9f. Launch (M12, opened 2026-08-24)

**Decided:** repo goes **public** — the product's claim is "trust my measurement discipline", and a
tool that says that while hiding its code asks for faith rather than trust; inspectable methodology
is the strongest sales argument, and it unblocks the Pages leg deferred at M5. **License:
Apache-2.0** — explicit patent grant, the form corporate legal teams are comfortable adopting into
CI. Neither choice blocks a hosted paid tier later (M5 roadmap). Restrictive licences were rejected:
at zero users, adoption outweighs protection.

**Name confirmed:** `driftwatch` still free on npm, `@driftwatch` scope free (re-verified
2026-08-24). Note `drift-watch` (hyphenated) is taken by someone else.

**Order:** pre-public audit → README → LICENSE + repo metadata → publish prep + clean-room `npx`
smoke test → flip visibility, Pages on → `npm publish` → Marketplace listing → announce.

**Audit outcome (step 0):** secrets — **clean across all 155 commits and 5 refs**; the only real
finding was a *profile* of a private personal project (name, monorepo shape, build scale, staleness,
failure modes) across 16 files at HEAD, 25 commits' contents, and **8 commit bodies** — caught only
because the first pass checked subjects and had to be corrected. **Decision: scrub HEAD, keep
history.** No third party and no secrets are involved, the 155-commit trail is the strongest
evidence for the methodology the README will claim, and a rewrite would dangle ~40 SHA citations
plus the perf-data index. **Anonymise anyway, because anonymising is reversible and publishing a
name is not** — the identity goes, every technical lesson stays. Also: the two `perf/lodash-*`
acceptance branches are deleted (147 commits of experiment, documented already in this spec);
`.npmrc` and the `sk-…` fixtures are non-findings.

**Step 0 is a pre-public audit, and it is not a formality.** Going public exposes the entire git
history at once and irreversibly. Three things to sweep: (a) any secret ever committed, in *any*
commit, not just HEAD; (b) references to **the trial project** — a real project of Ahmed's — in fixtures, tests,
eval candidates, scratch paths, or commit messages; (c) absolute paths carrying a username, which
the tool already refuses to send to a provider and should not publish either.

**README shape (agreed, 14 sections).** Built to answer the visitor's real first question — *"how
is this different from running bundlesize in CI?"* — before they scroll. Order: (1) pitch + a real
PR comment rendered as markdown — **show the artefact before explaining it**; (2) quickstart, three
commands, no key; (3) **why most perf CI is untrustworthy and what this does instead** — the
differentiator, framed as a problem the reader recognises (numbers swinging 20% between identical
runs); (4) what it measures, with byte-vs-wall-clock honesty; (5) **the four refusals** — never
touch your tree, never report an unmeasured number, never compare across mismatched protocols,
never attribute what it can't; (6) the AI tier table, generated from `tier.ts`; (7) verified fix
PRs; (8) trends, drift, replay; (9) what leaves your machine; (10) config; (11) CI setup;
(12) cost; (13) how it was built, linking the spec; (14) requirements, status, licence.

*Three shape rulings:* §3 comes **before** §4 — metrics without the trust argument read as a
feature list. §5 stands alone rather than scattering the refusals — **the refusals are the tool's
personality and they earn the space**. §13 links the spec rather than summarising it — a 1,500-line
document that is genuinely good competes badly with its own summary, and a reader deciding whether
to trust the numbers can read the reasoning behind every threshold. The cost of §13 is that the
full internal design history becomes public reading, §9a included; accepted knowingly.

**The README is the product's face and the biggest gap.** Nobody outside this repo can currently
tell Driftwatch from `github-action-benchmark`. It must *show* the philosophy rather than lecture
it — the "measured, but not attributable" output argues the whole case in one block — and it must
be honest about what the tool does not do: production monitoring, cross-machine comparison, and
timing attribution (which stays unlicensed until Layer 3).

## 10. Git History Replay — M7, CLOSED (2026-08-20)

Checkout, build, and measure the last N commits to reconstruct a performance timeline
retroactively. Delivers a "wow" moment in the first hour instead of after a month of data
collection: *"Your performance started degrading 6 months ago, at commit abc123."* Second payoff,
recognized at M2: **the eval-case factory** — every real historical regression found by replay is
a candidate eval case, converting the hand-built 4-case set into dozens from reality.

**Original constraints (v1 of this spec — all still hold):**
- Expensive → **optional**, user picks N, cost estimate + confirmation upfront (estimated from the
  machine's own last record run)
- Old commits may fail to build (stale deps, different runtime versions) → mark as `skipped` with
  reason + log tail and continue; **never abort the run**

**M7 design decisions:**
- `driftwatch replay --last N | --since <ref>`, **first-parent only** — the merge-commit mainline
  is the project's real history; measuring every feature-branch commit doubles cost for no meaning.
- **Local-first**: replay runs on the developer's machine (record mode, no AI); ONE batched
  perf-data update at the end, local by default, `--push` to publish. Interrupt-safe: partial
  results land in `.perf/replay-pending/`, a rerun resumes.
- Entries carry `replayed: true` + the commit's **author date** — measurement time ≠ commit time,
  and consumers must see the distinction. All replay points share today's protocol → **one clean
  segment by construction** (asserted in tests) — the M5 churn problem solved for free.
- **Forced ordering fix**: timelines built in append order break the moment replay inserts older
  commits after newer entries. Timeline ordering moves to commit topology (author-date fallback);
  index entries gain commit timestamp + parent linkage. Existing branch data must render
  identically after the migration.
- Dedup: commits already in the index are skipped.
- *Step 1 (DONE — `62365c7`, `3cee4cb`):* topology ordering via Kahn's algorithm with date +
  append-index priority — **rebases can author-date a child before its parent**, so parent linkage
  outranks dates; pre-M7 byte-goldens pass unchanged (the migration proof). Cost estimate reads the
  machine's own last record run; with none it says **"unknown — the first commit will calibrate"**
  rather than inventing a number. Zero-metrics-measured maps to §10's "fails to build" (measurement
  never throws by convention). Resume from `.perf/replay-pending/` proven; one-segment-by-
  construction test-asserted.
- Step 2 scope: dashboard renders replayed points visually distinct; a **movement report** names
  the commits where metrics moved beyond noise (same floor+quanta machinery, consecutive points
  within a segment) — the wow moment and the eval harvest in one surface.

**Movement doctrine (DECIDED at M7 live proof):** movements are **per-commit attribution** — the
strongest claim the tool makes ("your perf moved AT this commit") — and attribution requires a
license the wall-clock classes don't have across time gaps: local sequential replay marches
monotonically under sustained load/thermals (observed: build 9.94→12.47s across a 10-minute run,
+22.3% "movements" on innocent commits), and CI record points carry the M5 **runner lottery**
(build +65.3% on comment-only pushes). **Rule: the movement report judges deterministic byte
classes only (`bundle_size`, `transfer_size:*`) in every environment.** Wall-clock classes stay in
the data and on the dashboard but are labeled "not judged — cross-time-gap timing (§5.1 fifth
instance / runner lottery)". The asymmetry with drift is deliberate and stated: **drift** is a
segment-level *tendency* (weaker claim, keeps timing with its honest language); **movement** is
per-commit *attribution* (stronger claim, byte-license only). Revisit when a per-point CPU probe
(benchmarkIndex-style normalization — option C, real design work) provides a license; one
machine/one session was rejected as a calibration basis. The byte-class demo line is the product:
3 buried events found, correct directions including the improvement, silent on all 7 innocents.
Harvest folders follow the same rule for free (3, not 7).

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
