import type { IndexEntry, IndexFile } from './index-file.js'

/**
 * Timeline ordering (M7): commit topology first, commit date as fallback — never append order.
 *
 * Append order was chronological only as long as every point was recorded at push time; replay
 * appends OLDER commits after newer entries, so the index's array order stopped meaning "history
 * order" the day replay landed. Ordering rules:
 *
 *  - Topology: an entry whose `parentSha` is also in the index always comes after that parent
 *    (first-parent linkage — the mainline is the project's real history).
 *  - Date: among entries with no topology constraint between them, order by `committedAt`,
 *    falling back to `timestamp` (measurement time) for pre-M7 entries — live-recorded points
 *    are measured moments after they land, so the approximation holds.
 *  - Stability: ties keep append order, so a pre-M7 index (no committedAt, no parentSha, and
 *    measurement timestamps already monotonic by construction) renders EXACTLY as before —
 *    proven by the unchanged timeline/dashboard goldens.
 */
export function orderEntries(entries: readonly IndexEntry[]): IndexEntry[] {
  const position = new Map<string, number>()
  entries.forEach((entry, i) => position.set(entry.sha, i))

  interface Node {
    readonly entry: IndexEntry
    readonly appendIdx: number
    readonly key: string
    pendingParents: number
  }
  const nodes: Node[] = entries.map((entry, i) => ({
    entry,
    appendIdx: i,
    key: entry.committedAt ?? entry.timestamp,
    pendingParents: entry.parentSha && position.has(entry.parentSha) ? 1 : 0,
  }))
  const childrenOf = new Map<string, Node[]>()
  for (const node of nodes) {
    const parent = node.entry.parentSha
    if (parent && position.has(parent)) {
      if (!childrenOf.has(parent)) childrenOf.set(parent, [])
      childrenOf.get(parent)!.push(node)
    }
  }

  // Kahn's algorithm with a (date, append-index) priority: emit the oldest ready entry first.
  const ready = nodes.filter((n) => n.pendingParents === 0)
  const before = (a: Node, b: Node) =>
    a.key < b.key || (a.key === b.key && a.appendIdx < b.appendIdx)
  const ordered: IndexEntry[] = []
  while (ready.length > 0) {
    let pick = 0
    for (let i = 1; i < ready.length; i += 1) {
      if (before(ready[i]!, ready[pick]!)) pick = i
    }
    const next = ready.splice(pick, 1)[0]!
    ordered.push(next.entry)
    for (const child of childrenOf.get(next.entry.sha) ?? []) {
      child.pendingParents -= 1
      if (child.pendingParents === 0) ready.push(child)
    }
  }

  // A parent cycle cannot occur in real git data; if the index is corrupted into one, emit the
  // stragglers in append order rather than losing points silently.
  if (ordered.length < entries.length) {
    const emitted = new Set(ordered.map((e) => e.sha))
    for (const entry of entries) if (!emitted.has(entry.sha)) ordered.push(entry)
  }
  return ordered
}

export function orderedIndex(index: IndexFile): IndexFile {
  return { ...index, entries: orderEntries(index.entries) }
}
