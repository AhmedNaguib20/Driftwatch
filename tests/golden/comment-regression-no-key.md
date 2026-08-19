<!-- driftwatch:comment -->

### ⚠️ Performance regression detected

**build time (cold)** is up +7.2% against baseline `main@c0ffee0`. Threshold is 5%.

| Metric | Base | This PR | Change |
|---|---|---|---|
| build time (cold) | 8.72 s | 9.35 s | **+7.2%** ⬆️ |
| bundle size | 2.20 MB | 2.20 MB | no change |
| install time | — | — | skipped — dependencies provided by cloning the existing node_modules — install not measured |
| 4 rows excluded by policy | — | — | prerendered (SSG) |
| route /blog/[slug] | — | — | skipped — dynamic segment — no concrete URL to measure |

<details>
<summary>Excluded rows</summary>

- route /, route /about, route /blog, route /dashboard — prerendered (SSG) — served as static files; excluded from route_latency (regressions surface in bundle_size / Lighthouse)

</details>

_A regression was found but no `DRIFTWATCH_API_KEY` is available (normal for fork PRs), so there is no analysis of the cause. The measurement above stands on its own._

<details>
<summary>How this was measured</summary>

Both sides build cold in disposable copies, 3 timed builds after 1 discarded warm-up, medians reported; deltas under 2% (or each class's quantum) are noise.

Full per-metric accounting (methodology, raw samples per side): [run summary](https://github.com/ahmed/driftwatch/actions/runs/123456).

</details>

---
<sub>Baseline `main@c0ffee0` (cached) · driftwatch v0.2.0</sub>
