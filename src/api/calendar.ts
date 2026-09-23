import { supabase } from '@/lib/supabase'
import type { CalendarDay, TaskItem } from '@/types/db'
import { toError } from './errors'

/** Per-day marks (notes written, tasks/schedule due) for [from, to], both 'YYYY-MM-DD'. */
export async function calendarMonth(from: string, to: string): Promise<CalendarDay[]> {
  const { data, error } = await supabase.rpc('calendar_month', { p_from: from, p_to: to })
  if (error) throw toError(error)
  return (data as CalendarDay[]) ?? []
}

/** Every task (open and done) due on one day, timed ones first by time. */
export async function tasksOnDay(day: string): Promise<TaskItem[]> {
  const { data, error } = await supabase
    .from('tasks_active').select('*').eq('due_date', day)
    .order('due_time', { ascending: true, nullsFirst: false }).order('created_at')
  if (error) throw toError(error)
  return (data as TaskItem[]) ?? []
}
