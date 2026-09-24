import { describe, expect, it } from 'vitest'
import { childrenOf, descendantIds, linksOf, nudgeOrder, sortBetween } from './taskTree'
import type { TaskItem, TaskTree } from '@/types/db'

const task = (id: string, over: Partial<TaskItem> = {}): TaskItem => ({
  id, user_id: 'u', note_id: null, source: 'standalone', title: id, status: 'open', priority: null,
  due_date: null, due_time: null, position: 0, created_at: '2026-01-01', completed_at: null,
  note_public_id: null, note_title: null, state: 'open', parent_id: null, sequence_id: null,
  sort_order: 0, blocked: false, child_count: 0, child_resolved: 0, updated_at: '2026-01-01',
  root_id: 'r', parent_title: null, code: 'T-00000000', ...over,
})

const tree: TaskTree = {
  tasks: [
    task('r'),
    task('b', { parent_id: 'r', sequence_id: 's1', sort_order: 2 }),
    task('a', { parent_id: 'r', sequence_id: 's1', sort_order: 1 }),
    task('loose', { parent_id: 'r', sort_order: 1 }),
    task('c', { parent_id: 'r', sequence_id: 's2', sort_order: 1 }),
    task('g', { parent_id: 'a', sort_order: 1 }),
  ],
  sequences: [
    { id: 's2', task_id: 'r', title: 'Second', sort_order: 0, created_at: '2026-01-02' },
    { id: 's1', task_id: 'r', title: 'First', sort_order: 0, created_at: '2026-01-01' },
  ],
  links: [
    { id: 'l1', kind: 'blocks', from_task_id: 'x', to_task_id: 'a', other: { id: 'x', title: 'Visa', state: 'open', root_id: 'x' } },
    { id: 'l2', kind: 'blocks', from_task_id: 'a', to_task_id: 'c', other: { id: 'c', title: 'c', state: 'open', root_id: 'r' } },
    { id: 'l3', kind: 'related', from_task_id: 'y', to_task_id: 'a', other: { id: 'y', title: 'Budget', state: 'done', root_id: 'y' } },
  ],
  canvas_ids: [],
}

describe('childrenOf', () => {
  it('groups sequences in order with ordered steps, then loose subtasks', () => {
    const c = childrenOf(tree, 'r')
    expect(c.sequences.map((s) => s.seq.id)).toEqual(['s1', 's2'])
    expect(c.sequences[0].steps.map((t) => t.id)).toEqual(['a', 'b'])
    expect(c.loose.map((t) => t.id)).toEqual(['loose'])
  })
  it('is empty without a tree', () => {
    expect(childrenOf(undefined, 'r')).toEqual({ sequences: [], loose: [] })
  })
})

describe('sortBetween / nudgeOrder', () => {
  it('picks keys between neighbours', () => {
    expect(sortBetween(1, 2)).toBe(1.5)
    expect(sortBetween(undefined, 2)).toBe(1)
    expect(sortBetween(3, undefined)).toBe(4)
    expect(sortBetween()).toBe(1)
  })
  it('moves one place and stops at the edges', () => {
    const s = [task('a', { sort_order: 1 }), task('b', { sort_order: 2 }), task('c', { sort_order: 3 })]
    expect(nudgeOrder(s, 'c', -1)).toBe(1.5) // between a and b
    expect(nudgeOrder(s, 'a', 1)).toBe(2.5)  // between b and c
    expect(nudgeOrder(s, 'b', -1)).toBe(0)   // before a
    expect(nudgeOrder(s, 'a', -1)).toBeNull()
    expect(nudgeOrder(s, 'c', 1)).toBeNull()
  })
})

describe('linksOf', () => {
  it('sees links from the task’s own side', () => {
    const l = linksOf(tree, 'a')
    expect(l.after.map((e) => e.title)).toEqual(['Visa'])
    expect(l.before.map((e) => e.id)).toEqual(['c'])
    expect(l.related.map((e) => [e.title, e.rootId])).toEqual([['Budget', 'y']])
    expect(linksOf(tree, 'c').after.map((e) => e.title)).toEqual(['a'])
  })
})

describe('descendantIds', () => {
  it('collects the whole subtree', () => {
    expect([...descendantIds(tree, 'r')].sort()).toEqual(['a', 'b', 'c', 'g', 'loose'])
    expect([...descendantIds(tree, 'a')]).toEqual(['g'])
  })
})
