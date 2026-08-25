# Driftwatch

Measures your app's performance on every pull request, compares it against the base commit under
an identical protocol, and — optionally, on your own API key — explains what caused a regression
and proposes a fix it has already measured.

Free and fully local without any API key. Node 20+, git, and a Next.js project.

---

## 1. What lands on your pull request

This is a real comment, rendered from
[`tests/golden/comment-regression-analysed.md`](tests/golden/comment-regression-analysed.md) — the
golden file that is the adapter's contract. Its three collapsed `<details>` sections and the
footer are omitted here for length; nothing else is changed.

> ### ⚠️ Performance regression detected
>
> **build time (cold)** is up +7.2% against baseline `main@c0ffee0`. Threshold is 5%.
>
> | Metric | Base | This PR | Change |
> |---|---|---|---|
> | build time (cold) | 8.72 s | 9.35 s | **+7.2%** ⬆️ |
> | client bundle size | 921.0 kB | 921.0 kB | no change |
> | build output size | 2.20 MB | 2.20 MB | no change |
> | install time | — | — | skipped — dependencies provided by cloning the existing node_modules |
> | 4 rows excluded by policy | — | — | prerendered (SSG) |
> | route /blog/[slug] | — | — | skipped — dynamic segment — no concrete URL to measure |
>
> ### Likely cause  `confidence 90% (high)`
>
> lib/posts.ts adds a 300-entry archive consumed by generateStaticParams, adding ~300 statically
> generated pages to the build.
>
> **Evidence**
> - build time (cold) regressed 8724ms → 9350ms (+626ms, +7.18%); samples [11143, 8629, 8724] vs [11810, 9350, 9349]
> - lib/posts.ts (+25/-1) introduces the archive array that /blog/[slug] statically generates
>
> **Suggested fix** (ready diff)
>
> ```diff
> --- a/lib/posts.ts
> +++ b/lib/posts.ts
> @@ -1 +1 @@
> -const ARCHIVE_SIZE = 300
> +const ARCHIVE_SIZE = 30
> ```

Four things in that comment are worth noticing, because they are the whole design:

- **The samples are shown**, not just the medians: `[11143, 8629, 8724]` vs `[11810, 9350, 9349]`.
  You can judge the spread yourself. These are the three timed builds; a warm-up build ran before
  them and was discarded.
- **`install time` and four routes were not measured**, and the comment says so instead of leaving
  gaps. A metric that failed is never silently omitted.
- **The cause cites its evidence** — a specific file, a specific line count, tied to the specific
  metric that moved.
- **The comment updates itself.** One comment per PR, edited in place on every push, never a new
  one per commit.

Everything above the "Likely cause" heading is free and runs with no API key. Everything below it
is the optional AI tier, on your own key.

---

## 2. Try it in three commands

```bash
cd your-nextjs-project
npx driftwatch run
```

That measures your working tree, checks out the base commit into a temporary `git worktree`,
measures that the same way, and prints a table. No key, no signup, no configuration file.

```bash
npx driftwatch run --json      # the full result JSON — the contract every surface consumes
npx driftwatch init --github   # writes .github/workflows/driftwatch.yml
```

What it does to your repository on that first run: **nothing**. It writes to `.perf/` and nowhere
else, never checks out a branch in your working tree, never stashes, and never creates a config
file you did not ask for. That is enforced by a test that asserts `git status --porcelain` is
byte-identical before and after a run ([`tests/rule2.test.ts`](tests/rule2.test.ts)).

---

## 3. Why most performance CI cannot be trusted, and what this does instead

The problem is not that measuring is hard. It is that the same code, measured twice, gives
different numbers — so a tool that reports a delta without controlling for that is reporting
noise with a percentage sign on it.

Here is the measurement that set the design, taken on the fixture in this repository over 5 runs
(spec §5.1, 2026-08-18):

| Mode | Times | Spread |
|---|---|---|
| Warm (`.next` kept) | 6.81s, 6.80s, 6.88s | 1.2% |
| Cold (`.next` removed) | 8.75s, 8.75s | 0.0% |
| **Warm vs cold** | | **22% apart** |

Each mode is stable. The difference between them is not. And a fresh `git worktree` checkout of
your base commit can never be warm, while your working tree usually is — so the naive comparison
reports **a 22% regression on identical code**, stably and repeatably, which is the worst kind of
wrong. It looks like a finding.

Driftwatch clears the build cache on **both** sides before every timed build, because cold is the
only state achievable on both, and labels the metric `build time (cold)` so the number is never
mistaken for the build time you experience day to day.

