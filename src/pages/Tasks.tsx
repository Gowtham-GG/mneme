import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { addStandaloneTask, deleteStandaloneTask, listTasks, setTaskDone, updateTask } from '@/api/tasks'
import { useSettings } from '@/contexts/SettingsContext'
import { useToast } from '@/contexts/ToastContext'
import { addDays, formatDueDate, formatTimeOfDay, taskDueStatus, todayKey } from '@/lib/dates'
import { Card } from '@/components/Card'
import type { TaskItem, TaskBucket, TaskPriority } from '@/types/db'
import { IconX } from '@/components/icons'

const PRIORITIES: { id: TaskPriority | null; label: string }[] = [
  { id: null, label: 'None' }, { id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' },
]

function DuePicker({ task, tz, onChange }: { task: TaskItem; tz: string; onChange: (d: string | null, t: string | null) => void }) {
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
        aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}
      >
        {label}
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

function PriorityPicker({ priority, onChange }: { priority: TaskPriority | null; onChange: (p: TaskPriority | null) => void }) {
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

function TaskRow({ t, tz, onTick, onDue, onPriority, onDelete }: {
  t: TaskItem; tz: string
  onTick: (t: TaskItem, done: boolean) => void
  onDue: (t: TaskItem, d: string | null, time: string | null) => void
  onPriority: (t: TaskItem, p: TaskPriority | null) => void
  onDelete: (t: TaskItem) => void
}) {
  const done = t.status === 'done'
  return (
    <li className="group flex items-start gap-3 rounded-lg px-2 py-2 hover:bg-hover">
      <input type="checkbox" checked={done} aria-label={`${done ? 'Reopen' : 'Complete'}: ${t.title}`} onChange={(e) => onTick(t, e.target.checked)} className="mt-1 size-4 accent-[var(--accent)]" />
      <div className="min-w-0 flex-1">
        <div className={`text-[15px] ${done ? 'text-faint line-through' : ''}`}>{t.title}</div>
        {t.note_public_id && (
          <Link to={`/n/${t.note_public_id}`} className="text-xs text-faint no-underline hover:text-accent">
            <span className="tabular-nums">{t.note_public_id}</span>{t.note_title ? ` · ${t.note_title}` : ''}
          </Link>
        )}
      </div>
      {!done && <PriorityPicker priority={t.priority} onChange={(p) => onPriority(t, p)} />}
      {!done && <DuePicker task={t} tz={tz} onChange={(d, time) => onDue(t, d, time)} />}
      {t.source === 'standalone' && (
        <button aria-label={`Delete task: ${t.title}`} className="rounded p-1 text-faint opacity-0 hover:bg-hover hover:text-danger focus:opacity-100 group-hover:opacity-100" onClick={() => onDelete(t)}><IconX size={16} /></button>
      )}
    </li>
  )
}

function Section({ title, bucket, tz, defaultOpen = true, tone, onTick, onDue, onPriority, onDelete }: {
  title: string; bucket: TaskBucket; tz: string; defaultOpen?: boolean; tone?: string
  onTick: (t: TaskItem, done: boolean) => void
  onDue: (t: TaskItem, d: string | null, time: string | null) => void
  onPriority: (t: TaskItem, p: TaskPriority | null) => void
  onDelete: (t: TaskItem) => void
}) {
  const [open, setOpen] = useState(defaultOpen)
  const q = useQuery({ queryKey: ['tasks', bucket], queryFn: () => listTasks(bucket), enabled: open })
  return (
    <Card className="rise relative mb-4 focus-within:z-20" title={<span className={tone}>{title}{q.data ? <span className="ml-2 text-faint normal-case tracking-normal">{q.data.length}</span> : null}</span>}
      aside={<button className="hover:text-ink" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{open ? 'Hide' : 'Show'}</button>}>
      {open && (
        q.isLoading ? <p className="px-2 text-sm text-faint">Loading…</p>
        : q.isError ? <p className="px-2 text-sm text-danger">Couldn’t load tasks.</p>
        : !q.data?.length ? <p className="px-2 text-sm text-faint">Nothing here.</p>
        : <ul className="-mx-2">{q.data.map((t) => <TaskRow key={t.id} t={t} tz={tz} onTick={onTick} onDue={onDue} onPriority={onPriority} onDelete={onDelete} />)}</ul>
      )}
    </Card>
  )
}

export function Tasks() {
  const { timezone: tz } = useSettings()
  const { toast } = useToast()
  const qc = useQueryClient()
  const [title, setTitle] = useState('')
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['tasks'] }); void qc.invalidateQueries({ queryKey: ['notes'] }); void qc.invalidateQueries({ queryKey: ['note-context'] }) }

  const add = async () => {
    const t = title.trim()
    if (!t) return
    try { await addStandaloneTask(t); setTitle(''); refresh() } catch { toast('Couldn’t add the task.', { kind: 'error' }) }
  }
  const tick = async (t: TaskItem, done: boolean) => {
    try {
      await setTaskDone(t.id, done); refresh()
      if (done) toast(`Done: ${t.title}`, { action: { label: 'Undo', onClick: () => void setTaskDone(t.id, false).then(refresh) } })
    } catch { toast('Couldn’t update the task.', { kind: 'error' }) }
  }
  const due = async (t: TaskItem, d: string | null, time: string | null) => { try { await updateTask(t.id, { due_date: d, due_time: d ? time : null }); refresh() } catch { toast('Couldn’t set the date.', { kind: 'error' }) } }
  const priority = async (t: TaskItem, p: TaskPriority | null) => { try { await updateTask(t.id, { priority: p }); refresh() } catch { toast('Couldn’t set the priority.', { kind: 'error' }) } }
  const del = async (t: TaskItem) => { try { await deleteStandaloneTask(t.id); refresh() } catch { toast('Couldn’t delete the task.', { kind: 'error' }) } }

  return (
    <div className="h-full overflow-y-auto">
      <div className="page-top mx-auto max-w-3xl px-4 pb-32 lg:px-6 lg:pb-8">
        <h1 className="mb-4 text-[28px] font-semibold leading-tight">Tasks</h1>
        <form className="mb-6 flex gap-2" onSubmit={(e) => { e.preventDefault(); void add() }}>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a task…" aria-label="New task" maxLength={500}
            className="glass min-w-0 flex-1 rounded-2xl px-4 py-3 outline-none" />
          <button disabled={!title.trim()} className="rounded-2xl bg-accent px-5 py-2 text-sm font-medium text-on-accent">Add</button>
        </form>
        <p className="mb-5 text-xs text-faint">Tasks also appear here when you write <code className="rounded bg-panel px-1">- [ ] …</code> inside a note.</p>
        <Section title="Today & overdue" bucket="today" tz={tz} onTick={tick} onDue={due} onPriority={priority} onDelete={del} />
        <Section title="Upcoming" bucket="upcoming" tz={tz} onTick={tick} onDue={due} onPriority={priority} onDelete={del} />
        <Section title="No date" bucket="no_date" tz={tz} onTick={tick} onDue={due} onPriority={priority} onDelete={del} />
        <Section title="Completed" bucket="completed" tz={tz} defaultOpen={false} onTick={tick} onDue={due} onPriority={priority} onDelete={del} />
      </div>
    </div>
  )
}
