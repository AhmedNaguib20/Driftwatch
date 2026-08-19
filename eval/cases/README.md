# Eval cases (spec §7.2)

Captured real regressions with known causes. `npx driftwatch eval` (dev command) replays each
against the live provider and judges the analysis against `expected.json`. Every prompt change is
judged here before it ships; results are only comparable across identical PROMPT_VERSIONs.

| case  | scenario | known cause |
|-------|----------|-------------|
| run-a | 300 generated SSG posts + 30 new route components | prerender count + route compilation |
| run-b | one `import _ from 'lodash'` + `_.debounce` on one page (4 lines, deps unchanged) | full lodash in the page bundle |
| run-c | same import, but lodash also newly added to package.json/lockfile vs an older base | same, with dependenciesChanged signal |

run-b exists because prompt v1 failed it (false negative: diffstat-only triage). run-c is the
"richer variant" — it hands the model the dependency signal, so it should be the easiest.

Each case: `result.json` (captured schema result), `diff.json` (collected DiffFile[]),
`lockfiles.json`, `expected.json`.

## Baseline notes

- **prompts v2** is the current baseline (all 4 cases pass; adopted after v1's run-b false
  negative). Results are only comparable across identical PROMPT_VERSIONs.
- **Confidence varies between eval runs even at temperature 0** (observed: run-c 0.9 → 0.7 across
  runs, same correct cause). Read eval history as pass/fail against the expectation bands, not as
  a confidence time-series; a band change in expected.json is the reviewable event.
- M5-close snapshot (2026-08-19): 4/4 PASS on prompts v2, deepseek-v4-flash.
