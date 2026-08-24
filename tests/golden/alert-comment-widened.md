### Drift widened

**client bundle size drift widened to +23.5% over 26 commits (2.10 MB → 2.59 MB) — last alerted at +10.91%, and still no single commit crossed the 5% threshold (largest +0.9%).**

It has moved another 12.6 points since this issue was raised —
one full alert step, which is the only thing that makes driftwatch speak twice about the same condition.

| | |
| --- | --- |
| Cumulative | +23.5% (+505.0 kB) |
| Window | `0010010010` → `0410410410`, 26 measured points |
| Largest single step | +0.9% — the PR threshold is 5% |
| Movement kept | 100% of all movement went one way |
| Protocol | node v24.18.0 · linux/x64 · os:Linux · driftwatch 0.6.0 |

<sub>driftwatch v0.0.0-test (dist built 2026-08-24 00:00Z) · alert line 10% cumulative within one protocol segment</sub>
