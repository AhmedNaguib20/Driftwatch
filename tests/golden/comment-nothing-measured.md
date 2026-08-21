<!-- driftwatch:comment -->

### ❔ Measurement inconclusive

a key metric could not be measured. Baseline: `main@c0ffee0`.

| Metric | Base | This PR | Change |
|---|---|---|---|
| install time | _not measured_ | _not measured_ | skipped — npm error Unsupported URL Type "workspace:": workspace:* (full error in the run summary) |
| build time (cold) | _not measured_ | _not measured_ | skipped — no build output to weigh (build did not succeed) |
| bundle size | _not measured_ | _not measured_ | skipped — no build output to weigh (build did not succeed) |
| 4 rows excluded by policy | — | — | prerendered (SSG) |
| route /blog/[slug] | — | — | skipped — dynamic segment — no concrete URL to measure |

> Nothing was measured this run — every row above is **unavailable**, not unchanged.

<details>
<summary>Excluded rows</summary>

- route /, route /about, route /blog, route /dashboard — prerendered (SSG) — served as static files; excluded from route_latency (regressions surface in bundle_size / Lighthouse)

</details>

<details>
<summary>How to get these numbers</summary>

**install time**

```
`npm install` cannot resolve `workspace:*` dependencies — those exist only inside a
pnpm/yarn workspace, and driftwatch measured this app on its own.
This project looks like a monorepo package. Point driftwatch at the workspace root, or
set the package manager explicitly in perf.yml:

    package_manager: pnpm
```

</details>

_AI analysis skipped: analysis runs only on a regression verdict_

<details>
<summary>How this was measured</summary>

Both sides build cold in disposable copies, 3 timed builds after 1 discarded warm-up, medians reported; deltas under 2% (or each class's quantum) are noise.

Full per-metric accounting (methodology, raw samples per side): [run summary](https://github.com/ahmed/driftwatch/actions/runs/123456).

</details>

---
<sub>Baseline `main@c0ffee0` (cached) · driftwatch v0.2.0</sub>
