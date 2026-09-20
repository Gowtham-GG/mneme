import type { TagCount } from '@/types/db'

export interface TagNode { seg: string; path: string; count: number; direct: number; children: TagNode[] }

/** "jvm", "jvm/memory", "jvm/memory/heap" → a tree. Counts are rolled up by the database (distinct notes). */
export function buildTagTree(tags: TagCount[]): TagNode[] {
  const byPath = new Map<string, TagNode>()
  const roots: TagNode[] = []
  for (const t of [...tags].sort((a, b) => a.name.localeCompare(b.name))) {
    const segs = t.name.split('/')
    const node: TagNode = { seg: segs[segs.length - 1], path: t.name, count: t.note_count, direct: t.direct_count, children: [] }
    byPath.set(t.name, node)
    const parent = byPath.get(segs.slice(0, -1).join('/'))
    if (parent) parent.children.push(node); else roots.push(node)
  }
  return roots
}
