import { useState } from 'react'
import { addDays, formatDueDate, formatTimeOfDay, taskDueStatus, todayKey } from '@/lib/dates'
import type { TaskItem, TaskPriority } from '@/types/db'
import { IconCalendar } from '@/components/icons'

export const PRIORITIES: { id: TaskPriority | null; label: string }[] = [
  { id: null, label: 'None' }, { id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' },
]

/** Due date/time chip + menu. `compact` shows just an icon while there is no date. */
export function DuePicker({ task, tz, onChange, compact }: { task: Pick<TaskItem, 'due_date' | 'due_time'>; tz: string; onChange: (d: string | null, t: string | null) => void; compact?: boolean }) {
  const [open, setOpen] = useState(false)
  const today = todayKey(tz)
  const status = taskDueStatus(task.due_date, task.due_time, tz)
  const set = (d: string | null, t: string | null = null) => { setOpen(false); onChange(d, t) }
  const label = task.due_date
    ? `${status === 'overdue' ? 'Overdue · ' : ''}${formatDueDate(task.due_date, tz)}${task.due_time ? ` · ${formatTimeOfDay(task.due_time)}` : ''}`
    : 'Add date'
  return (
    <div className="relative">
      <button
        className={`rounded px-1.5 py-0.5 text-xs ${task.due_date ? (status === 'overdue' ? 'bg-danger-soft text-danger' : 'bg-task-soft text-task') : 'text-faint hover:bg-hover'}`}
        aria-haspopup="menu" aria-expanded={open} aria-label={!task.due_date && compact ? 'Add date' : undefined} onClick={() => setOpen((v) => !v)}
      >
        {!task.due_date && compact ? <IconCalendar size={15} /> : label}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div role="menu" className="pop absolute right-0 z-30 mt-1 w-48 glass-strong rounded-xl p-1">
            {([['Today', today], ['Tomorrow', addDays(today, 1)], ['Next week', addDays(today, 7)]] as const).map(([l, d]) => (
              <button key={l} role="menuitem" className="block w-full rounded px-3 py-1.5 text-left text-sm hover:bg-hover" onClick={() => set(d, task.due_time)}>{l}</button>
            ))}
            <label className="block px-3 py-1.5 text-sm">Date
              <input type="date" defaultValue={task.due_date ?? ''} className="mt-1 w-full rounded border border-line bg-bg px-1.5 py-1 text-sm" onChange={(e) => e.target.value && set(e.target.value, task.due_time)} />
            </label>
            <label className="block px-3 py-1.5 text-sm">Time <span className="text-faint">(optional)</span>
              <input type="time" defaultValue={task.due_time ?? ''} disabled={!task.due_date} className="mt-1 w-full rounded border border-line bg-bg px-1.5 py-1 text-sm disabled:opacity-50" onChange={(e) => set(task.due_date, e.target.value || null)} />
            </label>
            {task.due_date && <button role="menuitem" className="block w-full rounded px-3 py-1.5 text-left text-sm text-muted hover:bg-hover" onClick={() => set(null, null)}>No date</button>}
          </div>
        </>
      )}
    </div>
  )
}

export function PriorityPicker({ priority, onChange }: { priority: TaskPriority | null; onChange: (p: TaskPriority | null) => void }) {
  const [open, setOpen] = useState(false)
  const tone = priority === 'high' ? 'bg-danger-soft text-danger' : priority === 'medium' ? 'bg-important-soft text-important' : priority === 'low' ? 'bg-panel text-muted' : 'text-faint hover:bg-hover'
  return (
    <div className="relative">
      <button className={`rounded px-1.5 py-0.5 text-xs ${tone}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {priority ? PRIORITIES.find((p) => p.id === priority)?.label : '⚑'}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div role="menu" className="pop absolute right-0 z-30 mt-1 w-32 glass-strong rounded-xl p-1">
            {PRIORITIES.map((p) => (
              <button key={p.label} role="menuitem" className="block w-full rounded px-3 py-1.5 text-left text-sm hover:bg-hover" onClick={() => { setOpen(false); onChange(p.id) }}>{p.label}</button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
