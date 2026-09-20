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

export async function addStandaloneTask(title: string, due_date: string | null = null): Promise<void> {
  const { error } = await supabase.from('tasks').insert({ source: 'standalone', title: title.trim(), due_date })
  if (error) throw toError(error)
}

export async function updateTask(id: string, patch: { due_date?: string | null; priority?: TaskPriority | null; title?: string }): Promise<void> {
  const { error } = await supabase.from('tasks').update(patch).eq('id', id)
  if (error) throw toError(error)
}

export async function deleteStandaloneTask(id: string): Promise<void> {
  const { error } = await supabase.from('tasks').delete().eq('id', id).eq('source', 'standalone')
  if (error) throw toError(error)
}
