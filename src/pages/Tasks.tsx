import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { addStandaloneTask, clearCompletedTasks, deleteTask, listTasks, searchTasks, setTaskDone, updateTask } from '@/api/tasks'
import { ConfirmDialog } from '@/components/Dialog'
import { useDebounced } from '@/hooks/useDebounced'
import { useSettings } from '@/contexts/SettingsContext'
import { useToast } from '@/contexts/ToastContext'
import { addDays, formatDueDate, formatTimeOfDay, taskDueStatus, todayKey } from '@/lib/dates'
import { Card } from '@/components/Card'
import type { TaskItem, TaskBucket, TaskPriority } from '@/types/db'
import { IconSearch, IconX } from '@/components/icons'

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
      <button
        aria-label={`Delete task: ${t.title}`} title={t.source === 'note' ? 'Delete (removes the line from its note)' : 'Delete'}
        className="rounded p-1 text-faint hover:bg-hover hover:text-danger focus:opacity-100 lg:opacity-0 lg:group-hover:opacity-100" onClick={() => onDelete(t)}
      ><IconX size={16} /></button>
    </li>
  )
}

type Handlers = {
  onTick: (t: TaskItem, done: boolean) => void
  onDue: (t: TaskItem, d: string | null, time: string | null) => void
  onPriority: (t: TaskItem, p: TaskPriority | null) => void
  onDelete: (t: TaskItem) => void
}

function TaskList({ items, tz, empty, ...h }: { items: TaskItem[] | undefined; tz: string; empty: string } & Handlers) {
  if (!items) return <div className="skeleton h-10" />
  if (!items.length) return <p className="px-2 py-3 text-sm text-faint">{empty}</p>
  return <ul className="-mx-2">{items.map((t) => <TaskRow key={t.id} t={t} tz={tz} {...h} />)}</ul>
}

const TABS: { id: TaskBucket; label: string; empty: string }[] = [
  { id: 'today', label: 'Today', empty: 'Nothing due. 🎉' },
  { id: 'upcoming', label: 'Upcoming', empty: 'Nothing scheduled.' },
  { id: 'no_date', label: 'No date', empty: 'Nothing here.' },
  { id: 'completed', label: 'Done', empty: 'Nothing completed yet.' },
]

