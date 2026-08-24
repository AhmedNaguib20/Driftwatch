### Closed as superseded — not resolved

This issue reported drift measured from `0010010010`. That starting point is no
longer inside a comparable protocol segment, so the run it belonged to cannot be extended and
cannot be compared against.

| | |
| --- | --- |
| Measured under | node v24.18.0 · linux/x64 · os:Linux · driftwatch 0.6.0 |
| Now measured under | node v26.0.0 · linux/x64 · os:Linux · driftwatch 0.6.0 |

There is therefore **no measurement showing the drift came back down, and none showing it persists**.
Driftwatch does not report a recovery it did not measure, so this claim is retired on provenance
rather than on evidence — which is a weaker thing than resolution, and is being called by its own
name for that reason.

If the drift is still there, it will be reported again as a new alert once 5 points have
accumulated under the current protocol.

<sub>driftwatch v0.0.0-test (dist built 2026-08-24 00:00Z) · alert line 10% cumulative within one protocol segment</sub>
