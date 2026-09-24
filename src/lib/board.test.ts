import { describe, expect, it } from 'vitest'
import { autoLayout, boardEdges, BOX_H, BOX_W, chainOf, drawnPositions, edgePath, fitView, GAP_X, GAP_Y, PORTAL_W, portalPositions, progressOf, type BoardData } from './board'
import type { TaskItem } from '@/types/db'

const task = (id: string, over: Partial<TaskItem> = {}): TaskItem => ({
  id, user_id: 'u', note_id: null, source: 'standalone', title: id, status: 'open', priority: null,
  due_date: null, due_time: null, position: 0, created_at: '2026-01-01', completed_at: null,
  note_public_id: null, note_title: null, state: 'open', parent_id: null, sequence_id: null,
  sort_order: 0, blocked: false, child_count: 0, child_resolved: 0, updated_at: '2026-01-01',
  root_id: 'r', parent_title: null, code: 'T-00000000', snoozed_until: null, snoozed: false, ...over,
})

// r ─ seq s1: a → b ;  loose: c ;  x (another main task) blocks b ;  b links to an outside task
const data: BoardData = {
  tasks: [
    task('r', { created_at: '2026-01-01' }),
    task('a', { parent_id: 'r', sequence_id: 's1', sort_order: 1 }),
    task('b', { parent_id: 'r', sequence_id: 's1', sort_order: 2 }),
    task('c', { parent_id: 'r', sort_order: 3 }),
    task('x', { created_at: '2026-01-02' }),
  ],
  sequences: [{ id: 's1', task_id: 'r', title: 'Steps', sort_order: 1, created_at: '2026-01-01' }],
  links: [
    { id: 'l1', kind: 'blocks', from_task_id: 'x', to_task_id: 'b', other: { id: 'x', title: 'x', state: 'open', root_id: 'x' } },
    { id: 'l2', kind: 'related', from_task_id: 'b', to_task_id: 'far', other: { id: 'far', title: 'Far', state: 'open', root_id: 'far' } },
  ],
  canvas_ids: [],
  positions: {},
}

describe('autoLayout', () => {
  it('puts subtasks one column right, stacked in order, and trees below each other', () => {
    const p = autoLayout(data)
    const col = BOX_W + GAP_X, row = BOX_H + GAP_Y
    expect(p.get('r')).toEqual({ x: 0, y: 0 })
    expect(p.get('a')).toEqual({ x: col, y: 0 })
    expect(p.get('b')).toEqual({ x: col, y: row })
    expect(p.get('c')).toEqual({ x: col, y: 2 * row })
    expect(p.get('x')).toEqual({ x: 0, y: 3 * row + GAP_Y })
  })
})

describe('drawnPositions', () => {
  it('uses saved spots, and unplaced subtasks follow their parent', () => {
    const d = drawnPositions({ ...data, positions: { r: { x: 500, y: 500 }, b: { x: 0, y: 0 } } })
    expect(d.get('r')).toEqual({ x: 500, y: 500 })
    expect(d.get('a')).toEqual({ x: 500 + BOX_W + GAP_X, y: 500 })
    expect(d.get('b')).toEqual({ x: 0, y: 0 })
    const o = drawnPositions(data, { r: { x: 10, y: 10 } })
    expect(o.get('c')).toEqual({ x: 10 + BOX_W + GAP_X, y: 10 + 2 * (BOX_H + GAP_Y) })
  })
})

