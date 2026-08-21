import path from 'node:path'
import type { ProjectProfile } from '../detect/types.js'
import { exists, readText } from '../detect/fs-probe.js'

/**
 * Measurement copies have no `.git` (deliberately, on both sides — protocol field
 * `gitMetadata`). Tooling that stamps versions from git will behave differently there, and per
 * spec §5.1 that must be surfaced, not silently swallowed. Detection is heuristic: we warn on the
 * obvious signals. Used by both the working-tree copy and the baseline worktree.
 */
export async function gitReadingWarnings(profile: ProjectProfile): Promise<string[]> {
  const suspects: string[] = []

  const pkgRaw = await readText(path.join(profile.projectRoot, 'package.json'))
  if (pkgRaw) {
    try {
      const scripts = (JSON.parse(pkgRaw) as { scripts?: Record<string, string> }).scripts ?? {}
      const build = scripts['build'] ?? ''
      if (/\bgit\b/.test(build)) suspects.push(`scripts.build runs git ("${build}")`)
    } catch {
      /* unreadable package.json was already warned about in detection */
    }
  }

  for (const config of ['next.config.js', 'next.config.mjs', 'next.config.cjs', 'next.config.ts']) {
    const file = path.join(profile.projectRoot, config)
    if (!(await exists(file))) continue
    const source = (await readText(file)) ?? ''
    if (/\bgit\b|\.git\b|GITHUB_SHA|GIT_COMMIT/.test(source)) {
      suspects.push(`${config} references git`)
    }
  }

  if (suspects.length === 0) return []
  return [
    `The build may read git metadata (${suspects.join('; ')}), but measurement copies have no .git — ` +
      'version stamping and release detection will see a non-repository. Both sides are measured the same way, ' +
      'so the comparison holds, but the built output may differ from a real build.',
  ]
}
