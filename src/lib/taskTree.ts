// Pure helpers for the task tree UI (the rules themselves live in the database).
import type { TaskItem, TaskLink, TaskSequence, TaskState, TaskTree } from '@/types/db'

export const STATES: { id: TaskState; label: string }[] = [
  { id: 'open', label: 'Open' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'on_hold', label: 'On hold' },
  { id: 'done', label: 'Done' },
  { id: 'cancelled', label: 'Cancelled' },
]

export const isResolved = (s: TaskState) => s === 'done' || s === 'cancelled'

const byOrder = (a: { sort_order: number; created_at?: string; id: string }, b: { sort_order: number; created_at?: string; id: string }) =>
  a.sort_order - b.sort_order || (a.created_at ?? '').localeCompare(b.created_at ?? '') || a.id.localeCompare(b.id)

export interface Children {
  sequences: { seq: TaskSequence; steps: TaskItem[] }[]
  loose: TaskItem[]
}

/** A task's direct subtasks: its sequences (each with ordered steps), then loose ones. */
export function childrenOf(tree: TaskTree | undefined, parentId: string): Children {
  if (!tree) return { sequences: [], loose: [] }
  const kids = tree.tasks.filter((t) => t.parent_id === parentId).sort(byOrder)
  return {
    sequences: tree.sequences
      .filter((s) => s.task_id === parentId)
      .sort(byOrder)
      .map((seq) => ({ seq, steps: kids.filter((k) => k.sequence_id === seq.id) })),
    loose: kids.filter((k) => !k.sequence_id),
  }
}

/** A sort key between two neighbours (either may be missing). */
export function sortBetween(before?: number, after?: number): number {
  if (before === undefined && after === undefined) return 1
  if (before === undefined) return after! - 1
  if (after === undefined) return before + 1
  return (before + after) / 2
}

/** New sort_order for moving `id` one place up (-1) or down (+1) among `siblings`, or null at an edge. */
export function nudgeOrder(siblings: TaskItem[], id: string, dir: -1 | 1): number | null {
  const i = siblings.findIndex((s) => s.id === id)
  const j = i + dir
  if (i < 0 || j < 0 || j >= siblings.length) return null
  // land just past the neighbour, on the far side from where we came
  return dir < 0
    ? sortBetween(siblings[j - 1]?.sort_order, siblings[j].sort_order)
    : sortBetween(siblings[j].sort_order, siblings[j + 1]?.sort_order)
}

export interface LinkEnd { link: TaskLink; id: string; title: string; state: TaskState; rootId: string }

/** A task's links, from its own point of view: what it waits for, what waits for it, and related ones. */
export function linksOf(tree: TaskTree | undefined, id: string): { after: LinkEnd[]; before: LinkEnd[]; related: LinkEnd[] } {
  const out = { after: [] as LinkEnd[], before: [] as LinkEnd[], related: [] as LinkEnd[] }
  if (!tree) return out
  for (const l of tree.links) {
    if (l.from_task_id !== id && l.to_task_id !== id) continue
    const otherId = l.from_task_id === id ? l.to_task_id : l.from_task_id
    const inTree = tree.tasks.find((t) => t.id === otherId)
    const end: LinkEnd = inTree
      ? { link: l, id: otherId, title: inTree.title, state: inTree.state, rootId: inTree.root_id }
      : { link: l, id: otherId, title: l.other.title, state: l.other.state, rootId: l.other.root_id }
    if (l.kind === 'related') out.related.push(end)
    else if (l.to_task_id === id) out.after.push(end)
    else out.before.push(end)
  }
  return out
}

/** Every task below `id` in the tree (to keep a picker from offering a cycle). */
export function descendantIds(tree: TaskTree | undefined, id: string): Set<string> {
  const out = new Set<string>()
  if (!tree) return out
  const walk = (p: string) => { for (const t of tree.tasks) if (t.parent_id === p && !out.has(t.id)) { out.add(t.id); walk(t.id) } }
  walk(id)
  return out
}

const BOX: Record<TaskState, string> = { open: '[ ]', in_progress: '[~]', on_hold: '[ ]', done: '[x]', cancelled: '[-]' }

/** One line's extras: "(in progress · high)" — a pasted copy should read on its own. */
function extras(t: TaskItem): string {
  const bits: string[] = []
  if (t.state === 'in_progress' || t.state === 'on_hold' || t.state === 'cancelled') bits.push(STATES.find((s) => s.id === t.state)!.label.toLowerCase())
  if (t.priority) bits.push(t.priority)
  return bits.length ? ` (${bits.join(' · ')})` : ''
}

/**
 * A task and everything under it as a plain-text checklist, for pasting anywhere:
 * `- [ ]` / `- [x]` lines, sequences as numbered steps under their name.
 */
export function taskAsText(tree: TaskTree | undefined, t: TaskItem): string {
  const lines = [`${t.title}${extras(t)}`]
  const walk = (parentId: string, pad: string) => {
    const { sequences, loose } = childrenOf(tree, parentId)
    for (const { seq, steps } of sequences) {
      lines.push(`${pad}${seq.title || 'Sequence'}:`)
      steps.forEach((s, i) => { lines.push(`${pad}  ${i + 1}. ${BOX[s.state]} ${s.title}${extras(s)}`); walk(s.id, `${pad}     `) })
    }
    for (const k of loose) { lines.push(`${pad}- ${BOX[k.state]} ${k.title}${extras(k)}`); walk(k.id, `${pad}  `) }
  }
  walk(t.id, '')
  return lines.join('\n')
}
