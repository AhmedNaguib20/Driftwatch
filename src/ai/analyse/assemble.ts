import type { ResultJson } from '../../core/index.js'
import {
  DEEP_BUDGET_TOKENS,
  MAX_PATCH_TOKENS_PER_FILE,
  MIN_PATCH_TOKENS,
  TRIAGE_BUDGET_TOKENS,
  estimateTokens,
} from './budget.js'
import { isLockfilePath } from './lockfile-summary.js'
import { renderDiffstat, renderLockfileSummaries, renderMeasurement } from './render.js'
import { isSecretPath } from './secrets.js'
import type {
  AssembledContext,
  ContextManifest,
  DiffFile,
  FileDisposition,
  LockfileSummary,
  ManifestEntry,
} from './types.js'

/**
 * The two context assemblers — pure functions of collected inputs, byte-identical for identical
 * inputs. Allocation order (fixed): measurement + evidence + diffstat + lockfile summaries always
 * fit first; remaining budget buys full patches, most-changed first (deep: triage suspects
 * first). Every file's fate is recorded in the manifest — the manifest IS the per-run statement
 * of exactly what was sent (spec §7.1).
 */

export interface ContextInput {
  readonly result: ResultJson
  readonly diff: readonly DiffFile[]
  readonly lockfileSummaries: readonly LockfileSummary[]
}

/** Triage sees numbers and shape, not content: diffstat only, no patches. */
export function assembleTriageContext(input: ContextInput): AssembledContext {
  const sections = [
    renderMeasurement(input.result),
    renderLockfileSummaries(input.lockfileSummaries),
    renderDiffstat(input.diff),
  ].filter((s) => s.length > 0)

  // Triage sends no patch content for anyone — the manifest says what was SENT, so every file
  // is diffstat-only here; withheld/binary annotations still apply for the reader.
  const files: ManifestEntry[] = input.diff.map((f) => {
    const fixed = baselineDisposition(f)
    return {
      path: f.path,
      disposition: fixed === 'full' ? 'diffstat-only' : fixed,
      insertions: f.insertions,
      deletions: f.deletions,
      reason: fixed === 'full' ? 'triage sends the diffstat only' : baselineReason(f),
    }
  })

  return finalize(sections, files, input, TRIAGE_BUDGET_TOKENS)
}

/** Deep analysis: same fixed sections, plus full patches — suspects get the budget first. */
export function assembleDeepContext(
  input: ContextInput,
  suspects: readonly string[],
): AssembledContext {
  const fixedSections = [
    renderMeasurement(input.result),
    renderLockfileSummaries(input.lockfileSummaries),
    renderDiffstat(input.diff),
  ].filter((s) => s.length > 0)

  const suspectSet = new Set(suspects)
  const candidates = [...input.diff].sort((a, b) => {
    const aSuspect = suspectSet.has(a.path) ? 0 : 1
    const bSuspect = suspectSet.has(b.path) ? 0 : 1
    if (aSuspect !== bSuspect) return aSuspect - bSuspect
    return b.insertions + b.deletions - (a.insertions + a.deletions) || (a.path < b.path ? -1 : 1)
  })

  let spent = fixedSections.reduce((sum, s) => sum + estimateTokens(s), 0)
  const patchSections: string[] = []
  const files: ManifestEntry[] = []

  for (const f of candidates) {
    const fixed = baselineDisposition(f)
    if (fixed !== 'full') {
      files.push({
        path: f.path,
        disposition: fixed,
        insertions: f.insertions,
        deletions: f.deletions,
        reason: baselineReason(f),
      })
      continue
    }

    const patchTokens = Math.min(estimateTokens(f.patch), MAX_PATCH_TOKENS_PER_FILE)
    const remaining = DEEP_BUDGET_TOKENS - spent

    let disposition: FileDisposition
    let reason: string | null = null
    if (patchTokens <= remaining) {
      const capped = f.patch.slice(0, MAX_PATCH_TOKENS_PER_FILE * 4)
      const wasCapped = capped.length < f.patch.length
      patchSections.push(patchSection(f, capped, wasCapped))
      spent += estimateTokens(capped)
      disposition = wasCapped ? 'truncated' : 'full'
      if (wasCapped) reason = `patch capped at ~${MAX_PATCH_TOKENS_PER_FILE} tokens`
    } else if (remaining >= MIN_PATCH_TOKENS) {
      const slice = f.patch.slice(0, remaining * 4)
      patchSections.push(patchSection(f, slice, true))
      spent += estimateTokens(slice)
      disposition = 'truncated'
      reason = 'budget exhausted mid-file'
    } else {
      disposition = 'diffstat-only'
      reason = 'budget exhausted'
    }

    files.push({
      path: f.path,
      disposition,
      insertions: f.insertions,
      deletions: f.deletions,
      reason,
    })
  }

  // Manifest order mirrors the diffstat, not allocation order — stable for the reader.
  const byPath = new Map(files.map((f) => [f.path, f]))
  const ordered = input.diff.map((f) => byPath.get(f.path)!).filter(Boolean)

  const sections =
    patchSections.length > 0
      ? [...fixedSections, '## Patches (unified diff, base → working tree)', ...patchSections]
      : fixedSections

  return finalize(sections, ordered, input, DEEP_BUDGET_TOKENS)
}

function baselineDisposition(f: DiffFile): FileDisposition {
  if (isSecretPath(f.path)) return 'withheld'
  if (f.binary) return 'binary'
  if (isLockfilePath(f.path)) return 'diffstat-only'
  return 'full'
}

function baselineReason(f: DiffFile): string | null {
  if (isSecretPath(f.path)) return 'content withheld — matches secret file patterns'
  if (f.binary) return 'binary content is never sent'
  if (isLockfilePath(f.path)) return 'lockfiles travel as package summaries, never raw patches'
  return null
}

function patchSection(f: DiffFile, patch: string, truncated: boolean): string {
  const header = `### ${f.path} (+${f.insertions}/-${f.deletions}${f.untracked ? ', new file' : ''})`
  return `${header}\n\`\`\`diff\n${patch}${truncated ? '\n… (truncated)' : ''}\n\`\`\``
}

function finalize(
  sections: string[],
  files: ManifestEntry[],
  input: ContextInput,
  budget: number,
): AssembledContext {
  const text = sections.join('\n\n')
  const manifest: ContextManifest = {
    files,
    lockfiles: input.lockfileSummaries.map((s) => s.lockfile),
    estimatedTokens: estimateTokens(text),
    budgetTokens: budget,
    truncated: files.some((f) => f.disposition === 'truncated'),
  }
  return { text, manifest }
}
