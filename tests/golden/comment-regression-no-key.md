<!-- driftwatch:comment -->

### ⚠️ Performance regression detected

**build time (cold)** is up +7.2% against baseline `main@c0ffee0`. Threshold is 5%.

| Metric | Base | This PR | Change |
|---|---|---|---|
| build time (cold) | 8.72 s | 9.35 s | **+7.2%** ⬆️ |
| bundle size | 2.20 MB | 2.20 MB | no change |
| install time | — | — | skipped — dependencies provided by cloning the existing node_modules — install not measured |

_A regression was found but no `DRIFTWATCH_API_KEY` is available (normal for fork PRs), so there is no analysis of the cause. The measurement above stands on its own._

<details>
<summary>All metrics</summary>

**Base**
- install time: skipped — dependencies provided by cloning the existing node_modules — install not measured
- build time (cold): 8.72 s (samples: 11143, 8629, 8724) — median of 3 cold builds, wall clock around `npm run build` in a worktree
- bundle size: 2.20 MB — sum of file sizes in .next (113 files), excluding internal caches and diagnostics

**This PR**
- install time: skipped — dependencies provided by cloning the existing node_modules — install not measured
- build time (cold): 9.35 s (samples: 11810, 9350, 9349) — median of 3 cold builds, wall clock around `npm run build` in a copy
- bundle size: 2.20 MB — sum of file sizes in .next (113 files), excluding internal caches and diagnostics

</details>

<details>
<summary>How this was measured</summary>

Both sides build cold in disposable copies (never your working directory): 3 timed builds after 1 discarded warm-up, median reported. Node v20.20.0 on darwin/arm64.
Deltas under 2% are treated as measurement noise and reported as "no change". Threshold for calling a regression: 5%.
Both sides were measured fresh in this run.

</details>

---
<sub>Baseline `main@c0ffee0` (cached) · driftwatch v0.2.0</sub>
