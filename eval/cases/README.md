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

Each case: `result.json` (captured schema-1.1 result), `diff.json` (collected DiffFile[]),
`lockfiles.json`, `expected.json`.
