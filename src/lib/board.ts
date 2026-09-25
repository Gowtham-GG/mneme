// Pure geometry for the task board: automatic layout, arrows, the highlighted chain.
import type { TaskItem, TaskLink, TaskTree } from '@/types/db'
import { childrenOf } from './taskTree'

export const BOX_W = 212
export const BOX_H = 62
export const GAP_X = 56
export const GAP_Y = 16
export const PORTAL_W = 172
export const PORTAL_H = 30

export interface Pt { x: number; y: number }
export interface BoardData extends TaskTree { positions: Record<string, Pt> }

const byOrder = (a: TaskItem, b: TaskItem) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)

/** Main tasks in drawing order; the steps of a top-level (note) sequence stay together, in order. */
function orderedRoots(data: TaskTree): TaskItem[] {
  const ids = new Set(data.tasks.map((t) => t.id))
  const roots = data.tasks.filter((t) => !t.parent_id || !ids.has(t.parent_id))
  const out: TaskItem[] = []
  const done = new Set<string>()
  for (const r of roots) {
    if (done.has(r.id)) continue
    const run = r.sequence_id ? roots.filter((x) => x.sequence_id === r.sequence_id).sort(byOrder) : [r]
    for (const x of run) { out.push(x); done.add(x.id) }
  }
  return out
}

/** Tidy default: each main task in column 0, its subtasks one column right, stacked (sequences first, in order). */
export function autoLayout(data: TaskTree): Map<string, Pt> {
  const pos = new Map<string, Pt>()
  const place = (t: TaskItem, depth: number, y0: number): number => {
    pos.set(t.id, { x: depth * (BOX_W + GAP_X), y: y0 })
    const { sequences, loose } = childrenOf(data, t.id)
    const kids = [...sequences.flatMap((s) => s.steps), ...loose]
    let y = y0
    for (const k of kids) if (!pos.has(k.id)) y = place(k, depth + 1, y)
    return Math.max(y, y0 + BOX_H + GAP_Y)
  }
  let y = 0
  const roots = orderedRoots(data)
  roots.forEach((r, i) => {
    const sameRun = i > 0 && r.sequence_id && roots[i - 1].sequence_id === r.sequence_id
    y = place(r, 0, y) + (sameRun ? 0 : GAP_Y)
  })
  return pos
}

/**
 * Where each box is drawn: its saved spot, else its automatic spot kept relative to its
 * parent's drawn spot — so a dragged main task carries its (unplaced) subtasks along.
 */
export function drawnPositions(data: BoardData, overrides: Record<string, Pt> = {}): Map<string, Pt> {
  const auto = autoLayout(data)
  const byId = new Map(data.tasks.map((t) => [t.id, t]))
  const out = new Map<string, Pt>()
  const get = (id: string): Pt => {
    const hit = out.get(id)
    if (hit) return hit
    const saved = overrides[id] ?? data.positions[id]
    const t = byId.get(id)
    let p: Pt
    if (saved) p = saved
    else if (t?.parent_id && byId.has(t.parent_id)) {
      const pp = get(t.parent_id), a = auto.get(id)!, ap = auto.get(t.parent_id)!
      p = { x: pp.x + a.x - ap.x, y: pp.y + a.y - ap.y }
    } else p = auto.get(id) ?? { x: 0, y: 0 }
    out.set(id, p)
    return p
  }
  for (const t of data.tasks) get(t.id)
  return out
}

export type EdgeKind = 'tree' | 'step' | 'blocks' | 'related'
export interface Edge { id: string; from: string; to: string; kind: EdgeKind }
/** A link whose other end is on another board: drawn as a small box beside the task. */
export interface Portal { id: string; taskId: string; link: TaskLink; kind: 'blocks' | 'related'; outgoing: boolean }

