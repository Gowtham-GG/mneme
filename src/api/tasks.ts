import { supabase } from '@/lib/supabase'
import type { Canvas, TaskBucket, TaskItem, TaskPriority, TaskState, TaskTree } from '@/types/db'
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

/** Any state. Rejected when blocked (start/finish) or when a parent still has open subtasks (finish). */
export async function setTaskState(id: string, state: TaskState): Promise<void> {
  const { error } = await supabase.rpc('set_task_state', { p_task_id: id, p_state: state })
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

/** Renames any task. A task that came from a note has its "- [ ]" line rewritten in that note. */
export async function renameTask(id: string, title: string): Promise<void> {
  const { error } = await supabase.rpc('rename_task', { p_task_id: id, p_title: title })
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

// ------------------------------------------------------------ task trees --

export async function getTaskTree(rootId: string): Promise<TaskTree> {
  const { data, error } = await supabase.rpc('task_tree', { p_root: rootId })
  if (error) throw toError(error)
  return data as TaskTree
}

/** A loose subtask, or a step appended to `sequenceId` (which decides the parent). */
export async function addSubtask(parentId: string, title: string, sequenceId: string | null = null): Promise<void> {
  const row: Record<string, string> = { source: 'standalone', title: title.trim() }
  if (sequenceId) row.sequence_id = sequenceId
  else row.parent_id = parentId
  const { error } = await supabase.from('tasks').insert(row)
  if (error) throw toError(error)
}

/** Re-home a task: new parent (null = main task), into/out of a sequence, or a new position. */
export async function moveTask(id: string, patch: { parent_id?: string | null; sequence_id?: string | null; sort_order?: number }): Promise<void> {
  const { error } = await supabase.from('tasks').update(patch).eq('id', id)
  if (error) throw toError(error)
}

export async function addSequence(taskId: string, title: string | null): Promise<string> {
  const { data, error } = await supabase.from('task_sequences').insert({ task_id: taskId, title: title?.trim() || null }).select('id').single()
  if (error) throw toError(error)
  return (data as { id: string }).id
}

export async function renameSequence(id: string, title: string | null): Promise<void> {
  const { error } = await supabase.from('task_sequences').update({ title: title?.trim() || null }).eq('id', id)
  if (error) throw toError(error)
}

/** Deletes the sequence and its steps. */
export async function deleteSequence(id: string): Promise<void> {
  const { error } = await supabase.from('task_sequences').delete().eq('id', id)
  if (error) throw toError(error)
}

export async function addTaskLink(fromId: string, toId: string, kind: 'blocks' | 'related'): Promise<void> {
  const { error } = await supabase.from('task_links').insert({ from_task_id: fromId, to_task_id: toId, kind })
  if (error) throw toError(error)
}

export async function deleteTaskLink(id: string): Promise<void> {
  const { error } = await supabase.from('task_links').delete().eq('id', id)
  if (error) throw toError(error)
}

/** Unfinished tasks for a picker: title match, or the most recently touched when q is empty. */
export async function pickableTasks(q: string, limit = 30): Promise<TaskItem[]> {
  let req = supabase.from('tasks_active').select('*').eq('status', 'open')
  if (q) req = req.ilike('title', `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
  const { data, error } = await req.order('updated_at', { ascending: false }).limit(limit)
  if (error) throw toError(error)
  return (data as TaskItem[]) ?? []
}

// -------------------------------------------------------------- canvases --

export interface CanvasData { canvases: Canvas[]; membership: { canvas_id: string; task_id: string }[] }

export async function listCanvases(): Promise<CanvasData> {
  const [c, m] = await Promise.all([
    supabase.from('canvases').select('id,name,sort_order').order('sort_order').order('name'),
    supabase.from('canvas_tasks').select('canvas_id,task_id'),
  ])
  if (c.error) throw toError(c.error)
  if (m.error) throw toError(m.error)
  return { canvases: (c.data as Canvas[]) ?? [], membership: (m.data as CanvasData['membership']) ?? [] }
}

export async function createCanvas(name: string): Promise<Canvas> {
  const { data, error } = await supabase.from('canvases').insert({ name: name.trim() }).select('id,name,sort_order').single()
  if (error) throw toError(error)
  return data as Canvas
}

export async function setTaskOnCanvas(taskId: string, canvasId: string, on: boolean): Promise<void> {
  const { error } = on
    ? await supabase.from('canvas_tasks').upsert({ canvas_id: canvasId, task_id: taskId }, { onConflict: 'canvas_id,task_id', ignoreDuplicates: true })
    : await supabase.from('canvas_tasks').delete().eq('canvas_id', canvasId).eq('task_id', taskId)
  if (error) throw toError(error)
}