export function Tasks() {
  const { timezone: tz } = useSettings()
  const { toast } = useToast()
  const qc = useQueryClient()
  const [sp, setSp] = useSearchParams()
  const tab = (TABS.find((t) => t.id === sp.get('tab'))?.id ?? 'today') as TaskBucket
  const [title, setTitle] = useState('')
  const [query, setQuery] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)
  const dq = useDebounced(query.trim(), 200)
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['tasks'] }); void qc.invalidateQueries({ queryKey: ['notes'] }); void qc.invalidateQueries({ queryKey: ['note-context'] }) }

  // all four buckets up front: the tab counts come from them
  const results = useQueries({ queries: TABS.map((t) => ({ queryKey: ['tasks', t.id], queryFn: () => listTasks(t.id) })) })
  const lists = Object.fromEntries(TABS.map((t, i) => [t.id, results[i]])) as Record<TaskBucket, (typeof results)[number]>
  const found = useQuery({ queryKey: ['tasks', 'search', dq], queryFn: () => searchTasks(dq), enabled: !!dq })
  const today = todayKey(tz)
  const overdueCount = (lists.today.data ?? []).filter((t) => t.due_date! < today).length

  const add = async () => {
    const t = title.trim()
    if (!t) return
    try { await addStandaloneTask(t, tab === 'today' ? today : null); setTitle(''); refresh() } catch { toast('Couldn’t add the task.', { kind: 'error' }) }
  }
  const tick = async (t: TaskItem, done: boolean) => {
    try {
      await setTaskDone(t.id, done); refresh()
      if (done) toast(`Done: ${t.title}`, { action: { label: 'Undo', onClick: () => void setTaskDone(t.id, false).then(refresh) } })
    } catch { toast('Couldn’t update the task.', { kind: 'error' }) }
  }
  const due = async (t: TaskItem, d: string | null, time: string | null) => { try { await updateTask(t.id, { due_date: d, due_time: d ? time : null }); refresh() } catch { toast('Couldn’t set the date.', { kind: 'error' }) } }
  const priority = async (t: TaskItem, p: TaskPriority | null) => { try { await updateTask(t.id, { priority: p }); refresh() } catch { toast('Couldn’t set the priority.', { kind: 'error' }) } }
  const del = async (t: TaskItem) => {
    try {
      await deleteTask(t.id); refresh()
      toast(t.note_public_id ? `Deleted · line removed from ${t.note_public_id}` : 'Deleted')
    } catch { toast('Couldn’t delete the task.', { kind: 'error' }) }
  }
  const clearDone = async () => {
    setConfirmClear(false)
    try { const n = await clearCompletedTasks(); refresh(); toast(`Cleared ${n} task${n === 1 ? '' : 's'}`) } catch { toast('Couldn’t clear completed tasks.', { kind: 'error' }) }
  }
  const h: Handlers = { onTick: tick, onDue: due, onPriority: priority, onDelete: del }
  const current = TABS.find((t) => t.id === tab)!

  return (
    <div className="h-full overflow-y-auto">
      <div className="page-top mx-auto max-w-3xl px-4 pb-32 lg:px-6 lg:pb-8">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-[28px] font-semibold leading-tight">Tasks</h1>
          <label className="glass flex min-w-0 flex-1 basis-56 items-center gap-2 rounded-xl px-3 py-2 sm:max-w-xs">
            <IconSearch size={16} className="shrink-0 text-faint" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search tasks" aria-label="Search tasks"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none" />
            {query && <button type="button" aria-label="Clear search" onClick={() => setQuery('')} className="text-faint hover:text-ink"><IconX size={14} /></button>}
          </label>
        </div>

        <form className="mb-4 flex gap-2" onSubmit={(e) => { e.preventDefault(); void add() }}>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={tab === 'today' ? 'Add a task for today…' : 'Add a task…'} aria-label="New task" maxLength={500}
            className="glass min-w-0 flex-1 rounded-2xl px-4 py-3 outline-none" />
          <button disabled={!title.trim()} className="rounded-2xl bg-accent px-5 py-2 text-sm font-medium text-on-accent disabled:opacity-50">Add</button>
        </form>

        {dq ? (
          <Card className="rise relative focus-within:z-20" title={<>Results <span className="ml-1 normal-case tracking-normal text-faint">{found.data?.length ?? ''}</span></>}>
            <TaskList items={found.data} tz={tz} empty="No matching tasks." {...h} />
          </Card>
        ) : (
          <>
            <div role="tablist" aria-label="Task lists" className="mb-3 flex gap-1 overflow-x-auto [scrollbar-width:none]">
              {TABS.map((t) => {
                const n = lists[t.id].data?.length
                const on = t.id === tab
                return (
                  <button key={t.id} role="tab" aria-selected={on} onClick={() => setSp(t.id === 'today' ? {} : { tab: t.id }, { replace: true })}
                    className={`flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm ${on ? 'bg-accent font-medium text-on-accent' : 'text-muted hover:bg-hover hover:text-ink'}`}>
                    {t.label}
                    {!!n && <span className={`text-xs tabular-nums ${on ? '' : 'text-faint'}`}>{n}</span>}
                    {t.id === 'today' && overdueCount > 0 && <span className={`rounded-full px-1.5 text-[11px] tabular-nums ${on ? 'bg-on-accent/20' : 'bg-danger-soft text-danger'}`} title="Overdue">{overdueCount}!</span>}
                  </button>
                )
              })}
            </div>
            <Card className="rise relative focus-within:z-20"
              aside={tab === 'completed' && !!lists.completed.data?.length
                ? <button className="text-danger hover:underline" onClick={() => setConfirmClear(true)}>Clear all</button> : undefined}>
              <TaskList items={lists[tab].data} tz={tz} empty={current.empty} {...h} />
            </Card>
          </>
        )}
      </div>
      <ConfirmDialog open={confirmClear} title="Clear all completed tasks?" danger confirmLabel="Clear all" onClose={() => setConfirmClear(false)}
        body="Completed tasks are deleted. Ones written in notes also have their line removed from the note (the note’s History keeps the old text)."
        onConfirm={() => void clearDone()} />
    </div>
  )
}