That example generalises into the rule the tool is built around:

> **Both sides of a comparison must be measured under an identical, recorded protocol. Where they
> cannot be identical, both are forced to the state achievable on both. Where even that is
> impossible, the delta is refused rather than reported.**

In practice that means:

- **Both sides in the same invocation, minutes apart, on the same machine.** A cached baseline is
  used only as a *screening* tool: if a cached comparison crosses the noise floor, both sides are
  re-measured fresh in the same run and only the confirmed result is reported.
- **Cold builds, median of 3, after a discarded warm-up.** Every run records how many samples, how
  they were collected, and the raw values.
- **The protocol is recorded and compared** — Node version, platform, architecture, browser build,
  CI runner labels, driftwatch's own version. If two sides disagree on any field that could have
  *caused* the number, there is no delta.

### The tool declining to make a claim

This is the other half, and it is the part most tools skip. Measuring successfully is not the same
as being entitled to blame the change in front of you. Rendered from
[`src/core/report/context.ts`](src/core/report/context.ts), for a base 143 commits and two months
behind with a differing lockfile:

> ### 〰️ Measured — but not attributable to this change
>
> > **Why this is not called a regression**
> >
> > - the base `main` is far behind this branch (143 commits ahead of it; the base commit is
> >   61 day(s) old), so a delta measures months of other people's work as much as this change.
> >   This project's branches appear to integrate into `staging` — compare against that instead:
> >
> >   `driftwatch run --base staging`
> >
> > - the lockfile differs between the two sides, so the two builds resolved different dependency
> >   trees — any delta includes whatever those packages changed.
> >
> > _The measurements above are real. What is withheld is the claim that this change caused them —
> > the same doctrine as movement vs drift._

The numbers are still there, in full. What is withheld is the attribution — because against a base
that stale, "your PR caused this" is a claim the measurement does not support. The same doctrine
runs through the whole tool: per-commit attribution is licensed only where the instrument earns it
(deterministic byte counts), and everything else is labelled as a tendency rather than a cause.

The reasoning behind every one of these numbers is in the repository, not summarised here.
[`specs/perf-tool-spec.md`](specs/perf-tool-spec.md) is ~1,500 lines of it: the measurements that
set each threshold, the approaches that were tried and rejected, the six separate occasions this
one rule had to be applied to a situation nobody had anticipated, and the decisions that were
reversed when the data contradicted them. Read it before you trust a number this tool prints.

---

## 4. What it measures

Four fixed metrics, plus five per-route classes. On this repository's fixture that comes to 17
metrics per run; on your project it depends how many routes you have.

| Metric | Unit | Notes |
|---|---|---|
| `build_time` | ms | Cold build, median of 3 |
| `install_time` | ms | Only when dependencies changed; its delta is refused by design (see below) |
| `client_bundle_size` | bytes | What ships to browsers — the headline byte metric |
| `build_output_size` | bytes | Everything the build emitted, server code included |
| `route_latency:<route>` | ms | Request-level, against the booted app. No browser involved |
| `lcp:<route>` `fcp:<route>` `tbt:<route>` | ms | Lighthouse, against a pinned Chrome |
| `transfer_size:<route>` | bytes | Lighthouse — bytes a browser actually downloads |

Two kinds of number, judged differently — the distinction the rest of the tool is built on:

**Byte counts are deterministic.** Measured twice on identical code they differ by a couple of
bytes. Across the 39 recorded points on this repository's own history, every byte-class run drifts
**≤0.01% cumulative**. So bytes are exempt from the 2% relative noise floor and gated only by a
1 KB resolution: a 140 KB regression on a 9.6 MB bundle is 1.42%, and hiding it behind a noise
rule would make the tool blind to the exact case it was built for.

**Wall-clock is not deterministic**, and no amount of care makes it so. Each timing class carries
its own resolution, measured rather than guessed:

| Class | Quantum | Why that number |
|---|---|---|
| `build_time` | 100 ms | Process spawn jitters 5–10 ms; package managers add tens more |
| `route_latency` | 5 ms | Observed ±1 ms sequential-fetch noise, ×5 |
| `lcp` / `fcp` | 25 ms local, 200 ms CI | ≤7 ms across local boots; shared runners swung −9.7%…+17.8% on byte-identical trees |
| `tbt` | 50 ms local, 100 ms CI | ±2 ms locally; +83% observed on identical code on a runner |
| byte classes | 1 KB | ±2 bytes observed; ≥1 KB is a real asset change |

The CI values are larger because the machine is part of the instrument, and a shared runner is a
coarser one. Both numbers come from measurements taken during acceptance, not from intuition.

