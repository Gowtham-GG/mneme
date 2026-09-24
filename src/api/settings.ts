import { supabase } from '@/lib/supabase'
import type { Settings, ThemePref } from '@/types/db'
import { toError } from './errors'

const SETTINGS_COLUMNS = 'user_id,timezone,theme,reminders_enabled,reminder_lead_minutes,reminder_morning_time,show_streaks,backup_enabled,backup_weekday'

export async function fetchSettings(): Promise<Settings | null> {
  const { data, error } = await supabase.from('settings').select(SETTINGS_COLUMNS).maybeSingle()
  if (error) throw toError(error)
  return data as Settings | null
}

export interface SettingsPatch {
  timezone?: string
  theme?: ThemePref
  reminders_enabled?: boolean
  reminder_lead_minutes?: number
  reminder_morning_time?: string
  show_streaks?: boolean
  backup_enabled?: boolean
  backup_weekday?: number
}

export async function saveSettings(patch: SettingsPatch): Promise<Settings> {
  const { data, error } = await supabase
    .from('settings').upsert(patch, { onConflict: 'user_id' }).select(SETTINGS_COLUMNS).single()
  if (error) throw toError(error)
  return data as Settings
}
