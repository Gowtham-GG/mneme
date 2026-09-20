import { describe, expect, it } from 'vitest'
import { noteToMarkdown, safeFileName, tasksToCsv, type ExportNote } from './exportFormat'

const note: ExportNote = {
  id: 'u', public_id: 'N-260920-042', title: 'JVM "Class" Loading', content: 'body #java', note_type: 'knowledge', is_starred: true,
  paper_ref: 'N1-042', created_at: '2026-09-20T09:20:00Z', updated_at: '2026-09-21T10:00:00Z', archived_at: null, deleted_at: null,
  tags: ['java', 'jvm/memory'], links_to: ['N-260920-043'],
}

describe('export formatting', () => {
  it('notes become Markdown with a YAML front-matter block', () => {
    const md = noteToMarkdown(note)
    expect(md.startsWith('---\nid: N-260920-042\n')).toBe(true)
    expect(md).toContain('title: "JVM \\"Class\\" Loading"')
    expect(md).toContain('tags: ["java", "jvm/memory"]')
    expect(md).toContain('links: ["N-260920-043"]')
    expect(md).toContain('paper_ref: "N1-042"')
    expect(md.endsWith('# JVM "Class" Loading\n\nbody #java\n')).toBe(true)
  })
  it('untitled notes keep their text and mark title null', () => {
    const md = noteToMarkdown({ ...note, title: null, paper_ref: null })
    expect(md).toContain('title: null')
    expect(md).not.toContain('paper_ref')
    expect(md.endsWith('---\nbody #java\n')).toBe(true)
  })
  it('CSV quotes commas/newlines and defuses formulas', () => {
    const csv = tasksToCsv([{ id: '1', note_public_id: 'N-1', title: 'a, "b"\nc', status: 'open', priority: null, due_date: null, created_at: 'x', completed_at: null },
      { id: '2', note_public_id: null, title: '=cmd|calc', status: 'done', priority: 'high', due_date: '2026-10-01', created_at: 'x', completed_at: 'y' }])
    const lines = csv.split('\n')
    expect(lines[0]).toBe('id,note,title,status,priority,due_date,created_at,completed_at')
    expect(csv).toContain('"a, ""b""\nc"')
    expect(csv).toContain("'=cmd|calc")
  })
  it('safeFileName strips path characters', () => { expect(safeFileName('../a b/c')).toBe('.._a_b_c') })
})
