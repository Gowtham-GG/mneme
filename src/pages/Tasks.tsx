import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { addStandaloneTask, clearCompletedTasks, findTask, listTasks, searchTasks } from '@/api/tasks'
import { ConfirmDialog } from '@/components/Dialog'
import { useDebounced } from '@/hooks/useDebounced'
import { useSettings } from '@/contexts/SettingsContext'
import { useToast } from '@/contexts/ToastContext'
import { formatDueDate, formatTimeOfDay, todayKey } from '@/lib/dates'
import { Card } from '@/components/Card'
import { TaskNode } from '@/components/tasks/TaskNode'
import { TaskUiProvider, useTaskUi } from '@/components/tasks/TaskUi'
import { ViewToggle } from '@/components/tasks/ViewToggle'
import type { TaskItem, TaskBucket } from '@/types/db'
import { IconCalendar, IconSearch, IconSnooze, IconX } from '@/components/icons'
import { DueDialog } from '@/components/DueDialog'

function TaskList({ items, empty }: { items: TaskItem[] | undefined; empty: string }) {
  if (!items) return <div className="skeleton h-10" />
  if (!items.length) return <p className="px-2 py-3 text-sm text-faint">{empty}</p>
  return <ul className="-mx-2">{items.map((t) => <TaskNode key={t.id} t={t} />)}</ul>
}

/** /tasks?task=T-1A2B3C4D (a [[T-…]] link in a note) opens that task's whole tree. */
function TaskDeepLink() {
  const [sp, setSp] = useSearchParams()
  const ui = useTaskUi()
  const { toast } = useToast()
  const code = sp.get('task')
  useEffect(() => {
    if (!code) return
    const next = new URLSearchParams(sp)
    next.delete('task')
    setSp(next, { replace: true })
    findTask(code).then((f) => (f ? ui.openTree(f.root_id, f.id) : toast('That task is gone.', { kind: 'error' })), () => toast('Couldn’t open the task.', { kind: 'error' }))
  }, [code]) // eslint-disable-line react-hooks/exhaustive-deps
  return null
}

const TABS: { id: TaskBucket; label: string; empty: string }[] = [
  { id: 'today', label: 'Today', empty: 'Nothing due.' },
  { id: 'upcoming', label: 'Upcoming', empty: 'Nothing scheduled.' },
  { id: 'no_date', label: 'No date', empty: 'Nothing here.' },
  { id: 'completed', label: 'Done', empty: 'Nothing completed yet.' },
  { id: 'snoozed', label: 'Snoozed', empty: 'Nothing snoozed.' },
]

