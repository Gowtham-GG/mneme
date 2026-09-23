import { supabase } from '@/lib/supabase'
import type { TaskBucket, TaskItem, TaskPriority } from '@/types/db'
import { toError } from './errors'

export async function listTasks(bucket: TaskBucket, limit = 200): Promise<TaskItem[]> {
  const { data, error } = await supabase.rpc('list_tasks', { p_bucket: bucket, p_limit: limit })
  if (error) throw toError(error)
  return (data as TaskItem[]) ?? []
}

export async function setTaskDone(id: string, done: boolean): Promise<void> {
  const { error } = await supabase.rpc('set_task_done', { p_task_id: id, p_done: done })
  if (error) throw toError(error)
}

export async function addStandaloneTask(title: string, due_date: string | null = null, due_time: string | null = null): Promise<void> {
  const { error } = await supabase.from('tasks').insert({ source: 'standalone', title: title.trim(), due_date, due_time: due_date ? due_time : null })
  if (error) throw toError(error)
}

export async function updateTask(
  id: string,
  patch: { due_date?: string | null; due_time?: string | null; priority?: TaskPriority | null; title?: string },
): Promise<void> {
  const { error } = await supabase.from('tasks').update(patch).eq('id', id)
  if (error) throw toError(error)
}

/** Open, due-today-or-earlier task count — powers the Tasks dock badge. */
export async function dueTaskCount(): Promise<number> {
  const { data, error } = await supabase.rpc('due_task_count')
  if (error) throw toError(error)
  return Number(data ?? 0)
}

/** Deletes any task. A task that came from a note has its "- [ ]" line removed from that note. */
export async function deleteTask(id: string): Promise<void> {
  const { error } = await supabase.rpc('delete_task', { p_task_id: id })
  if (error) throw toError(error)
}

/** Deletes every completed task (see deleteTask); returns how many. */
export async function clearCompletedTasks(): Promise<number> {
  const { data, error } = await supabase.rpc('clear_completed_tasks')
  if (error) throw toError(error)
  return Number(data ?? 0)
}

/** Title search across all tasks, open ones first. */
export async function searchTasks(q: string, limit = 100): Promise<TaskItem[]> {
  const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
  const { data, error } = await supabase
    .from('tasks_active').select('*').ilike('title', pattern)
    .order('status', { ascending: false }).order('due_date', { ascending: true, nullsFirst: false }).limit(limit)
  if (error) throw toError(error)
  return (data as TaskItem[]) ?? []
}
