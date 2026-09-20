// Pure formatting for the export (no network, no DOM) so it can be unit-tested.
// Output is plain Markdown + JSON + CSV: no proprietary format, no lock-in.

export interface ExportNote {
  id: string; public_id: string; title: string | null; content: string; note_type: string; is_starred: boolean
  paper_ref: string | null; created_at: string; updated_at: string; archived_at: string | null; deleted_at: string | null
  tags: string[]; links_to: string[]
}
export interface ExportTask {
  id: string; note_public_id: string | null; title: string; status: string; priority: string | null
  due_date: string | null; created_at: string; completed_at: string | null
}

const yamlStr = (s: string) => JSON.stringify(s) // JSON strings are valid YAML scalars

export function noteToMarkdown(n: ExportNote): string {
  const fm = [
    '---',
    `id: ${n.public_id}`,
    `title: ${n.title ? yamlStr(n.title) : 'null'}`,
    `type: ${n.note_type}`,
    `starred: ${n.is_starred}`,
    `created: ${n.created_at}`,
    `updated: ${n.updated_at}`,
    ...(n.archived_at ? [`archived: ${n.archived_at}`] : []),
    ...(n.deleted_at ? [`trashed: ${n.deleted_at}`] : []),
    ...(n.paper_ref ? [`paper_ref: ${yamlStr(n.paper_ref)}`] : []),
    `tags: [${n.tags.map(yamlStr).join(', ')}]`,
    `links: [${n.links_to.map(yamlStr).join(', ')}]`,
    '---',
    '',
  ]
  return fm.join('\n') + (n.title ? `# ${n.title}\n\n` : '') + n.content + (n.content.endsWith('\n') ? '' : '\n')
}

const csvCell = (v: string | null | undefined) => {
  const s = v ?? ''
  // quote when needed; also neutralise spreadsheet formula injection (=, +, -, @ at the start)
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

export function tasksToCsv(tasks: ExportTask[]): string {
  const head = ['id', 'note', 'title', 'status', 'priority', 'due_date', 'created_at', 'completed_at']
  const rows = tasks.map((t) => [t.id, t.note_public_id, t.title, t.status, t.priority, t.due_date, t.created_at, t.completed_at].map(csvCell).join(','))
  return [head.join(','), ...rows].join('\n') + '\n'
}

export function safeFileName(s: string): string { return s.replace(/[^A-Za-z0-9._-]+/g, '_') }