---

## 5. Four things it refuses to do

These are enforced by tests, not by intention. Each one costs something: refusal 3 is why you
will never see an install-time delta, and refusal 4 is why the tool will not tell you which commit
slowed your build. The cost is deliberate in each case, and named below.

**1. It never touches your working directory.** No `git stash`, no checkout of your branch, no
deleting your `.next`, no writing outside `.perf/`. Both sides of a comparison are measured in
temporary copies: the base via `git worktree`, your current tree via a filtered copy. An audit
during development found three places that violated this — including creating a `perf.yml` in a
project that had not asked for one — and all three were removed rather than argued for.

**2. It never reports a number it did not measure.** There are no estimates presented as
measurements and no interpolated values. A metric that failed to collect is marked `skipped` with
the reason and, where a remedy is knowable, the exact command to fix it. When nothing could be
measured at all, the comment says exactly that rather than rendering an empty table.

**3. It refuses to compare across mismatched protocols.** If the two sides ran under different
Node versions, different platforms, different Chrome builds, or different CI runner classes, you
get the values and no delta. This is the rule that costs the most output — cached-base comparisons
escalate to a full re-measure, install deltas are permanently `not_comparable` because the base
side installs cold and the current side warm — and it is the rule that makes the deltas that *do*
appear worth reading.

**4. It never attributes what it cannot attribute.** Naming a specific commit as the cause of a
change is the strongest claim the tool makes, so it is licensed only for deterministic byte
classes, in every environment. Wall-clock movements across a time gap are reported and explicitly
labelled *not judged* — because local runs drift with thermals and CI runs land on different
physical machines. Validated on a constructed history: 3 of 3 real regressions found, 0 of 7
innocent commits falsely accused.

### What it cannot do

Stated here rather than in a footnote:

- **No production monitoring.** This measures your repository in CI and on your machine. It knows
  nothing about your real users.
- **No cross-machine comparison.** Numbers measured on your laptop and numbers measured on a CI
  runner are never compared to each other. They are separate segments, by design.
- **Timing attribution is not available**, and will not be until instruction counting replaces
  wall-clock timing (Layer 3 in the spec). Today, "build time moved at this commit" is a claim the
  tool declines to make.
- **Next.js is what is proven.** The detection layer is framework-agnostic in shape, but Next.js
  is the only framework with acceptance runs behind it. Anything else is untested.

---

## 6. AI analysis is optional

Measurement never needs a key. Explaining a regression does, and it runs on your own key with your
own provider account — driftwatch has no server and no account of its own.

<!-- feature-matrix: generated from src/core/tier.ts; a test fails if these drift apart -->

| Needs no key | Needs your own key |
| --- | --- |
| measurement, comparison, verdicts, thresholds | analysis (cause, confidence, evidence, suggested fix) |
| PR comment, CI check, step summary | verified auto-fix PRs |
| record, replay, movement report | `driftwatch eval` |
| trends, dashboard, drift alerting |  |

<!-- /feature-matrix -->

When a regression is confirmed and a key is present, two calls happen. Triage reads the diffstat
and ranks suspects; deep analysis reads the patches of those suspects and names a cause with a
calibrated confidence, its evidence, and a fix. Triage never stops the pipeline — a confirmed
regression always reaches deep analysis, because a model declining to look is not evidence that
nothing is wrong.

```bash
export DRIFTWATCH_API_KEY=<your DeepSeek or OpenAI key>
driftwatch doctor          # is the key valid, which model actually serves it, what a run costs
```

The key is read from `DRIFTWATCH_API_KEY`, or from a `key_command` in `perf.yml` so a password
manager can supply it (`key_command: op read op://vault/ai/key`), or from `DEEPSEEK_API_KEY` /
`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` if you already have one set. A literal key written into
`perf.yml` is **refused, not warned about**: that file is committed, so a key in it is already
shared with everyone who can read the repository.

---

## 7. Fix PRs that were measured before they were proposed

With `auto_fix: propose` in `perf.yml`, a confirmed regression with a machine-applicable diff gets
one more step: the diff is applied in a fresh temporary copy and **measured**, same protocol as
everything else, in the same invocation. That produces a three-way comparison — base, your PR, and
your PR with the fix — and one of four outcomes:

| Outcome | Meaning | Opens a PR? |
|---|---|---|
| `restored` | The metrics came back within the noise radius of base | yes |
| `partial` | Measurably better, not all the way back | yes |
| `no-recovery` | The fix did not move the metric | no |
| `build-broken` | The fix does not build | no |

