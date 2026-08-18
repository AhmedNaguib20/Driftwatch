## Measured verdict
verdict: regression
noise floor: 2% | threshold: 5%
dependencies changed: false

## Metrics
- install time: skipped | base — → current — | base: dependencies unchanged between sides — provided by clone, install not measured | current: dependencies unchanged between sides — provided by clone, install not measured
- build time (cold): regressed | base 8724 ms → current 9350 ms | delta +626 (+7.18%)
- bundle size: no_change | base 2305491 bytes → current 2305487 bytes | delta is under the 2% noise floor

## Raw samples (medians are reported; judge the spread yourself)
base build_time: [11143, 8629, 8724] ms
current build_time: [11810, 9350, 9349] ms

## Measurement protocols
base: worktree, cache cold, deps cloned, node v20.20.0 darwin/arm64, build "npm run build", 3 samples after 1 warm-up
current: copy, cache cold, deps cloned, node v20.20.0 darwin/arm64, build "npm run build", 3 samples after 1 warm-up

## Detection evidence (how the tool knows what it knows)
- framework: nextjs [package.json] — depends on next@15.1.3
- base: main @ c0ffee000000 [git]

## Dependency changes (lockfile summary — raw lockfile patches are never sent)
- package-lock.json:
  added lodash @ 4.17.21
  bumped next 15.1.2 → 15.1.3

## Diffstat (every changed file, base → working tree)
- lib/posts.ts: +25/-1
- app/blog/page.tsx: +12/-2 (new)
- .env: +1/-0
- package-lock.json: +40/-3

<!-- manifest: {"files":[{"path":"lib/posts.ts","disposition":"diffstat-only","insertions":25,"deletions":1,"reason":"triage sends the diffstat only"},{"path":"app/blog/page.tsx","disposition":"diffstat-only","insertions":12,"deletions":2,"reason":"triage sends the diffstat only"},{"path":".env","disposition":"withheld","insertions":1,"deletions":0,"reason":"content withheld — matches secret file patterns"},{"path":"package-lock.json","disposition":"diffstat-only","insertions":40,"deletions":3,"reason":"lockfiles travel as package summaries, never raw patches"}],"lockfiles":["package-lock.json"],"estimatedTokens":350,"budgetTokens":4000,"truncated":false} -->
