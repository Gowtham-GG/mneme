import type { ThemePref } from '@/lib/themes'

// Hand-written types for the `mneme` schema (mirrors supabase/migrations).
// Replace with `supabase gen types typescript --schema mneme` if desired.

export type NoteType = 'capture' | 'knowledge' | 'question' | 'idea' | 'meeting' | 'reference' | 'journal'

export const NOTE_TYPES: NoteType[] = ['capture', 'knowledge', 'question', 'idea', 'meeting', 'reference', 'journal']

/** Types a note can be switched to by hand — a journal page is only ever made by open_journal(). */
export const SETTABLE_NOTE_TYPES = NOTE_TYPES.filter((t) => t !== 'journal')

export const NOTE_TYPE_LABEL: Record<NoteType, string> = {
  capture: 'Capture',
  knowledge: 'Knowledge',
  question: 'Question',
  idea: 'Idea',
  meeting: 'Meeting',
  reference: 'Reference',
  journal: 'Journal',
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
  journal_date: string | null
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
  due_time: string | null
  position: number
  created_at: string
  completed_at: string | null
  note_public_id: string | null
  note_title: string | null
}

/** Row shape of the calendar_month() RPC. */
export interface CalendarDay {
  day: string
  notes: number
  meetings: number
  scheduled: number
  open_tasks: number
  done_tasks: number
  journal: boolean
}

export interface Habit {
  id: string
  user_id: string
  name: string
  /** 1 = a yes/no habit; more = a daily count to reach */
  target: number
  unit: string | null
  /** weekday bitmask: Monday = 1 … Sunday = 64; 127 = every day */
  days: number
  position: number
  created_at: string
  archived_at: string | null
}

/** Row shape of the habits_for_day() RPC. */
export interface HabitDay {
  id: string
  name: string
  target: number
  unit: string | null
  days: number
  position: number
  due: boolean
  value: number
  streak: number
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
  tasks: {
    id: string; title: string; status: TaskStatus
    due_date: string | null; due_time: string | null
    priority: TaskPriority | null; position: number
  }[]
}

export interface TagCount {
  name: string
  note_count: number
  direct_count: number
}

/** Row shape of the related_notes() RPC. */
export interface RelatedNote {
  id: string
  public_id: string
  title: string | null
  shared_tags: string[]
  score: number
}

export interface SavedSearch {
  id: string
  user_id: string
  name: string
  query: string
  pinned: boolean
  position: number
  created_at: string
}

export type { ThemePref } from '@/lib/themes'

export interface Settings {
  user_id: string
  timezone: string
  theme: ThemePref
  reminders_enabled: boolean
  reminder_lead_minutes: number
  reminder_morning_time: string
}
