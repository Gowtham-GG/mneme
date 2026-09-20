import { supabase } from '@/lib/supabase'
import type { NoteListItem } from '@/types/db'
import { toError } from './errors'

export async function searchNotes(query: string, limit = 30, offset = 0): Promise<NoteListItem[]> {
  const { data, error } = await supabase.rpc('search_notes', { p_query: query, p_limit: limit, p_offset: offset })
  if (error) throw toError(error)
  return (data as NoteListItem[]) ?? []
}
