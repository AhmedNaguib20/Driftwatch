<!-- driftwatch:comment -->

### ❔ Measurement inconclusive

base ref "main" does not resolve to a commit in this repository. Baseline: unavailable.

| Metric | Base | This PR | Change |
|---|---|---|---|
| install time | — | — | skipped — base unavailable: base ref "main" does not resolve to a commit in this repository |
| build time (cold) | — | 9.35 s | skipped — base unavailable: base ref "main" does not resolve to a commit in this repository |
| bundle size | — | 2.20 MB | skipped — base unavailable: base ref "main" does not resolve to a commit in this repository |

_AI analysis skipped: analysis runs only on a regression verdict_

<details>
<summary>All metrics</summary>

**This PR**
- install time: skipped — dependencies unchanged between sides — provided by clone, install not measured
- build time (cold): 9.35 s (samples: 11810, 9350, 9349) — median of 3 cold builds, wall clock around `npm run build` in a copy
- bundle size: 2.20 MB — sum of file sizes in .next (113 files), excluding internal caches and diagnostics

</details>

<details>
<summary>How this was measured</summary>

Both sides build cold in disposable copies (never your working directory): 3 timed builds after 1 discarded warm-up, median reported. Node v20.20.0 on darwin/arm64.
Deltas under 2% are treated as measurement noise and reported as "no change". Threshold for calling a regression: 5%.
Both sides were measured fresh in this run.

**Protocols differed between the sides — deltas were refused, not computed:**

</details>

---
<sub>driftwatch v0.2.0</sub>