export function Tasks() {
  const { timezone: tz } = useSettings()
  const { toast } = useToast()
  const qc = useQueryClient()
  const [sp, setSp] = useSearchParams()
  const tab = (TABS.find((t) => t.id === sp.get('tab'))?.id ?? 'today') as TaskBucket
  const [title, setTitle] = useState('')
  // a due date/time picked for the task being typed (typed words like "tomorrow 3pm" still work too)
  const [due, setDue] = useState<{ date: string; time: string | null } | null>(null)
  const [picking, setPicking] = useState(false)
  const [query, setQuery] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)
  const dq = useDebounced(query.trim(), 200)
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['tasks'] }); void qc.invalidateQueries({ queryKey: ['notes'] }); void qc.invalidateQueries({ queryKey: ['note-context'] }); void qc.invalidateQueries({ queryKey: ['due-task-count'] }) }

  // all four buckets up front: the tab counts come from them
  const results = useQueries({ queries: TABS.map((t) => ({ queryKey: ['tasks', t.id], queryFn: () => listTasks(t.id) })) })
  const lists = Object.fromEntries(TABS.map((t, i) => [t.id, results[i]])) as Record<TaskBucket, (typeof results)[number]>
  const found = useQuery({ queryKey: ['tasks', 'search', dq], queryFn: () => searchTasks(dq), enabled: !!dq })
  const today = todayKey(tz)
  const overdueCount = (lists.today.data ?? []).filter((t) => t.due_date! < today).length

  const add = async () => {
    const t = title.trim()
    if (!t) return
    try {
      const made = await addStandaloneTask(t, due?.date ?? (tab === 'today' ? today : null), due?.time ?? null)
      setTitle(''); setDue(null); refresh()
      // say when it's due if that isn't obvious from the list it lands in
      if (made.due_date && (made.title !== t || due)) toast(`Added “${made.title}” · ${formatDueDate(made.due_date, tz)}${made.due_time ? ` · ${formatTimeOfDay(made.due_time)}` : ''}`)
    } catch { toast('Couldn’t add the task.', { kind: 'error' }) }
  }
  const clearDone = async () => {
    setConfirmClear(false)
    try { const n = await clearCompletedTasks(); refresh(); toast(`Cleared ${n} task${n === 1 ? '' : 's'}`) } catch { toast('Couldn’t clear completed tasks.', { kind: 'error' }) }
  }
  const current = TABS.find((t) => t.id === tab)!

  return (
    <TaskUiProvider>
    <TaskDeepLink />
    <div className="h-full overflow-y-auto">
      <div className="page-top mx-auto max-w-3xl px-4 pb-32 lg:px-6 lg:pb-8">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h1 className="text-[28px] font-semibold leading-tight">Tasks<span className="text-accent">.</span></h1>
            <ViewToggle />
          </div>
          <label className="glass flex min-w-0 flex-1 basis-56 items-center gap-2 rounded-xl px-3 py-2 sm:max-w-xs">
            <IconSearch size={16} className="shrink-0 text-faint" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search tasks" aria-label="Search tasks"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none" />
            {query && <button type="button" aria-label="Clear search" onClick={() => setQuery('')} className="text-faint hover:text-ink"><IconX size={14} /></button>}
          </label>
        </div>

        <form className="mb-4 flex gap-2" onSubmit={(e) => { e.preventDefault(); void add() }}>
          <div className="glass flex min-w-0 flex-1 items-center gap-1 rounded-2xl pr-1.5">
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={tab === 'today' ? 'Add a task for today…' : 'Add a task… (“call bank tomorrow 3pm”)'} aria-label="New task" maxLength={500}
              className="min-w-0 flex-1 bg-transparent py-3 pl-4 outline-none" />
            {due ? (
              <span className="flex shrink-0 items-center gap-0.5 rounded-lg bg-task-soft py-1 pl-2 pr-1 text-xs text-task">
                <button type="button" aria-label="Change the due date" onClick={() => setPicking(true)}>
                  {formatDueDate(due.date, tz)}{due.time ? ` · ${formatTimeOfDay(due.time)}` : ''}
                </button>
                <button type="button" aria-label="Remove the due date" className="rounded p-0.5 hover:bg-hover" onClick={() => setDue(null)}><IconX size={12} /></button>
              </span>
            ) : (
              <button type="button" aria-label="Pick a due date and time" title="Due date and time" onClick={() => setPicking(true)}
                className="shrink-0 rounded-lg p-2 text-faint hover:bg-hover hover:text-ink"><IconCalendar size={18} /></button>
            )}
          </div>
          <button disabled={!title.trim()} className="rounded-2xl bg-accent px-5 py-2 text-sm font-medium text-on-accent disabled:opacity-50">Add</button>
        </form>
        <DueDialog open={picking} date={due?.date ?? (tab === 'today' ? today : null)} time={due?.time ?? null} tz={tz}
          onClose={() => setPicking(false)} onOk={(d, t) => setDue(d ? { date: d, time: t } : null)} />

        {dq ? (
          <Card className="rise relative focus-within:z-20" title={<>Results <span className="ml-1 normal-case tracking-normal text-faint">{found.data?.length ?? ''}</span></>}>
            <TaskList items={found.data} empty="No matching tasks." />
          </Card>
        ) : (
          <>
            <div role="tablist" aria-label="Task lists" className="mb-3 flex gap-1 overflow-x-auto [scrollbar-width:none]">
              {TABS.map((t) => {
                const n = lists[t.id].data?.length
                const on = t.id === tab
                if (t.id === 'snoozed' && !n && !on) return null
                return (
                  <button key={t.id} role="tab" aria-selected={on} onClick={() => setSp(t.id === 'today' ? {} : { tab: t.id }, { replace: true })}
                    className={`flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm ${on ? 'bg-accent font-medium text-on-accent' : 'text-muted hover:bg-hover hover:text-ink'}`}>
                    {t.id === 'snoozed' && <IconSnooze size={15} />}{t.label}
                    {!!n && <span className={`text-xs tabular-nums ${on ? '' : 'text-faint'}`}>{n}</span>}
                    {t.id === 'today' && overdueCount > 0 && <span className={`rounded-full px-1.5 text-[11px] tabular-nums ${on ? 'bg-on-accent/20' : 'bg-danger-soft text-danger'}`} title="Overdue">{overdueCount}!</span>}
                  </button>
                )
              })}
            </div>
            <Card className="rise relative focus-within:z-20"
              aside={tab === 'completed' && !!lists.completed.data?.length
                ? <button className="text-danger hover:underline" onClick={() => setConfirmClear(true)}>Clear all</button> : undefined}>
              <TaskList items={lists[tab].data} empty={current.empty} />
            </Card>
          </>
        )}
      </div>
      <ConfirmDialog open={confirmClear} title="Clear all completed tasks?" danger confirmLabel="Clear all" onClose={() => setConfirmClear(false)}
        body="Finished main tasks are deleted with their subtasks. Ones written in notes also have their line removed from the note (the note’s History keeps the old text)."
        onConfirm={() => void clearDone()} />
    </div>
    </TaskUiProvider>
  )
}
