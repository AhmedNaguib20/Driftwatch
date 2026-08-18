import type { Validator } from '../providers/index.js'

/** Model output shapes, validated strictly — malformed output gets one corrective retry. */

export interface TriageOutput {
  readonly plausible: boolean
  readonly suspects: readonly { readonly path: string; readonly reason: string }[]
  readonly stopReason?: string
}

export interface DeepOutput {
  readonly cause: string
  readonly confidence: number
  readonly evidence: readonly string[]
  readonly fix: { readonly kind: 'diff' | 'prose'; readonly content: string }
}

export const validateTriage: Validator<TriageOutput> = (raw) => {
  const r = raw as Record<string, unknown>
  if (typeof r?.plausible !== 'boolean') {
    return { ok: false, problem: '"plausible" must be a boolean' }
  }
  if (!Array.isArray(r.suspects)) {
    return { ok: false, problem: '"suspects" must be an array (empty is fine)' }
  }
  for (const s of r.suspects) {
    const entry = s as Record<string, unknown>
    if (typeof entry?.path !== 'string' || typeof entry?.reason !== 'string') {
      return { ok: false, problem: 'every suspect needs string "path" and "reason"' }
    }
  }
  if (r.plausible === false && typeof r.stopReason !== 'string') {
    return { ok: false, problem: '"stopReason" is required when plausible is false' }
  }
  if (r.stopReason !== undefined && typeof r.stopReason !== 'string') {
    return { ok: false, problem: '"stopReason" must be a string when present' }
  }
  return { ok: true, value: r as unknown as TriageOutput }
}

export const validateDeep: Validator<DeepOutput> = (raw) => {
  const r = raw as Record<string, unknown>
  if (typeof r?.cause !== 'string' || r.cause.trim() === '') {
    return { ok: false, problem: '"cause" must be a non-empty string' }
  }
  if (typeof r.confidence !== 'number' || r.confidence < 0 || r.confidence > 1) {
    return { ok: false, problem: '"confidence" must be a number between 0 and 1' }
  }
  if (!Array.isArray(r.evidence) || r.evidence.length === 0 || !r.evidence.every((e) => typeof e === 'string')) {
    return { ok: false, problem: '"evidence" must be a non-empty array of strings' }
  }
  const fix = r.fix as Record<string, unknown> | undefined
  if (!fix || (fix.kind !== 'diff' && fix.kind !== 'prose') || typeof fix.content !== 'string') {
    return { ok: false, problem: '"fix" must be { kind: "diff"|"prose", content: string }' }
  }
  return { ok: true, value: r as unknown as DeepOutput }
}
