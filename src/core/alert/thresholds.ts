/**
 * The alerting lines — and why each one sits where it does (spec §10, M10 step 1).
 *
 * The governing asymmetry: **an alert costs someone's attention; a dashboard row costs nothing.**
 * So the alerting line is deliberately above the reporting line, and every constant here has a
 * basis in what the real perf-data branch holds (39 entries, 6 protocol segments) rather than a
 * round number chosen for looking sensible.
 *
 * MEASURED BASELINE (the whole branch, every byte-class segment, M10 step 1):
 *
 *     metric                 pts   cumulative%   largest step%   same-direction steps
 *     bundle_size             14         0.00           -0.00              6/13
 *     bundle_size              7         0.00           -0.00               4/6
 *     transfer_size:/         14        -0.00            0.01              7/13
 *     transfer_size:/blog     12         0.00            0.01              5/11
 *     client_bundle_size       5        -0.00            0.00               2/4
 *
 * Byte classes carry no noise: the largest drift anywhere in the history is 0.01%, and step
 * directions land near a coin flip (5/11, 6/13, 7/13). Nothing here is threshold-constrained by
 * noise — which means these numbers are free to be chosen for MEANING, and must be, because
 * anything above ~0.1% would already be "safe".
 */

/**
 * Cumulative drift that earns an interruption: 2x the default PR threshold (5%), 5x the reporting
 * floor (2%).
 *
 * The reasoning is doctrinal, not statistical. An alert must describe something a PR could not
 * have blocked, so it has to clear the PR threshold — and clearing it by exactly one PR's worth
 * would describe a situation a single review might have caught. At 2x, combined with the rule
 * that no single step may cross the PR threshold, an alert always represents accumulation that
 * NO single PR review could have stopped. That is the feature.
 */
export const ALERT_CUMULATIVE_PERCENT = 10

/**
 * Minimum measured points in the window.
 *
 * Derived, not picked: with every step held under the 5% PR threshold, reaching 10% takes at
 * least three contributing steps — four points. Five is that plus one, the smallest run where the
 * pattern survives a single wobble. Evidence that it is reachable: of the six real segments
 * (1, 1, 3, 7, 14, 12 points), three clear it — including the two longest. Requiring 8 would have
 * left only two segments alertable in a year of history; requiring 3 would alert on steps of
 * ~3.3%, which PR comments already show as regressed rows.
 */
export const ALERT_MIN_POINTS = 5

/**
 * Re-alert only after another full step beyond the level last alerted. Same size as the alert
 * line: the second alert on a condition must be as big a claim as the first, or it is nagging.
 */
export const ALERT_WORSEN_STEP_PERCENT = 10

/**
 * Resolution hysteresis: half the alert line. Resolution must be a retreat, not a wobble at the
 * boundary — an alert that clears at 9.9% and re-fires at 10.1% has taught the reader to mute it.
 */
export const ALERT_RESOLVE_PERCENT = 5

/**
 * Monotone-ish: how much of the total movement the drift actually kept.
 *
 *     net share = |cumulative| / sum(|each step|)
 *
 * 1.0 is a perfect staircase; a sawtooth that ends up where it started is 0. This replaced a
 * count of same-direction steps, which the real data showed to be weak — byte noise reached 8/13
 * (62%) same-direction, and a metric that ratchets up in four jumps and dribbles down in five
 * small ones is real drift that a count would reject.
 *
 * MEASURED (every real byte segment of >=5 points, and the shapes we want judged):
 *
 *     real noise, 14 pts                        0.037   0.048   0.075   0.090
 *     real noise, 12 pts                        0.000   0.041   0.059
 *     real noise, 7 pts                         0.138   0.241
 *     real noise, 5 pts                         0.333   0.429      <- the worst noise gets
 *     ---------------------------------------------------------
 *     sawtooth ending +12.9%                    0.301   <- rejected: movement, not direction
 *     ratchet +2/-1 ending +9.3%                0.600
 *     four jumps with small retreats, +17.6%    0.757
 *     14 x +0.8% (the founding case)            1.000
 *
 * 0.5 sits above every real-noise run and below every shape that is genuinely going somewhere.
 * (Short 3-point segments score 1.000 on two-byte wobbles — ALERT_MIN_POINTS, not this rule, is
 * what excludes them.)
 */
export const ALERT_MIN_NET_SHARE = 0.5

/**
 * No single step may account for this much of the cumulative. A step change with flat noise
 * around it is a regression, and the PR flow already owns regressions.
 *
 * At default settings this is implied rather than load-bearing: the window already excludes any
 * step that crossed the PR threshold (5%), and 5% cannot be half of a cumulative that had to
 * reach 10%. It becomes real when a team raises `threshold` in perf.yml — at threshold 10%, a
 * single 9% step could otherwise carry an alert on its own. Kept because the guarantee should
 * hold under configuration, not only under defaults.
 */
export const ALERT_MAX_STEP_SHARE = 0.5

/** Default PR threshold (perf.yml `threshold`), used when the caller has no config to hand. */
export const DEFAULT_PR_THRESHOLD_PERCENT = 5
