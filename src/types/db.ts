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
/** Full task status; `status` above is its finished/unfinished summary. */
export type TaskState = 'open' | 'in_progress' | 'on_hold' | 'done' | 'cancelled'

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
  state: TaskState
  parent_id: string | null
  sequence_id: string | null
  sort_order: number
  /** Waiting on an earlier step, a "must happen first" link, or a blocked ancestor. */
  blocked: boolean
  child_count: number
  child_resolved: number
  updated_at: string
  /** Top of this task's tree (itself for a main task). */
  root_id: string
  parent_title: string | null
  /** "T-1A2B3C4D" — what a [[T-…]] link in a note uses. */
  code: string
  snoozed_until: string | null
  /** Hidden from the lists until snoozed_until. */
  snoozed: boolean
  /** Set = this is a habit: the weekdays it's due on (Monday = 1 … Sunday = 64). */
  rhythm_days: number | null
  rhythm_target: number
  rhythm_unit: string | null
  /** The habit this task is (or is a step of); null for an ordinary task. */
  habit_id: string | null
  /** For a habit or one of its steps: ticked for today. */
  checked_today: boolean | null
  /** For a habit: its current streak. */
  streak: number | null
  /** A habit's step: its own weekdays inside the habit ("Upper body" Mon/Wed/Fri); null = whenever its parent is on. */
  step_days: number | null
  /** Habit or step: the weekdays it is actually on (its days, its parents', and its steps'). */
  due_days: number | null
  /** A habit's step: the weekdays its parent is on — what its own days can be picked from. */
  parent_days: number | null
  /** Habit or step: today's logged count (sets done, glasses drunk…). */
  value_today: number | null
}

export interface TaskSequence {
  id: string
  /** The parent task; null for a top-level numbered run in a note. */
  task_id: string | null
  title: string | null; sort_order: number; created_at: string
  /** Set when the sequence is written in a note (it is edited there). */
  note_id?: string | null
}

export interface TaskLink {
  id: string
  /** blocks: from must finish before to can start. related: a plain connection. */
  kind: 'blocks' | 'related'
  from_task_id: string
  to_task_id: string
  /** The end outside the fetched tree (or the `to` end when both are inside). */
  other: { id: string; title: string; state: TaskState; root_id: string; canvases?: { id: string; name: string }[] }
}

/** Row shape of the task_tree() RPC: one main task's whole tree. */
export interface TaskTree { tasks: TaskItem[]; sequences: TaskSequence[]; links: TaskLink[]; canvas_ids: string[] }

export interface Canvas { id: string; name: string; sort_order: number }

/** Row shape of the calendar_month() RPC. */
export interface CalendarDay {
  day: string
  notes: number
  meetings: number
  scheduled: number
  open_tasks: number
  done_tasks: number
  journal: boolean
  habits_due: number
  habits_met: number
}

/** Row shape of the habits_for_day() RPC: a habit task on that day. */
export interface HabitDay {
  id: string
  name: string
  /** daily count to reach (1 = yes/no); for a routine, how many steps it has */
  target: number
  unit: string | null
  /** weekdays it is on: Monday = 1 … Sunday = 64; 127 = every day (narrowed to the days its steps are on) */
  days: number
  state: TaskState
  created_at: string
  due: boolean
  /** waiting on a "must happen first" task: not due until that's done */
  blocked: boolean
  /** logged count; for a routine, steps ticked */
  value: number
  streak: number
  /** the day's one-line note */
  note: string | null
  /** a routine's live steps that are on that day (its subtasks, nested), each ticked for the day or not */
  steps: HabitStep[]
}

/** A step of a habit on one day; `steps` are its own (a group of exercises under "Upper body"). */
export interface HabitStep {
  id: string
  title: string
  done: boolean
  /** logged count — reaches `target` when done ("3 sets") */
  value: number
  target: number
  unit: string | null
  /** its own weekdays; null = its parent's */
  days: number | null
  steps: HabitStep[]
}

export type TaskBucket = 'today' | 'upcoming' | 'no_date' | 'completed' | 'snoozed'

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
  show_streaks: boolean
  backup_enabled: boolean
  /** ISO weekday, 1 = Monday … 7 = Sunday */
  backup_weekday: number
}
