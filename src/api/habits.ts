import { supabase } from '@/lib/supabase'
import type { Habit, HabitDay } from '@/types/db'
import { toError } from './errors'

export const EVERY_DAY = 127

export async function habitsForDay(day: string): Promise<HabitDay[]> {
  const { data, error } = await supabase.rpc('habits_for_day', { p_day: day })
  if (error) throw toError(error)
  return (data as HabitDay[]) ?? []
}

/** Atomically add `delta` (may be negative) to a habit's count for `day`; returns the new count. */
export async function bumpHabit(id: string, day: string, delta: number): Promise<number> {
  const { data, error } = await supabase.rpc('bump_habit', { p_habit: id, p_day: day, p_delta: delta })
  if (error) throw toError(error)
  return Number(data ?? 0)
}

export async function listHabits(): Promise<Habit[]> {
  const { data, error } = await supabase
    .from('habits').select('*').is('archived_at', null).order('position').order('created_at')
  if (error) throw toError(error)
  return (data as Habit[]) ?? []
}

export type HabitInput = Pick<Habit, 'name' | 'target' | 'unit' | 'days'>

export async function createHabit(h: HabitInput): Promise<void> {
  const { error } = await supabase.from('habits').insert({ ...h, name: h.name.trim(), unit: h.unit?.trim() || null })
  if (error) throw toError(error)
}

export async function updateHabit(id: string, patch: Partial<HabitInput> & { archived_at?: string | null }): Promise<void> {
  const { error } = await supabase.from('habits').update(patch).eq('id', id)
  if (error) throw toError(error)
}

export interface HabitLog { habit_id: string; day: string; value: number }

/** Every habit's logged days from `from` ('YYYY-MM-DD') on — feeds the heatmaps and stats. */
export async function listHabitLogs(from: string): Promise<HabitLog[]> {
  const { data, error } = await supabase.from('habit_logs').select('habit_id,day,value').gte('day', from).order('day')
  if (error) throw toError(error)
  return (data as HabitLog[]) ?? []
}
