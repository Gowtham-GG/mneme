import { describe, expect, it } from 'vitest'
import { buildTagTree } from './tagTree'

const t = (name: string, note_count: number, direct_count = note_count) => ({ name, note_count, direct_count })

describe('buildTagTree', () => {
  it('nests by "/" and keeps the rolled-up counts from the database', () => {
    const tree = buildTagTree([t('jvm', 5, 1), t('jvm/memory', 3), t('jvm/memory/heap', 2), t('jvm/classloading', 2), t('java', 4), t('spring', 1)])
    expect(tree.map((n) => n.path)).toEqual(['java', 'jvm', 'spring'])
    const jvm = tree.find((n) => n.path === 'jvm')!
    expect(jvm).toMatchObject({ count: 5, direct: 1 })
    expect(jvm.children.map((c) => c.seg)).toEqual(['classloading', 'memory'])
    expect(jvm.children[1].children[0]).toMatchObject({ seg: 'heap', path: 'jvm/memory/heap', count: 2 })
  })
  it('a child whose parent tag has no notes of its own becomes a root (no invented parents)', () => {
    expect(buildTagTree([t('a/b', 1)]).map((n) => n.path)).toEqual(['a/b'])
  })
})
