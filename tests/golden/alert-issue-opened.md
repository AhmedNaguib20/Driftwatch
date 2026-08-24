<!-- driftwatch:alert:client_bundle_size -->

**client bundle size drifted +10.91% over 14 commits (2.10 MB → 2.33 MB) — no single commit crossed the 5% threshold (largest +0.8%).**

That last clause is why this issue exists: every step was small enough that no pull request
reported it, so nothing in the PR flow could have caught this.

| | |
| --- | --- |
| Cumulative | +10.91% (+234.5 kB) |
| Window | `0010010010` → `0140140140`, 14 measured points |
| Largest single step | +0.8% — the PR threshold is 5% |
| Movement kept | 100% of all movement went one way |
| Protocol | node v24.18.0 · linux/x64 · os:Linux · driftwatch 0.6.0 |

**What this is.** Drift is a *tendency* over landed history — it names no commit. Driftwatch
attributes a change to a commit only where the measurement licenses it; a drift spread across
many small steps has no single author, and this issue does not invent one.

**How this issue maintains itself.**
- widens by another 10 points → a comment here, and the title updates
- retreats to 5% or less → closed, with the measured retreat
- the protocol segment breaks → closed as **superseded**, which is not the same as resolved

<sub>driftwatch v0.0.0-test (dist built 2026-08-24 00:00Z) · alert line 10% cumulative within one protocol segment</sub>
