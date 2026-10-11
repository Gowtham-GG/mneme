import { supabase } from '@/lib/supabase'
import type { HabitDay, TaskItem } from '@/types/db'
import { toError } from './errors'

// A habit is a main task with a rhythm (tasks.rhythm_days); its subtasks are a routine ticked per day.

export const EVERY_DAY = 127

export async function habitsForDay(day: string): Promise<HabitDay[]> {
  const { data, error } = await supabase.rpc('habits_for_day', { p_day: day })
  if (error) throw toError(error)
  return (data as HabitDay[]) ?? []
}

/**
 * Atomically add `delta` (may be negative) to a habit's count for `day`, or tick (+1) / untick (−1)
 * one of its steps — a habit or step with steps of its own ticks/unticks all of them. Returns the new value.
 */
export async function checkIn(taskId: string, day: string, delta: number): Promise<number> {
  const { data, error } = await supabase.rpc('check_in', { p_task: taskId, p_day: day, p_delta: delta })
  if (error) throw toError(error)
  return Number(data ?? 0)
}

/** A one-line note on a habit's day; empty clears it. */
export async function setCheckinNote(taskId: string, day: string, note: string): Promise<void> {
  const { error } = await supabase.rpc('set_checkin_note', { p_task: taskId, p_day: day, p_note: note })
  if (error) throw toError(error)
}

/** Every habit task, whatever its status (paused, graduated and retired ones too). */
export async function listHabits(): Promise<TaskItem[]> {
  const { data, error } = await supabase
    .from('tasks_active').select('*').not('rhythm_days', 'is', null).order('created_at')
  if (error) throw toError(error)
  return (data as TaskItem[]) ?? []
}

export interface Rhythm { rhythm_days: number; rhythm_target: number; rhythm_unit: string | null }

export async function createHabit(title: string, r: Rhythm): Promise<void> {
  const { error } = await supabase.from('tasks')
    .insert({ source: 'standalone', title: title.trim(), ...r, rhythm_unit: r.rhythm_unit?.trim() || null })
  if (error) throw toError(error)
}

/** Make a main task repeat, change its rhythm, or (null) stop repeating — its history is kept. */
export async function setRhythm(taskId: string, r: Partial<Rhythm> | null): Promise<void> {
  const patch = r === null ? { rhythm_days: null } : { ...r, ...('rhythm_unit' in r ? { rhythm_unit: r.rhythm_unit?.trim() || null } : {}) }
  const { error } = await supabase.from('tasks').update(patch).eq('id', taskId)
  if (error) throw toError(error)
}

export interface StepRhythm { step_days: number | null; rhythm_target: number; rhythm_unit: string | null }

/** A habit's step: its own days (null = its parent's) and a count ("3 sets"; 1 = just a tick). */
export async function setStepRhythm(taskId: string, r: StepRhythm): Promise<void> {
  const { error } = await supabase.from('tasks')
    .update({ ...r, rhythm_unit: r.rhythm_unit?.trim() || null }).eq('id', taskId)
  if (error) throw toError(error)
}

export interface Checkin { task_id: string; day: string; value: number; note: string | null; skipped: boolean }

/** Every habit's check-ins from `from` ('YYYY-MM-DD') on — feeds the heatmaps, stats and notes. */
export async function listCheckins(from: string): Promise<Checkin[]> {
  const { data, error } = await supabase.from('task_checkins').select('task_id,day,value,note,skipped').gte('day', from).order('day')
  if (error) throw toError(error)
  return (data as Checkin[]) ?? []
}
