import type { ThemePref } from '@/lib/themes'

// Hand-written types for the `mneme` schema (mirrors supabase/migrations).
// Replace with `supabase gen types typescript --schema mneme` if desired.

export type NoteType = 'capture' | 'knowledge' | 'question' | 'idea' | 'meeting' | 'reference'

export const NOTE_TYPES: NoteType[] = ['capture', 'knowledge', 'question', 'idea', 'meeting', 'reference']

export const NOTE_TYPE_LABEL: Record<NoteType, string> = {
  capture: 'Capture',
  knowledge: 'Knowledge',
  question: 'Question',
  idea: 'Idea',
  meeting: 'Meeting',
  reference: 'Reference',
}

export interface Note {
  id: string
  user_id: string
  public_id: string
  title: string | null
  content: string
  note_type: NoteType
  is_starred: boolean
  paper_ref: string | null
  version: number
  created_at: string
  updated_at: string
  archived_at: string | null
  deleted_at: string | null
}

/** Row shape returned by list_notes / search_notes / recent_viewed. */
export interface NoteListItem {
  id: string
  public_id: string
  title: string | null
  snippet: string
  note_type: NoteType
  is_starred: boolean
  created_at: string
  updated_at: string
  archived_at: string | null
  deleted_at: string | null
  open_tasks?: number
  rank?: number
  /** start of the body without highlight markers (search results only) */
  preview?: string
  viewed_at?: string
  tags: string[]
}

export type TaskStatus = 'open' | 'done'
export type TaskPriority = 'low' | 'medium' | 'high'

/** Row shape of the tasks_active view / list_tasks RPC. */
export interface TaskItem {
  id: string
  user_id: string
  note_id: string | null
  source: 'note' | 'standalone'
  title: string
  status: TaskStatus
  priority: TaskPriority | null
  due_date: string | null
  position: number
  created_at: string
  completed_at: string | null
  note_public_id: string | null
  note_title: string | null
}

export type TaskBucket = 'today' | 'upcoming' | 'no_date' | 'completed'

export interface LinkedNote {
  link_id: string
  id: string
  public_id: string
  title: string | null
  relationship_type: string
}

export interface NoteContext {
  tags: { id: string; name: string; source: 'inline' | 'manual' }[]
  links_to: LinkedNote[]
  linked_from: LinkedNote[]
  tasks: { id: string; title: string; status: TaskStatus; due_date: string | null; priority: TaskPriority | null; position: number }[]
}

export interface TagCount {
  name: string
  note_count: number
  direct_count: number
}

export type { ThemePref } from '@/lib/themes'

export interface Settings {
  user_id: string
  timezone: string
  theme: ThemePref
}
