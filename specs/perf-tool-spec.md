# Driftwatch — Project Spec

*Working name. CLI command: `npx driftwatch run`*

> Living document. Update it whenever a decision is made or changed.
> Version 11 — 2026-08-18

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
2. **Measure baseline and PR in the same job on the same machine.** Cancels most machine variance.
3. **Instruction counting (Layer 3).** Eliminates the problem entirely for CPU-bound work.

Anything below a ~2% delta is treated as noise and not reported.

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
- heavy detail inside collapsed `<details>` blocks
- footer: baseline commit, trend link, open-fix-PR link, adjust-threshold link

Mockup built: `pr-comment-mockup.html`.

### 6.2 CI check

A status check carrying the same verdict, so teams can block merges on it.

**DECIDED — warns by default, never blocks on install.** The check reports a neutral/warning status
even when the threshold is crossed. `block_merge` exists in `perf.yml` and is set to `false` by
default; a team turns it on once they trust the numbers.

*Reason:* a newly installed tool that blocks merges gets uninstalled, not fixed. Trust has to be
earned by being right for a few weeks first. The cost of this choice is that the tool is ignorable
early on — mitigated by making the PR comment itself impossible to miss (§6.1).

### 6.5 Distribution — GitHub Action (DECIDED)

Ship as a plain GitHub Action, not a GitHub App.

*Why:* no OAuth, no hosting, no permission model to operate. The user adds a YAML file and it runs —
and it runs **inside their own CI**, which is exactly the §5 decision. A GitHub App only becomes
necessary for centrally-held state (team dashboards, alerting, subscriptions), all of which is
post-MVP. Because of the §3.1 split, moving to an App later is adapter work, not a rebuild.

### 6.3 Static dashboard (no backend)

Store measurement results as JSON in a dedicated branch in the user's own repo (`perf-data`), and
serve a statically-exported dashboard (Next.js → GitHub Pages) that reads it.

- No server, no database, no auth
- Data belongs to the user, in their repo
- Consistent with zero-config and BYOK
- Precedent: `github-action-benchmark` does exactly this

Covers what a PR comment can't: trends over time, Git History Replay charts, branch comparison.

### 6.4 Hosted dashboard — later

Build only when monetizing teams (multi-repo, alerting, permissions), with paying users to justify it.

**Build order:** PR comment → CI check → static dashboard → hosted dashboard.

---

## 7. AI Analysis Pipeline

**Trigger rule: AI only runs on a detected regression.** Measurement itself is plain scripts, no AI.
Expect AI to fire on roughly 5–10% of pushes.

### Two-stage routing

1. **Triage (cheap model — Haiku)** — real regression or CI noise? Which files are suspects?
2. **Deep analysis — Sonnet (DECIDED).** Only if stage 1 confirms. Input: diff + benchmark deltas +
   relevant code (+ profiling data such as a flame graph). Output: root cause, confidence score,
   suggested fix.

**Why Sonnet, not Opus:** reading a diff plus benchmark deltas and inferring a cause is
medium-complexity reasoning, not open-ended research. Opus buys a marginal gain on hard cases at
roughly double the cost — not justified yet.

**The model is config-exposed** (`provider:` / `model:` in `perf.yml`). With BYOK the user pays, so
the choice is theirs. Once real usage data exists, revisit with numbers instead of guesses.

### 7.1 Provider abstraction — required from day one

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

### 7.2 Evaluation set — build it early

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
1. **Auto-fix PR** — don't just describe the fix, open a reviewable PR with it. Turns the tool from
   a report into a teammate.
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