export function boardEdges(data: TaskTree): { edges: Edge[]; portals: Portal[] } {
  const ids = new Set(data.tasks.map((t) => t.id))
  const edges: Edge[] = []
  const chain = (steps: TaskItem[]) => steps.slice(1).forEach((s, i) => edges.push({ id: `s:${s.id}`, from: steps[i].id, to: s.id, kind: 'step' }))
  for (const t of data.tasks) {
    const { sequences, loose } = childrenOf(data, t.id)
    for (const { steps } of sequences) {
      if (steps[0]) edges.push({ id: `t:${steps[0].id}`, from: t.id, to: steps[0].id, kind: 'tree' })
      chain(steps)
    }
    for (const k of loose) edges.push({ id: `t:${k.id}`, from: t.id, to: k.id, kind: 'tree' })
  }
  // top-level sequences (a numbered run in a note) have no parent box
  for (const s of data.sequences.filter((q) => !q.task_id)) chain(data.tasks.filter((t) => t.sequence_id === s.id).sort(byOrder))
  const portals: Portal[] = []
  for (const l of data.links) {
    const fromIn = ids.has(l.from_task_id), toIn = ids.has(l.to_task_id)
    if (fromIn && toIn) edges.push({ id: `l:${l.id}`, from: l.from_task_id, to: l.to_task_id, kind: l.kind })
    else portals.push({ id: `p:${l.id}`, taskId: fromIn ? l.from_task_id : l.to_task_id, link: l, kind: l.kind, outgoing: fromIn })
  }
  return { edges, portals }
}

/** Link boxes go in the first free spot beside their task: right, left, below, then above. */
export function portalPositions(portals: Portal[], drawn: Map<string, Pt>): Map<string, Pt> {
  const out = new Map<string, Pt>()
  const taken = [...drawn.values()].map((p) => ({ x: p.x, y: p.y, w: BOX_W, h: BOX_H }))
  const free = (x: number, y: number) =>
    !taken.some((r) => x < r.x + r.w + 6 && x + PORTAL_W + 6 > r.x && y < r.y + r.h + 6 && y + PORTAL_H + 6 > r.y)
  for (const p of portals) {
    const at = drawn.get(p.taskId)
    if (!at) continue
    const spots: Pt[] = []
    for (let i = 0; i < 4; i++) {
      const dy = i * (PORTAL_H + 6)
      spots.push({ x: at.x + BOX_W + 28, y: at.y + dy }, { x: at.x - PORTAL_W - 28, y: at.y + dy },
        { x: at.x, y: at.y + BOX_H + 8 + dy }, { x: at.x, y: at.y - PORTAL_H - 8 - dy })
    }
    const spot = spots.find((s) => free(s.x, s.y)) ?? spots[0]
    out.set(p.id, spot)
    taken.push({ x: spot.x, y: spot.y, w: PORTAL_W, h: PORTAL_H })
  }
  return out
}

/**
 * The chain around a task: its main task(s) above, everything below it, what must happen
 * before it (earlier steps, "waits for" links — also for its ancestors, since they block it
 * too) and what waits on it, followed all the way; plus directly related tasks.
 */
export function chainOf(data: TaskTree, id: string): Set<string> {
  const byId = new Map(data.tasks.map((t) => [t.id, t]))
  const pred = new Map<string, string[]>(), succ = new Map<string, string[]>()
  const add = (m: Map<string, string[]>, k: string, v: string) => m.set(k, [...(m.get(k) ?? []), v])
  for (const e of boardEdges(data).edges) {
    if (e.kind === 'step' || e.kind === 'blocks') { add(pred, e.to, e.from); add(succ, e.from, e.to) }
  }
  const out = new Set<string>([id])
  for (let p = byId.get(id)?.parent_id; p && byId.has(p); p = byId.get(p)?.parent_id) out.add(p)
  const walk = (start: string[], m: Map<string, string[]>) => {
    const q = [...start]
    while (q.length) for (const n of m.get(q.pop()!) ?? []) if (!out.has(n)) { out.add(n); q.push(n) }
  }
  walk([...out], pred)
  walk([id], succ)
  const down = [id]
  while (down.length) { const p = down.pop()!; for (const t of data.tasks) if (t.parent_id === p && !out.has(t.id)) { out.add(t.id); down.push(t.id) } }
  for (const l of data.links) if (l.kind === 'related') {
    if (l.from_task_id === id) out.add(l.to_task_id)
    if (l.to_task_id === id) out.add(l.from_task_id)
  }
  return out
}

