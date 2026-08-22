<!-- driftwatch:comment -->

### ❔ Measurement inconclusive

base ref "main" does not resolve to a commit in this repository. Baseline: unavailable.

| Metric | Base | This PR | Change |
|---|---|---|---|
| install time | — | — | skipped — base unavailable: base ref "main" does not resolve to a commit in this repository |
| build time (cold) | — | 9.35 s | skipped — base unavailable: base ref "main" does not resolve to a commit in this repository |
| client bundle size | — | 921.0 kB | skipped — base unavailable: base ref "main" does not resolve to a commit in this repository |
| build output size | — | 2.20 MB | skipped — base unavailable: base ref "main" does not resolve to a commit in this repository |
| 5 rows excluded by policy | — | — | base unavailable: base ref "main" does not resolve to a commit in this repository |

<details>
<summary>Excluded rows</summary>

- route /, route /about, route /blog, route /dashboard, route /blog/[slug] — base unavailable: base ref "main" does not resolve to a commit in this repository

</details>

_AI analysis skipped: analysis runs only on a regression verdict_

<details>
<summary>How this was measured</summary>

Both sides build cold in disposable copies, 3 timed builds after 1 discarded warm-up, medians reported; deltas under 2% (or each class's quantum) are noise.

**Protocols differed between the sides — deltas were refused, not computed:**

Full per-metric accounting (methodology, raw samples per side): [run summary](https://github.com/ahmed/driftwatch/actions/runs/123456).

</details>

---
<sub>driftwatch v0.2.0</sub>
