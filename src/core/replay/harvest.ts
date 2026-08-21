import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { access } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { MetricMovements, Movement } from '../trend/movement.js'
import { PERF_DATA_BRANCH } from '../trend/store-tree.js'

const exec = promisify(execFile)
const GIT_BUFFER = 64 * 1024 * 1024

/**
 * The eval-case factory's raw material (spec §10) — deliberately HALF a case. For each movement:
 * the two measured result JSONs, the real git diff between the commits, and a template whose
 * measured fields are prefilled and whose TRUTH fields (cause, suspects, fix) are empty. A human
 * names the truth; the tool never writes its own answer key — grading the AI against answers the
 * tool invented would be circular.
 *
 * Existing candidate folders are never overwritten: a half-filled template is a human's work.
 *
 * Written under `.perf/` — the ONE directory driftwatch may write in the user's repo (rule 2,
 * re-affirmed by spec §9a). The CLI announces every folder it creates.
 */

export interface HarvestOutcome {
  readonly written: readonly string[]
  readonly skippedExisting: readonly string[]
  /** Movements whose endpoint results could not be read from the perf-data branch. */
  readonly missing: readonly string[]
}

export async function harvestCandidates(
  gitRoot: string,
  reports: readonly MetricMovements[],
): Promise<HarvestOutcome> {
  const ref = await perfDataRef(gitRoot)
  if (!ref) return { written: [], skippedExisting: [], missing: reports.flatMap((r) => r.movements.map((m) => m.toSha)) }

  // One candidate per commit where anything moved; all metrics that moved there ride together.
  const byToSha = new Map<string, { fromSha: string; moved: { id: string; unit: string; movement: Movement }[] }>()
  for (const report of reports) {
    for (const movement of report.movements) {
      if (!byToSha.has(movement.toSha)) byToSha.set(movement.toSha, { fromSha: movement.fromSha, moved: [] })
      byToSha.get(movement.toSha)!.moved.push({ id: report.id, unit: report.unit, movement })
    }
  }

  const written: string[] = []
  const skippedExisting: string[] = []
  const missing: string[] = []

  for (const [toSha, { fromSha, moved }] of byToSha) {
    const dir = path.join(gitRoot, '.perf', 'eval-candidates', toSha.slice(0, 12))
    if (await exists(dir)) {
      skippedExisting.push(dir)
      continue
    }

    const before = await resultFile(gitRoot, ref, fromSha)
    const after = await resultFile(gitRoot, ref, toSha)
    if (before === null || after === null) {
      missing.push(toSha)
      continue
    }
    const { stdout: diff } = await exec('git', ['-C', gitRoot, 'diff', `${fromSha}..${toSha}`], {
      maxBuffer: GIT_BUFFER,
    })

    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'before.json'), before, 'utf8')
    await writeFile(path.join(dir, 'after.json'), after, 'utf8')
    await writeFile(path.join(dir, 'diff.patch'), diff, 'utf8')
    await writeFile(
      path.join(dir, 'expected-template.json'),
      JSON.stringify(template(fromSha, toSha, moved), null, 2) + '\n',
      'utf8',
    )
    written.push(dir)
  }

  return { written, skippedExisting, missing }
}

/** Measured facts prefilled; truth fields empty — the human completes them (never the tool). */
function template(
  fromSha: string,
  toSha: string,
  moved: readonly { id: string; unit: string; movement: Movement }[],
): unknown {
  return {
    _instructions:
      'A replay movement candidate. Fill the empty truth fields by reading diff.patch — the tool never writes its own answer key. Then shape it into an eval case (see eval/cases/README.md).',
    movement: {
      fromSha,
      toSha,
      metrics: moved.map(({ id, unit, movement }) => ({
        id,
        unit,
        before: movement.before,
        after: movement.after,
        deltaPercent: movement.deltaPercent,
        direction: movement.direction,
        ...(movement.gap ? { gap: movement.gap } : {}),
      })),
    },
    outcome: 'analysed',
    suspectsInclude: [],
    causeMustContain: [],
    confidence: { min: 0.5, max: 1.0 },
    fix: { mustMentionAnyOf: [] },
  }
}

async function resultFile(gitRoot: string, ref: string, sha: string): Promise<string | null> {
  try {
    const { stdout } = await exec(
      'git',
      ['-C', gitRoot, 'show', `${ref}:results/${sha.slice(0, 12)}.json`],
      { maxBuffer: GIT_BUFFER },
    )
    return stdout
  } catch {
    return null
  }
}

async function perfDataRef(gitRoot: string): Promise<string | null> {
  for (const ref of [`refs/heads/${PERF_DATA_BRANCH}`, `refs/remotes/origin/${PERF_DATA_BRANCH}`]) {
    const ok = await exec('git', ['-C', gitRoot, 'rev-parse', '--verify', '--quiet', ref]).then(() => true, () => false)
    if (ok) return ref
  }
  return null
}

async function exists(p: string): Promise<boolean> {
  return access(p).then(() => true, () => false)
}
