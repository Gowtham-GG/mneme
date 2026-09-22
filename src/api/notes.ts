import { supabase } from '@/lib/supabase'
import type { Note, NoteListItem, NoteType } from '@/types/db'
import { SaveError, toError } from './errors'

const NOTE_COLUMNS =
  'id,user_id,public_id,title,content,note_type,is_starred,paper_ref,version,created_at,updated_at,archived_at,deleted_at'

export async function fetchNote(id: string): Promise<Note | null> {
  const { data, error } = await supabase.from('notes').select(NOTE_COLUMNS).eq('id', id).maybeSingle()
  if (error) throw toError(error)
  return data as Note | null
}

export async function fetchNoteByPublicId(publicId: string): Promise<Note | null> {
  const { data, error } = await supabase
    .from('notes').select(NOTE_COLUMNS).eq('public_id', publicId.toUpperCase()).maybeSingle()
  if (error) throw toError(error)
  return data as Note | null
}

export interface NewNote { id: string; title: string | null; content: string; created_at: string }

/** Insert with a client-chosen UUID. A retry after a lost response hits the PK: that is reported as code 23505. */
export async function insertNote(n: NewNote): Promise<Note> {
  const { data, error } = await supabase
    .from('notes')
    .insert({ id: n.id, title: n.title, content: n.content, created_at: n.created_at })
    .select(NOTE_COLUMNS)
    .single()
  if (error) throw toError(error)
  return data as Note
}

/** Optimistic-concurrency update. Resolves to null when `version` no longer matches (= edited elsewhere). */
export async function updateNoteText(
  id: string, patch: { title: string | null; content: string }, baseVersion: number,
): Promise<Note | null> {
  const { data, error } = await supabase
    .from('notes').update(patch).eq('id', id).eq('version', baseVersion).select(NOTE_COLUMNS)
  if (error) throw toError(error)
  return ((data as Note[] | null) ?? [])[0] ?? null
}

export type NotePatch = Partial<Pick<Note, 'note_type' | 'is_starred' | 'paper_ref' | 'archived_at' | 'deleted_at'>>

export async function patchNote(id: string, patch: NotePatch): Promise<Note> {
  const { data, error } = await supabase.from('notes').update(patch).eq('id', id).select(NOTE_COLUMNS).single()
  if (error) throw toError(error)
  return data as Note
}

export const setNoteType = (id: string, note_type: NoteType) => patchNote(id, { note_type })
export const setStarred = (id: string, is_starred: boolean) => patchNote(id, { is_starred })
export const archiveNote = (id: string) => patchNote(id, { archived_at: new Date().toISOString() })
export const unarchiveNote = (id: string) => patchNote(id, { archived_at: null })
export const trashNote = (id: string) => patchNote(id, { deleted_at: new Date().toISOString() })
export const restoreNote = (id: string) => patchNote(id, { deleted_at: null })

export async function deleteNoteForever(id: string): Promise<void> {
  const { error } = await supabase.from('notes').delete().eq('id', id)
  if (error) throw toError(error)
}

/** Bulk versions for the Notes/Search list's multi-select action bar — one PostgREST round trip. */
export async function bulkPatchNotes(ids: string[], patch: NotePatch): Promise<void> {
  if (ids.length === 0) return
  const { error } = await supabase.from('notes').update(patch).in('id', ids)
  if (error) throw toError(error)
}

export async function bulkDeleteForever(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  const { error } = await supabase.from('notes').delete().in('id', ids)
  if (error) throw toError(error)
}

export async function emptyTrash(): Promise<number> {
  const { data, error } = await supabase.rpc('empty_trash')
  if (error) throw toError(error)
  return (data as number) ?? 0
}

export type NoteState = 'active' | 'archived' | 'trash' | 'all'

export interface ListParams {
  state?: NoteState
  order?: 'created' | 'updated'
  type?: NoteType | null
  starred?: boolean | null
  from?: string | null
  to?: string | null
  cursor?: { ts: string; id: string } | null
  limit?: number
}

export async function listNotes(p: ListParams = {}): Promise<NoteListItem[]> {
  const { data, error } = await supabase.rpc('list_notes', {
    p_state: p.state ?? 'active',
    p_order: p.order ?? 'created',
    p_type: p.type ?? null,
    p_starred: p.starred ?? null,
    p_from: p.from ?? null,
    p_to: p.to ?? null,
    p_cursor_ts: p.cursor?.ts ?? null,
    p_cursor_id: p.cursor?.id ?? null,
    p_limit: p.limit ?? 30,
  })
  if (error) throw toError(error)
  return (data as NoteListItem[]) ?? []
}

export async function recentViewed(limit = 8): Promise<NoteListItem[]> {
  const { data, error } = await supabase.rpc('recent_viewed', { p_limit: limit })
  if (error) throw toError(error)
  return (data as NoteListItem[]) ?? []
}

export async function inboxCount(): Promise<number> {
  const { data, error } = await supabase.rpc('inbox_count')
  if (error) throw toError(error)
  return Number(data ?? 0)
}

/** Record that a note was opened (powers "recently viewed"). Failure is harmless. */
export async function markViewed(noteId: string): Promise<void> {
  await supabase.from('note_views').upsert({ note_id: noteId, viewed_at: new Date().toISOString() }, { onConflict: 'user_id,note_id' })
}

export { SaveError }