Only `restored` and `partial` may open a PR, and the PR body carries the measured numbers. The
other two are reported in the comment and go no further. The model's own confidence is shown
beside the outcome but is never the gate: a 0.7-confidence fix that measurably restores the metric
is better evidence than a 0.9-confidence fix nobody measured.

---

## 8. Trends, drift alerting, and history replay

Push-time runs append a point to a `perf-data` branch in your own repository — plain JSON, no
backend — together with a self-contained dashboard you can serve from GitHub Pages.

```bash
driftwatch trend            # where has main been going?
driftwatch trend --moves    # which commits moved a metric beyond noise
driftwatch alerts           # what the recorded history would interrupt someone about
driftwatch replay --last 20 # measure the last 20 mainline commits retroactively
```

**Trends never draw a line across a protocol change.** A Node upgrade, a Chrome bump on the
runner, or a driftwatch version change starts a new segment, and no delta is computed across the
break. Which fields count as a break is decided per metric class by what could have *caused* the
number: a Chrome upgrade breaks Lighthouse metrics and leaves build-output byte counts alone,
because Chrome is not an input to your build.

**Drift alerting exists for what pull requests structurally cannot see** — accumulation where
every individual step stayed under the threshold. It fires at 10% cumulative within one protocol
segment, over at least 5 measured points, only for byte classes, and only when no single commit
crossed the PR threshold on its own. That is twice the PR threshold, deliberately: an alert spends
someone's attention, and it exists only for the case a review could not have caught. It fires once
per condition and then stays quiet until the drift widens by another 10 points, retreats, or the
protocol segment breaks.

**Replay** measures the last N mainline commits as they were, so a project gets history on day one
instead of after a month of pushes. It estimates the cost and asks before spending it, marks every
replayed point as replayed (measurement time is not commit time), and skips commits that no longer
build rather than aborting.

---

## 9. What leaves your machine

<!-- disclosure: generated from src/ai/disclosure.ts — run `UPDATE_README=1 npx vitest run tests/readme.test.ts` -->

**Nothing leaves your machine without an API key.** Measurement, comparison, verdicts, trends,
the dashboard and drift alerting are entirely local and always will be — that is the free tier,
and it does not phone anywhere.

With a key configured, exactly one thing sends data: **AI analysis of a confirmed regression.**
It runs only when a regression was measured, analysis is enabled (no `--no-ai` /
`DRIFTWATCH_NO_AI=1`), and DRIFTWATCH_API_KEY resolves to a key. `--no-ai` is enforced at the module
level — the AI code is never even loaded — which the test suite proves rather than promises.

### Where it goes

- `provider: deepseek` → DeepSeek (Hangzhou DeepSeek Artificial Intelligence Co., a Chinese company)
- `provider: openai` → OpenAI (a US company)
- `provider: anthropic` → Anthropic (a US company)

Your key, your account, your provider's terms. Driftwatch adds no server of its own: there is no
driftwatch backend, and no copy of your data is kept anywhere by this tool.

### What is sent

On an analysed regression, the request contains:

- the verdict this run reached
- metric values for both sides, with their deltas
- the raw samples behind every median, so the model can judge the spread
- both measurement protocols (node, platform, browser, host labels)
- the detection evidence trail — which file told the tool what
- a package-level summary of lockfile changes (added/removed/bumped, with versions)
- a diffstat of every changed file between the base commit and your working tree
- full patches for the most-relevant changed files, within a fixed token budget

### What is withheld, always

Files whose **basename** matches any of these have their content withheld. They still appear in
the diffstat — the model may know the file changed; it may never see what is in it:

- `.env` and `.env.*`
- `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`
- `id_rsa*`, `id_dsa*`, `id_ecdsa*`, `id_ed25519*`
- `.netrc`
- `.npmrc` (it often carries auth tokens)
- any basename containing `credential`
- `secret` / `secrets` and their extensions

Also never sent, under any setting or budget:

- your API key, the `key_command`, and that command's output
- binary file content (detected from content, not extension)
- raw lockfile patches — only the package-level summary travels
- absolute paths, and anything outside the diff between the base commit and your working tree

### The receipt

This section says what driftwatch does. Every run also records a `contextManifest` in the result
JSON (`--json`) listing each file's fate — `full`, `truncated`, `diffstat-only`, `withheld` or
`binary` — with reasons and token counts. That is what happened on **your** run, and it is the
authoritative answer.

<!-- /disclosure -->

---

## 10. Configuration

`perf.yml` at the repository root is optional. Without it, driftwatch detects the framework, the
package manager and the routes, and uses defaults for everything else.

