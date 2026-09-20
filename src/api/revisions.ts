import { supabase } from '@/lib/supabase'
import { toError } from './errors'

export interface Revision { id: string; title: string | null; content: string; saved_at: string }

/** Earlier versions of a note (newest first). The database keeps at most 10, one per ~15 minutes of editing. */
export async function listRevisions(noteId: string): Promise<Revision[]> {
  const { data, error } = await supabase
    .from('note_revisions').select('id,title,content,saved_at').eq('note_id', noteId).order('saved_at', { ascending: false }).limit(10)
  if (error) throw toError(error)
  return (data as Revision[]) ?? []
}

/** Keep the CURRENT text as a revision before restoring an older one, so a restore is itself undoable. */
export async function snapshotCurrent(noteId: string, title: string | null, content: string): Promise<void> {
  const { error } = await supabase.from('note_revisions').insert({ note_id: noteId, title, content })
  if (error) throw toError(error)
}
