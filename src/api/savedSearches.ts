import { supabase } from '@/lib/supabase'
import type { SavedSearch } from '@/types/db'
import { toError } from './errors'

const COLUMNS = 'id,user_id,name,query,pinned,position,created_at'

export async function listSavedSearches(): Promise<SavedSearch[]> {
  const { data, error } = await supabase
    .from('saved_searches').select(COLUMNS)
    .order('pinned', { ascending: false }).order('position').order('created_at')
  if (error) throw toError(error)
  return (data as SavedSearch[]) ?? []
}

export async function createSavedSearch(name: string, query: string): Promise<SavedSearch> {
  const { data, error } = await supabase
    .from('saved_searches').insert({ name: name.trim(), query: query.trim() }).select(COLUMNS).single()
  if (error) throw toError(error)
  return data as SavedSearch
}

export async function renameSavedSearch(id: string, name: string): Promise<void> {
  const { error } = await supabase.from('saved_searches').update({ name: name.trim() }).eq('id', id)
  if (error) throw toError(error)
}

export async function setSavedSearchPinned(id: string, pinned: boolean): Promise<void> {
  const { error } = await supabase.from('saved_searches').update({ pinned }).eq('id', id)
  if (error) throw toError(error)
}

export async function deleteSavedSearch(id: string): Promise<void> {
  const { error } = await supabase.from('saved_searches').delete().eq('id', id)
  if (error) throw toError(error)
}