```yaml
detect: nextjs              # framework; detected, override only if detection is wrong
app: null                   # which workspace package to measure (monorepos)
package_manager: null       # override when detection has no evidence to go on
measure: []                 # metric ids that count as KEY; empty = build_time + client_bundle_size
serve: true                 # boot the built app and measure route latency
browser: true               # Lighthouse metrics (needs Chrome)
verify: true                # measure the AI's suggested fix before showing it
auto_fix: off               # 'propose' opens a fix PR when a fix measurably restores the metric
threshold: 5%               # the line at which a reported delta becomes a verdict
block_merge: false          # warn only; set true once you trust the numbers
base: main                  # default ref to compare against; --base overrides per run
provider: deepseek          # deepseek | openai
model: deepseek-chat
key_command: null           # a command whose stdout is the key; output is used, never stored
max_cost_per_run: null      # e.g. 0.05 — refuses the analysis rather than exceeding it
```

The noise floor (2%) is deliberately **not** configurable: it is a property of what the instrument
can resolve, not a preference. The threshold is, because where a real delta becomes a verdict is a
team judgement.

---

## 11. CI setup

```bash
driftwatch init --github    # writes .github/workflows/driftwatch.yml
```

The generated workflow runs on pull requests (compare), on pushes to `main` (record a trend
point), and weekly on a schedule (drift alerting, which measures nothing). It needs:

| Permission | Why |
|---|---|
| `pull-requests: write` | the self-updating PR comment, and fix PRs when `auto_fix` is on |
| `contents: write` | pushing trend points to the `perf-data` branch |
| `checks: write` | the non-blocking check run |
| `issues: write` | drift alerts open one issue per condition |

Two things the generated file explains inline, because both cost real debugging time otherwise:
**Chrome is pinned** to a specific build, since a runner's Chrome moving mid-day is a protocol
break that splits your trend; and `auto_fix: propose` additionally needs a repository setting
(*Settings → Actions → General → Workflow permissions → "Allow GitHub Actions to create and
approve pull requests"*) that driftwatch documents and never flips for you.

The check is **neutral, not failing**, when a regression is found, unless you set
`block_merge: true`. A newly installed tool that blocks merges gets uninstalled rather than fixed.

---

## 12. Cost

Measurement is free and has no external dependency. Analysis costs whatever your provider charges,
and driftwatch reports it two ways: a ceiling before you spend anything (`driftwatch doctor`), and
projected-beside-actual on every analysed run, so the estimate is audited by reality rather than
trusted.

Set a hard limit per run if you want one:

```yaml
max_cost_per_run: 0.05
```

Over that projection, the analysis is **refused** — not truncated, not quietly switched to a
cheaper model. The measurement and verdict are unaffected; only the explanation is withheld, and
the comment says so with both numbers.

**Cumulative spend is not tracked.** Driftwatch does not know your provider bill and will not
pretend to; a running total it never measured belongs in the same category as an estimate
presented as a measurement.

---

## 13. How this was built

The design history is in the repository, and it is unusually complete:
[`specs/perf-tool-spec.md`](specs/perf-tool-spec.md) records every decision, the measurement behind
it, and the ones that were reversed when data contradicted them. Eleven milestones, each closed
only on evidence — a live proof on a real pull request, an eval suite against a live provider,
or a measured acceptance run — and this launch is the twelfth.

Two practices from that history are worth borrowing regardless of whether you use this tool:

- **The decision audit.** Every so often, walk the decisions recorded in your spec and check each
  one still exists in the code. Two had quietly stopped being true — one was never implemented,
  and one was implemented correctly and then silently voided by an unrelated rename. Both had been
  "done" for months.
- **Never assert which branch a timed run took.** A test that depends on a timing measurement
  staying under a threshold is flaky by construction: when it fails, the tool was right and the
  test was wrong. Assert the policy as a pure function over known inputs, and the plumbing
  separately.

---

## 14. Requirements and status

Node 20+, git, and a Next.js project. Lighthouse metrics additionally need Chrome; in CI the
generated workflow installs and pins one.

**Status: complete, and running on this repository.** Driftwatch measures its own fixture on every
push; the trend points are on the [`perf-data`](../../tree/perf-data) branch of this repo, which is
where the "39 recorded points" in §4 comes from. Every capability described here has an acceptance
run behind it, and the suite is 465 tests including end-to-end runs against real builds.

What it has not had is many users. If you hit something this README says does not happen, that is
worth an issue — and `--json` plus `driftwatch doctor` will usually contain the answer.

Licensed under [Apache-2.0](LICENSE).
