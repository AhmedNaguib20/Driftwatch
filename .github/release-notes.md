Performance regression testing for pull requests.

**It refuses to report a delta it cannot stand behind.** Both sides of a comparison are measured in the same invocation, under an identical and recorded protocol. Where that is impossible, you get the values and no delta — rather than a number that looks like a finding.

Optionally, on your own API key, it explains what caused a confirmed regression and proposes a fix it has already measured.

**Free and fully local without any API key.** Measurement, comparison, verdicts, trends, the dashboard and drift alerting never need one and never phone anywhere.

## What it does

- Measures build time, client bundle size, build output size, route latency, and Lighthouse LCP/FCP/TBT/transfer size — both sides cold, median of 3 after a discarded warm-up
- Posts one self-updating PR comment with the numbers, the raw samples, and what it could not measure
- Records a trend point per push to a `perf-data` branch in your own repository, with a self-contained dashboard
- Alerts on drift no single pull request could have caught — accumulation where every step stayed under the threshold
- Replays your recent history, so a project has trend data on day one instead of after a month

## What it refuses to do

- **Touch your working directory.** Both sides are measured in temporary copies; a test asserts `git status --porcelain` is byte-identical across a run
- **Report a number it did not measure.** A failed metric is named with its reason, never omitted
- **Compare across mismatched protocols.** Different Node, platform, Chrome build or CI runner class means values without a delta
- **Attribute what it cannot attribute.** Per-commit blame is licensed only for deterministic byte counts. Reproduce that claim in ten seconds — `npm run demo:movement` builds a 10-commit history with three planted regressions among seven innocent commits and scores itself: 3 of 3 found, 0 of 7 falsely accused

## Install

```bash
npx @ahmednaguib/driftwatch run        # try it — no key, no config
npm i -D @ahmednaguib/driftwatch       # then the command is just `driftwatch`
```

The unscoped npm name is blocked by npm's similarity filter against an unrelated package. The scope is this package's address, not a different tool.

- **Package** — https://www.npmjs.com/package/@ahmednaguib/driftwatch
- **Repository** — https://github.com/AhmedNaguib20/Driftwatch
- **Live dashboard** — https://ahmednaguib20.github.io/Driftwatch/

## About v0.6.0

v0.6.0 was published to npm and briefly tagged here. The tagged Action could not execute — the
build output it points at was not committed to the tag — so that tag and release were removed. The
npm 0.6.0 package is unaffected and works; this release fixes the Action path and the workflow that
`driftwatch init --github` generates.

Releases are now cut by [a workflow](../blob/main/.github/workflows/release.yml) that refuses to
publish a tag whose tree does not contain the file `action.yml` points at — the exact check whose
absence caused this.

## Status, honestly

This is the first working release. Every capability above has an acceptance run behind it and the suite is 466 tests, including end-to-end runs against real builds — but the tool has had very few users.

**Next.js is what is proven.** The detection layer is framework-agnostic in shape, but nothing else has acceptance runs behind it. There is no production monitoring, no cross-machine comparison, and timing attribution is deliberately unavailable until instruction counting replaces wall-clock measurement.

The reasoning behind every threshold is in [`specs/perf-tool-spec.md`](https://github.com/AhmedNaguib20/Driftwatch/blob/main/specs/perf-tool-spec.md): the measurements that set each one, the approaches tried and rejected, and the decisions reversed when the data contradicted them.

Apache-2.0.
