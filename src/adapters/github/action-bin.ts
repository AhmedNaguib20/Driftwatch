#!/usr/bin/env node
import { main } from './action-entry.js'

/**
 * The executable the composite action runs: `npx -p @ahmednaguib/driftwatch@X driftwatch-action`.
 *
 * It exists so nothing has to GUESS whether it was invoked directly. The previous entry compared
 * `process.argv[1]` against its own module URL and ran `main()` only if they matched — a check
 * that, through an npm bin symlink, can silently decide the answer is no. The failure mode of a
 * wrong guess there is an action that exits 0 having done nothing, which is the worst outcome
 * this project has: a green tick over an unmeasured pull request. A dedicated bin cannot be wrong.
 */

main().catch((error) => {
  console.error(`driftwatch: unexpected failure: ${(error as Error).stack}`)
  process.exitCode = 1
})