describe('boardEdges', () => {
  it('draws parent→first step, step→step, parent→loose, links, and outside links as portals', () => {
    const { edges, portals } = boardEdges(data)
    expect(edges.map((e) => `${e.kind}:${e.from}>${e.to}`).sort()).toEqual(['blocks:x>b', 'step:a>b', 'tree:r>a', 'tree:r>c'])
    expect(portals).toHaveLength(1)
    expect(portals[0]).toMatchObject({ taskId: 'b', kind: 'related', outgoing: true })
    const pp = portalPositions(portals, drawnPositions(data))
    expect(pp.get(portals[0].id)!.x).toBe(drawnPositions(data).get('b')!.x + BOX_W + 28) // right of b is free
    // with a box in the way on the right, it goes left instead
    const d2 = drawnPositions(data)
    d2.set('blocker', { x: d2.get('b')!.x + BOX_W + 20, y: d2.get('b')!.y })
    expect(portalPositions(portals, d2).get(portals[0].id)!.x).toBe(d2.get('b')!.x - PORTAL_W - 28)
  })
  it('chains the steps of a top-level sequence', () => {
    const d: BoardData = { ...data, tasks: [task('p', { sequence_id: 'q', sort_order: 1 }), task('n', { sequence_id: 'q', sort_order: 2 })],
      sequences: [{ id: 'q', task_id: null, title: null, sort_order: 1, created_at: '' }], links: [] }
    expect(boardEdges(d).edges.map((e) => `${e.from}>${e.to}`)).toEqual(['p>n'])
  })
})

describe('chainOf', () => {
  it('follows ancestors, what comes before (incl. links), what comes after and related tasks', () => {
    expect([...chainOf(data, 'b')].sort()).toEqual(['a', 'b', 'far', 'r', 'x'])
    expect([...chainOf(data, 'a')].sort()).toEqual(['a', 'b', 'r'])
    expect([...chainOf(data, 'r')].sort()).toEqual(['a', 'b', 'c', 'r'])
  })
})

describe('geometry', () => {
  it('leaves from the facing side', () => {
    expect(edgePath({ x: 0, y: 0 }, 100, 50, { x: 200, y: 0 }, 100, 50)).toMatch(/^M 100 25 C/)
    expect(edgePath({ x: 0, y: 0 }, 100, 50, { x: 0, y: 100 }, 100, 50)).toMatch(/^M 50 50 C .* 50 100$/)
  })
  it('fits content without zooming in past 1', () => {
    expect(fitView({ x: 0, y: 0, w: 100, h: 100 }, 1000, 800).k).toBe(1)
    expect(fitView({ x: 0, y: 0, w: 2000, h: 500 }, 1000, 800).k).toBeCloseTo((1000 - 64) / 2000)
    const big = fitView({ x: 0, y: 0, w: 40000, h: 500 }, 1000, 800)
    expect(big.k).toBe(0.3) // never smaller than readable…
    expect(big.x).toBe(32) // …and then it starts at the left edge
    expect(fitView({ x: 0, y: 0, w: 2000, h: 500 }, 390, 700, 0.6).k).toBe(0.6) // phones keep a readable zoom
  })
})

describe('progressOf', () => {
  const tree = (over: Record<string, Partial<TaskItem>>): BoardData => ({ ...data, tasks: data.tasks.map((t) => ({ ...t, ...over[t.id] })) })
  it('counts the smallest steps under a task', () => {
    const p = progressOf(tree({ a: { state: 'done' } }), 'r', '2026-09-25')!
    expect([p.done, p.total, p.left]).toEqual([1, 3, 2]) // a, b, c are leaves
    expect(progressOf(data, 'c', '2026-09-25')).toBeNull() // nothing under it
  })
  it('flags a deadline that is tight or already past', () => {
    expect(progressOf(tree({ r: { due_date: '2026-09-26' } }), 'r', '2026-09-25')!.pace).toBe('tight') // 3 steps, 2 days
    expect(progressOf(tree({ r: { due_date: '2026-09-27' } }), 'r', '2026-09-25')!.pace).toBe('ok')    // 3 steps, 3 days
    expect(progressOf(tree({ r: { due_date: '2026-09-25' } }), 'r', '2026-09-25')!.pace).toBe('tight')
    expect(progressOf(tree({ r: { due_date: '2026-10-10' } }), 'r', '2026-09-25')!.pace).toBe('ok')
    expect(progressOf(tree({ r: { due_date: '2026-09-20' } }), 'r', '2026-09-25')!.pace).toBe('overdue')
    expect(progressOf(tree({ r: { due_date: '2026-09-20' }, a: { state: 'done' }, b: { state: 'done' }, c: { state: 'cancelled' } }), 'r', '2026-09-25')!.pace).toBeNull()
  })
})