/** A smooth arrow from box a to box b, leaving/entering on the facing sides. */
export function edgePath(a: Pt, aw: number, ah: number, b: Pt, bw: number, bh: number): string {
  let x1: number, y1: number, x2: number, y2: number, horizontal: boolean
  if (b.x >= a.x + aw) { x1 = a.x + aw; y1 = a.y + ah / 2; x2 = b.x; y2 = b.y + bh / 2; horizontal = true }
  else if (b.x + bw <= a.x) { x1 = a.x; y1 = a.y + ah / 2; x2 = b.x + bw; y2 = b.y + bh / 2; horizontal = true }
  else if (b.y >= a.y) { x1 = a.x + aw / 2; y1 = a.y + ah; x2 = b.x + bw / 2; y2 = b.y; horizontal = false }
  else { x1 = a.x + aw / 2; y1 = a.y; x2 = b.x + bw / 2; y2 = b.y + bh; horizontal = false }
  const c = Math.max(24, (horizontal ? Math.abs(x2 - x1) : Math.abs(y2 - y1)) / 2)
  const [c1, c2] = horizontal
    ? [`${x1 + Math.sign(x2 - x1) * c} ${y1}`, `${x2 - Math.sign(x2 - x1) * c} ${y2}`]
    : [`${x1} ${y1 + Math.sign(y2 - y1) * c}`, `${x2} ${y2 - Math.sign(y2 - y1) * c}`]
  return `M ${x1} ${y1} C ${c1}, ${c2}, ${x2} ${y2}`
}

export function boundsOf(points: Iterable<Pt>, w = BOX_W, h = BOX_H): { x: number; y: number; w: number; h: number } | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const p of points) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x + w); y1 = Math.max(y1, p.y + h) }
  return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/**
 * Pan/zoom that fits `b` into a viewport of vw x vh, never zooming past 1 nor below `minK`
 * (kept readable). When it doesn't fit even at `minK`, it starts at the top-left instead.
 */
export function fitView(b: { x: number; y: number; w: number; h: number } | null, vw: number, vh: number, minK = 0.3, pad = 32): { x: number; y: number; k: number } {
  if (!b) return { x: pad, y: pad, k: 1 }
  const want = Math.min(1, (vw - pad * 2) / b.w, (vh - pad * 2) / b.h)
  const k = Math.max(minK, want)
  const x = want < minK && b.w * k > vw - pad * 2 ? pad - b.x * k : (vw - b.w * k) / 2 - b.x * k
  const y = want < minK && b.h * k > vh - pad * 2 ? pad - b.y * k : Math.max(pad, (vh - b.h * k) / 2) - b.y * k
  return { x, y, k }
}

export interface Progress {
  done: number
  total: number
  left: number
  /** Days from today to the task's due date (negative = past), when it has one. */
  daysLeft: number | null
  /** overdue: past due with steps left · tight: more steps left than days (at ~one a day) */
  pace: 'overdue' | 'tight' | 'ok' | null
}

const dayNum = (key: string) => Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10))) / 864e5

/** How far along a task is, counted in its smallest steps (the tasks under it with nothing under them). */
export function progressOf(data: TaskTree, id: string, today: string): Progress | null {
  const kids = new Map<string, TaskItem[]>()
  for (const t of data.tasks) if (t.parent_id) kids.set(t.parent_id, [...(kids.get(t.parent_id) ?? []), t])
  const leaves: TaskItem[] = []
  const walk = (p: string) => { for (const k of kids.get(p) ?? []) (kids.has(k.id) ? walk(k.id) : leaves.push(k)) }
  walk(id)
  if (!leaves.length) return null
  const done = leaves.filter((t) => t.state === 'done' || t.state === 'cancelled').length
  const left = leaves.length - done
  const due = data.tasks.find((t) => t.id === id)?.due_date
  const daysLeft = due ? dayNum(due) - dayNum(today) : null
  const pace = daysLeft === null || left === 0 ? null : daysLeft < 0 ? 'overdue' : left > daysLeft + 1 ? 'tight' : 'ok'
  return { done, total: leaves.length, left, daysLeft, pace }
}

/**
 * Where a main task sits in a tidy board: open work first (things that must happen first
 * ahead of what waits on them), then by due date, in progress before open; finished last.
 */
function tidyRank(t: TaskItem): [number, string, number] {
  const resolved = t.state === 'done' || t.state === 'cancelled'
  const lane = resolved ? 3 : t.state === 'on_hold' ? 2 : t.state === 'in_progress' ? 0 : 1
  return [resolved ? 2 : t.due_date ? 0 : 1, `${t.due_date ?? ''} ${t.due_time ?? ''}`, lane]
}
const cmpRank = (a: TaskItem, b: TaskItem) => {
  const [x, y] = [tidyRank(a), tidyRank(b)]
  return x[0] - y[0] || x[1].localeCompare(y[1]) || x[2] - y[2] || byOrder(a, b)
}

/**
 * The Tidy button: every task gets a fresh spot. Each main task's tree is drawn as a block
 * (subtasks one column right, sequences in order, loose ones by urgency), and the blocks
 * flow top-to-bottom into columns sized to roughly match the viewport's shape (`aspect` = w/h).
 */
