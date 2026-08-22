# Driftwatch — build time (cold) +7.2% (threshold 5%)
[PR comment](https://github.com/ahmed/driftwatch/pull/7#issuecomment-1) · [check](https://github.com/ahmed/driftwatch/runs/2)

| Metric | Base | This PR | Change |
|---|---|---|---|
| build time (cold) | 8.72 s | 9.35 s | **+7.2%** ⬆️ |
| client bundle size | 921.0 kB | 921.0 kB | no change |
| build output size | 2.20 MB | 2.20 MB | no change |
| install time | — | — | skipped — dependencies provided by cloning the existing node_modules — install not measured |
| 4 rows excluded by policy | — | — | prerendered (SSG) |
| route /blog/[slug] | — | — | skipped — dynamic segment — no concrete URL to measure |

<details>
<summary>Excluded rows</summary>

- route /, route /about, route /blog, route /dashboard — prerendered (SSG) — served as static files; excluded from route_latency (regressions surface in bundle_size / Lighthouse)

</details>

## All metrics

**install time**
- Base: skipped — dependencies provided by cloning the existing node_modules — install not measured
- This PR: skipped — dependencies provided by cloning the existing node_modules — install not measured

**build time (cold)** — median of 3 cold builds, wall clock around `npm run build`
- Base: 8.72 s (samples: 11143, 8629, 8724)
- This PR: 9.35 s (samples: 11810, 9350, 9349)

**client bundle size** — sum of file sizes in .next/static (41 files, shipped to browsers), excluding internal caches and diagnostics
- Base: 921.0 kB
- This PR: 921.0 kB

**build output size** — sum of file sizes in .next (113 files, all build output, server code included), excluding internal caches and diagnostics
- Base: 2.20 MB
- This PR: 2.20 MB

## How this was measured

Both sides build cold in disposable copies (never your working directory): 3 timed builds after 1 discarded warm-up, median reported. Node v20.20.0 on darwin/arm64.
Deltas under 2% are treated as measurement noise and reported as "no change". Threshold for calling a regression: 5%.
Both sides were measured fresh in this run.
