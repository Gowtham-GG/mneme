import { supabase } from '@/lib/supabase'
import type { Settings, ThemePref } from '@/types/db'
import { toError } from './errors'

export async function fetchSettings(): Promise<Settings | null> {
  const { data, error } = await supabase.from('settings').select('user_id,timezone,theme').maybeSingle()
  if (error) throw toError(error)
  return data as Settings | null
}

export async function saveSettings(patch: { timezone?: string; theme?: ThemePref }): Promise<Settings> {
  const { data, error } = await supabase
    .from('settings').upsert(patch, { onConflict: 'user_id' }).select('user_id,timezone,theme').single()
  if (error) throw toError(error)
  return data as Settings
}
