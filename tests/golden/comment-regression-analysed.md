<!-- driftwatch:comment -->

### ⚠️ Performance regression detected

**build time (cold)** is up +7.2% against baseline `main@c0ffee0`. Threshold is 5%.

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

### Likely cause  `confidence 90% (high)`

lib/posts.ts adds a 300-entry archive consumed by generateStaticParams, adding ~300 statically generated pages to the build.

**Evidence**
- build time (cold) regressed 8724ms → 9350ms (+626ms, +7.18%); samples [11143, 8629, 8724] vs [11810, 9350, 9349]
- lib/posts.ts (+25/-1) introduces the archive array that /blog/[slug] statically generates

**Suggested fix** (ready diff)

```diff
--- a/lib/posts.ts
+++ b/lib/posts.ts
@@ -1 +1 @@
-const ARCHIVE_SIZE = 300
+const ARCHIVE_SIZE = 30
```

<sub>Analysis sends the diff and measurements to DeepSeek (Hangzhou DeepSeek Artificial Intelligence Co., a Chinese company); nothing else leaves the machine, and the per-run `contextManifest` in the result JSON lists exactly what was included.</sub>

<details>
<summary>How this was measured</summary>

Both sides build cold in disposable copies, 3 timed builds after 1 discarded warm-up, medians reported; deltas under 2% (or each class's quantum) are noise.

Full per-metric accounting (methodology, raw samples per side): [run summary](https://github.com/ahmed/driftwatch/actions/runs/123456).

</details>

<details>
<summary>What was sent to the AI provider</summary>

Measurement numbers, raw samples, protocols, the evidence trail, a diffstat, and:

- `lib/posts.ts` — full patch

~900 tokens (estimate) of a 24000-token budget.

</details>

---
<sub>Baseline `main@c0ffee0` (cached) · driftwatch v0.0.0-test (dist built 2026-08-24 00:00Z) · analysed by deepseek (deepseek-chat) · prompts v1 · 6.6k→510 tokens</sub>