export function tidyLayout(data: TaskTree, aspect = 16 / 9, withPortals: Set<string> = new Set()): Map<string, Pt> {
  const ids = new Set(data.tasks.map((t) => t.id))
  // group top-level sequence runs, then order the groups
  const groups: TaskItem[][] = []
  const seen = new Set<string>()
  const roots = orderedRoots(data)
  for (const r of roots) {
    if (seen.has(r.id)) continue
    const run = r.sequence_id ? roots.filter((x) => x.sequence_id === r.sequence_id) : [r]
    run.forEach((x) => seen.add(x.id))
    groups.push(run)
  }
  const lead = (g: TaskItem[]) => [...g].sort(cmpRank)[0]
  groups.sort((a, b) => cmpRank(lead(a), lead(b)))
  // "must happen first" between main tasks: keep the first one earlier (stable topological pass)
  const groupOf = new Map<string, number>()
  const rootOf = (id: string) => { let t = data.tasks.find((x) => x.id === id); while (t?.parent_id && ids.has(t.parent_id)) t = data.tasks.find((x) => x.id === t!.parent_id); return t?.id }
  groups.forEach((g, i) => g.forEach((t) => groupOf.set(t.id, i)))
  const before = new Map<number, Set<number>>()
  for (const l of data.links) {
    if (l.kind !== 'blocks' || !ids.has(l.from_task_id) || !ids.has(l.to_task_id)) continue
    const a = groupOf.get(rootOf(l.from_task_id)!), b = groupOf.get(rootOf(l.to_task_id)!)
    if (a === undefined || b === undefined || a === b) continue
    before.set(b, (before.get(b) ?? new Set()).add(a))
  }
  const order: number[] = [], placed = new Set<number>()
  while (order.length < groups.length) {
    const ready = groups.findIndex((_, i) => !placed.has(i) && [...(before.get(i) ?? [])].every((p) => placed.has(p)))
    const next = ready >= 0 ? ready : groups.findIndex((_, i) => !placed.has(i)) // a cycle: just take the next
    order.push(next); placed.add(next)
  }

  // lay out each group as a block at the origin
  type Block = { pos: Map<string, Pt>; w: number; h: number }
  const blocks: Block[] = order.map((gi) => {
    const pos = new Map<string, Pt>()
    let w = 0
    const place = (t: TaskItem, depth: number, y0: number): number => {
      pos.set(t.id, { x: depth * (BOX_W + GAP_X), y: y0 })
      w = Math.max(w, depth * (BOX_W + GAP_X) + BOX_W + (withPortals.has(t.id) ? PORTAL_W + 28 : 0))
      const { sequences, loose } = childrenOf(data, t.id)
      const kids = [...sequences.flatMap((s) => s.steps), ...[...loose].sort(cmpRank)]
      let y = y0
      for (const k of kids) if (!pos.has(k.id)) y = place(k, depth + 1, y)
      return Math.max(y, y0 + BOX_H + GAP_Y)
    }
    let y = 0
    for (const t of groups[gi]) y = place(t, 0, y)
    return { pos, w, h: y - GAP_Y }
  })

  // flow the blocks into columns: pick the column height whose overall shape is closest to `aspect`
  const GAP_BLOCK = GAP_Y * 2, GAP_COL = GAP_X * 1.5
  const flow = (maxH: number) => {
    const at: Pt[] = []
    let x = 0, y = 0, colW = 0, H = 0
    for (const b of blocks) {
      if (y > 0 && y + b.h > maxH) { x += colW + GAP_COL; y = 0; colW = 0 }
      at.push({ x, y })
      y += b.h + GAP_BLOCK; colW = Math.max(colW, b.w); H = Math.max(H, y - GAP_BLOCK)
    }
    return { at, W: x + colW, H }
  }
  const tallest = Math.max(0, ...blocks.map((b) => b.h))
  const total = blocks.reduce((s, b) => s + b.h + GAP_BLOCK, 0)
  let best = flow(total)
  for (let i = 1; i <= 24; i++) {
    const maxH = tallest + ((total - tallest) * i) / 24
    const f = flow(maxH)
    const off = (r: { W: number; H: number }) => Math.abs(Math.log((r.W / Math.max(r.H, 1)) / aspect))
    if (off(f) < off(best)) best = f
  }
  const out = new Map<string, Pt>()
  blocks.forEach((b, i) => { for (const [id, p] of b.pos) out.set(id, { x: best.at[i].x + p.x, y: best.at[i].y + p.y }) })
  return out
}
