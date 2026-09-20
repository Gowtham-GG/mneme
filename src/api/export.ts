import { strToU8, zipSync } from 'fflate'
import { supabase } from '@/lib/supabase'
import { noteToMarkdown, safeFileName, tasksToCsv, type ExportNote, type ExportTask } from '@/lib/exportFormat'
import { toError } from './errors'

const PAGE = 500

/** Pull a whole table in stable pages (never one giant request; nothing else is loaded into the UI). */
async function fetchAll<T>(table: string, columns: string, order: string): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from(table).select(columns).order(order, { ascending: true }).range(from, from + PAGE - 1)
    if (error) throw toError(error)
    const rows = (data ?? []) as T[]
    out.push(...rows)
    if (rows.length < PAGE) return out
  }
}

export interface ExportData { notes: ExportNote[]; tasks: ExportTask[]; exportedAt: string }

export async function collectExport(onProgress?: (msg: string) => void): Promise<ExportData> {
  onProgress?.('Reading notes…')
  const notes = await fetchAll<Omit<ExportNote, 'tags' | 'links_to'>>('notes', 'id,public_id,title,content,note_type,is_starred,paper_ref,created_at,updated_at,archived_at,deleted_at', 'created_at')
  onProgress?.('Reading tags and links…')
  const tags = await fetchAll<{ id: string; name: string }>('tags', 'id,name', 'id')
  const noteTags = await fetchAll<{ note_id: string; tag_id: string }>('note_tags', 'note_id,tag_id', 'note_id')
  const links = await fetchAll<{ source_note_id: string; target_note_id: string }>('note_links', 'source_note_id,target_note_id', 'source_note_id')
  onProgress?.('Reading tasks…')
  const rawTasks = await fetchAll<{ id: string; note_id: string | null; title: string; status: string; priority: string | null; due_date: string | null; created_at: string; completed_at: string | null; removed_at: string | null }>(
    'tasks', 'id,note_id,title,status,priority,due_date,created_at,completed_at,removed_at', 'created_at')

  const tagName = new Map(tags.map((t) => [t.id, t.name]))
  const publicId = new Map(notes.map((n) => [n.id, n.public_id]))
  const tagsOf = new Map<string, string[]>(), linksOf = new Map<string, string[]>()
  for (const nt of noteTags) { const n = tagName.get(nt.tag_id); if (n) (tagsOf.get(nt.note_id) ?? tagsOf.set(nt.note_id, []).get(nt.note_id)!).push(n) }
  for (const l of links) { const p = publicId.get(l.target_note_id); if (p) (linksOf.get(l.source_note_id) ?? linksOf.set(l.source_note_id, []).get(l.source_note_id)!).push(p) }

  return {
    exportedAt: new Date().toISOString(),
    notes: notes.map((n) => ({ ...n, tags: (tagsOf.get(n.id) ?? []).sort(), links_to: (linksOf.get(n.id) ?? []).sort() })),
    tasks: rawTasks.filter((t) => !t.removed_at).map((t) => ({ id: t.id, note_public_id: t.note_id ? publicId.get(t.note_id) ?? null : null, title: t.title, status: t.status, priority: t.priority, due_date: t.due_date, created_at: t.created_at, completed_at: t.completed_at })),
  }
}

/** Save a Blob through a temporary link. Works offline; nothing is uploaded anywhere. */
export function download(name: string, data: Blob | Uint8Array | string, type: string) {
  const part = data instanceof Uint8Array ? new Uint8Array(data) : data
  const blob = data instanceof Blob ? data : new Blob([part], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = name
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

const stamp = () => new Date().toISOString().slice(0, 10)

export async function exportMarkdownZip(onProgress?: (m: string) => void): Promise<number> {
  const d = await collectExport(onProgress)
  onProgress?.('Packing files…')
  const files: Record<string, Uint8Array> = {
    'notes.json': strToU8(JSON.stringify(d, null, 2)),
    'tasks.csv': strToU8(tasksToCsv(d.tasks)),
    'README.txt': strToU8('Mneme export\n\nnotes/  one Markdown file per note (YAML front-matter + text)\nnotes.json  everything in one JSON file\ntasks.csv  tasks\n\nAll plain text. Open with any editor.\n'),
  }
  for (const n of d.notes) files[`notes/${safeFileName(n.public_id)}.md`] = strToU8(noteToMarkdown(n))
  download(`mneme-export-${stamp()}.zip`, zipSync(files, { level: 6 }), 'application/zip')
  return d.notes.length
}

export async function exportJson(onProgress?: (m: string) => void): Promise<number> {
  const d = await collectExport(onProgress)
  download(`mneme-export-${stamp()}.json`, JSON.stringify(d, null, 2), 'application/json')
  return d.notes.length
}

export async function exportTasksCsv(onProgress?: (m: string) => void): Promise<number> {
  const d = await collectExport(onProgress)
  download(`mneme-tasks-${stamp()}.csv`, tasksToCsv(d.tasks), 'text/csv')
  return d.tasks.length
}
