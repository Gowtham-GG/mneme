import { useState } from 'react'
import { formatDueDate, formatTimeOfDay, taskDueStatus } from '@/lib/dates'
import { DueDialog } from '@/components/DueDialog'
import type { TaskItem, TaskPriority } from '@/types/db'
import { IconCalendar } from '@/components/icons'

export const PRIORITIES: { id: TaskPriority | null; label: string }[] = [
  { id: null, label: 'None' }, { id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' },
]

/** Due date/time chip; opens the calendar + clock picker (saved on OK). `compact` shows just an icon while there is no date. */
export function DuePicker({ task, tz, onChange, compact, disabled }: {
  task: Pick<TaskItem, 'due_date' | 'due_time'>; tz: string; onChange: (d: string | null, t: string | null) => void; compact?: boolean; disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const status = taskDueStatus(task.due_date, task.due_time, tz)
  const label = task.due_date
    ? `${status === 'overdue' ? 'Overdue · ' : ''}${formatDueDate(task.due_date, tz)}${task.due_time ? ` · ${formatTimeOfDay(task.due_time)}` : ''}`
    : 'Add date'
  return (
    <>
      <button
        type="button" disabled={disabled}
        className={`rounded px-1.5 py-0.5 text-xs disabled:opacity-50 ${task.due_date ? (status === 'overdue' ? 'bg-danger-soft text-danger' : 'bg-task-soft text-task') : 'text-faint hover:bg-hover'}`}
        aria-haspopup="dialog" aria-label={!task.due_date && compact ? 'Add date' : `Due: ${label}`} onClick={() => setOpen(true)}
      >
        {!task.due_date && compact ? <IconCalendar size={15} /> : label}
      </button>
      <DueDialog open={open} date={task.due_date} time={task.due_time} tz={tz} onClose={() => setOpen(false)}
        onOk={(d, t) => { if (d !== task.due_date || t !== task.due_time) onChange(d, t) }} />
    </>
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
