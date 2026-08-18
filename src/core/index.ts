/**
 * Public surface of the platform-agnostic core.
 *
 * Core takes input and returns JSON. It knows nothing about GitHub, CI, or any other platform —
 * see CLAUDE.md hard rule 1 and spec §3.1. Adapters and the CLI consume what is exported here.
 *
 * Populated as M1 lands: detect → measure → baseline → report.
 */

export * from './detect/index.js'
