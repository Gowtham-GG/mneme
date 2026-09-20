import { supabase } from '@/lib/supabase'
import type { NoteContext, TagCount } from '@/types/db'
import { toError } from './errors'

export async function tagCounts(): Promise<TagCount[]> {
  const { data, error } = await supabase.rpc('tag_counts')
  if (error) throw toError(error)
  return ((data as TagCount[]) ?? []).map((t) => ({ ...t, note_count: Number(t.note_count), direct_count: Number(t.direct_count) }))
}

export async function noteContext(noteId: string): Promise<NoteContext> {
  const { data, error } = await supabase.rpc('note_context', { p_note_id: noteId })
  if (error) throw toError(error)
  return data as NoteContext
}

/** Add a chip tag (source = 'manual'; never touched by the text sync). */
export async function addManualTag(noteId: string, rawName: string): Promise<void> {
  const name = rawName.trim().replace(/^#/, '').toLowerCase().replace(/[/-]+$/, '')
  const { data: existing, error: e1 } = await supabase.from('tags').select('id').eq('name', name).maybeSingle()
  if (e1) throw toError(e1)
  let tagId = (existing as { id: string } | null)?.id
  if (!tagId) {
    const { data, error } = await supabase.from('tags').insert({ name }).select('id').single()
    if (error) throw toError(error)
    tagId = (data as { id: string }).id
  }
  const { error } = await supabase
    .from('note_tags').upsert({ note_id: noteId, tag_id: tagId, source: 'manual' }, { onConflict: 'note_id,tag_id', ignoreDuplicates: true })
  if (error) throw toError(error)
}

export async function removeManualTag(noteId: string, tagId: string): Promise<void> {
  const { error } = await supabase.from('note_tags').delete().eq('note_id', noteId).eq('tag_id', tagId).eq('source', 'manual')
  if (error) throw toError(error)
  // drop the tag row if nothing uses it any more
  const { count } = await supabase.from('note_tags').select('note_id', { count: 'exact', head: true }).eq('tag_id', tagId)
  if (!count) await supabase.from('tags').delete().eq('id', tagId)
}

export async function setLinkType(linkId: string, relationship_type: string): Promise<void> {
  const { error } = await supabase.from('note_links').update({ relationship_type }).eq('id', linkId)
  if (error) throw toError(error)
}
