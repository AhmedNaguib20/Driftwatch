# perf: restores bundle size 2.34 MB → 2.20 MB (measured)

<!-- driftwatch:fix-pr -->

**Proposed by AI analysis, verified by measurement in the same run.** This diff was applied to a fresh copy of the PR tree and measured through the identical pipeline before this PR was opened.

✅ **restored** — every regressed metric back within noise of the baseline

| Metric | Base | This PR (regressed) | With this fix | Verdict |
|---|---|---|---|---|
| bundle size | 2.20 MB | 2.34 MB | 2.20 MB | restored |

**Cause** (`confidence 90% (high)`): lib/posts.ts adds a 300-entry archive consumed by generateStaticParams, adding ~300 statically generated pages to the build.

<sub>Verification cost 41.2s of measurement. Merging this PR updates the original PR's branch; the regression comment will flip on the next run. The diff is exactly the bytes that were measured — see Files Changed.</sub>
