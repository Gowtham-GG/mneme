import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { tasksOnDay } from '@/api/calendar'
import { inboxCount, listNotes, recentViewed } from '@/api/notes'
import { addStandaloneTask, listTasks, setTaskDone } from '@/api/tasks'
import { Calendar } from '@/components/Calendar'
import { Card } from '@/components/Card'
import { IconSearch } from '@/components/icons'
import { NoteRow } from '@/components/NoteRow'
import { QuickCapture } from '@/components/QuickCapture'
import { useSettings } from '@/contexts/SettingsContext'
import { useToast } from '@/contexts/ToastContext'
import { useOpenJournal } from '@/hooks/useOpenJournal'
import { addDays, formatDayHeading, formatFullDate, formatTimeOfDay, startOfDayISO, taskDueStatus, todayKey } from '@/lib/dates'
import { displayTitle } from '@/lib/text'

/** Everything due on one day: timed items first as a schedule, then all-day tasks, plus a quick add. */
function DayAgenda({ day, tz, onToggle }: { day: string; tz: string; onToggle: (id: string, title: string, done: boolean) => void }) {
  const { toast } = useToast()
  const qc = useQueryClient()
  const [title, setTitle] = useState('')
  const [time, setTime] = useState('')
  const [busy, setBusy] = useState(false)
  const items = useQuery({ queryKey: ['tasks', 'day', day], queryFn: () => tasksOnDay(day) })
  const openJournal = useOpenJournal()

  const add = async (e: FormEvent) => {
    e.preventDefault()
    if (!title.trim() || busy) return
    setBusy(true)
    try {
      await addStandaloneTask(title, day, time || null)
      setTitle(''); setTime('')
      void qc.invalidateQueries({ queryKey: ['tasks'] }); void qc.invalidateQueries({ queryKey: ['notes'] })
    } catch { toast('Couldn’t add that.', { kind: 'error' }) } finally { setBusy(false) }
  }

  const list = items.data ?? []
  return (
    <div className="mt-4 border-t border-line pt-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{formatDayHeading(day, tz)}</h3>
        {day <= todayKey(tz) && (
          <button onClick={() => void openJournal(day)} className="rounded-full bg-accent-soft px-3 py-1 text-xs font-medium text-accent hover:opacity-80">
            <span aria-hidden>✎ </span>Journal
          </button>
        )}
      </div>
      {items.isLoading && <div className="skeleton h-9" />}
      {!items.isLoading && list.length === 0 && <p className="text-sm text-faint">Nothing scheduled.</p>}
      <ul className="-mx-2">
        {list.map((t) => {
          const done = t.status === 'done'
          const overdue = !done && taskDueStatus(t.due_date, t.due_time, tz) === 'overdue'
          return (
            <li key={t.id} className="flex items-start gap-3 rounded-lg px-2 py-1.5 hover:bg-hover">
              <input type="checkbox" checked={done} aria-label={`${done ? 'Reopen' : 'Complete'}: ${t.title}`} className="mt-1 size-4 accent-[var(--accent)]" onChange={() => onToggle(t.id, t.title, !done)} />
              <span className={`w-14 shrink-0 pt-0.5 text-xs tabular-nums ${t.due_time ? (overdue ? 'text-danger' : 'text-important') : 'text-faint'}`}>
                {t.due_time ? formatTimeOfDay(t.due_time) : 'All day'}
              </span>
              <span className={`min-w-0 flex-1 text-sm ${done ? 'text-faint line-through' : ''}`}>
                {t.title}
                {t.note_public_id && <Link to={`/n/${t.note_public_id}`} className="ml-2 text-xs tabular-nums text-faint">{t.note_public_id}</Link>}
              </span>
            </li>
          )
        })}
      </ul>
      <form onSubmit={(e) => void add(e)} className="mt-2 flex flex-wrap gap-2">
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a task or appointment…" aria-label={`Add a task or appointment on ${formatFullDate(day)}`}
          className="min-w-0 basis-full rounded-lg border border-line bg-bg px-2.5 py-1.5 text-sm" />
        <input type="time" value={time} onChange={(e) => setTime(e.target.value)} aria-label="Time (optional)" title="Time (optional)"
          className="min-w-0 flex-1 rounded-lg border border-line bg-bg px-2 py-1.5 text-sm" />
        <button type="submit" disabled={!title.trim() || busy} className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-on-accent disabled:opacity-50">Add</button>
      </form>
    </div>
  )
}

export function Home() {
  const { timezone: tz } = useSettings()
  const { toast } = useToast()
  const qc = useQueryClient()
  const day = todayKey(tz)
  const [picked, setPicked] = useState<string | null>(null)
  const selected = picked ?? day
  const isToday = selected === day

  const today = useQuery({
    queryKey: ['notes', 'home-day', selected, tz],
    queryFn: () => listNotes({ from: startOfDayISO(selected, tz), to: startOfDayISO(addDays(selected, 1), tz), state: 'all', limit: 50 }),
  })
  const tasks = useQuery({ queryKey: ['tasks', 'home'], queryFn: () => listTasks('today', 5) })
  const starred = useQuery({ queryKey: ['notes', 'home-starred'], queryFn: () => listNotes({ starred: true, state: 'all', order: 'updated', limit: 6 }) })
  const recent = useQuery({ queryKey: ['recent-viewed'], queryFn: () => recentViewed(6) })
  const inbox = useQuery({ queryKey: ['inbox-count'], queryFn: inboxCount, staleTime: 30_000 })

  // a page in a notebook reads top → bottom, oldest first
  const stream = [...(today.data ?? [])].reverse()

  const tick = async (id: string, title: string, done = true) => {
    try {
      await setTaskDone(id, done)
      void qc.invalidateQueries({ queryKey: ['tasks'] }); void qc.invalidateQueries({ queryKey: ['notes'] })
      if (done) toast(`Done: ${title}`, { action: { label: 'Undo', onClick: () => void setTaskDone(id, false).then(() => { void qc.invalidateQueries({ queryKey: ['tasks'] }); void qc.invalidateQueries({ queryKey: ['notes'] }) }) } })
    } catch { toast('Couldn’t update the task.', { kind: 'error' }) }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="page-top mx-auto max-w-5xl px-4 pb-32 lg:px-6 lg:pb-8">
        <Link to="/search" className="glass mb-5 flex items-center gap-2.5 rounded-xl px-4 py-3 text-sm text-faint no-underline hover:no-underline md:hidden"><IconSearch size={17} /> Search your notes</Link>

        <header className="rise mb-5">
          <p className="label-caps">{formatFullDate(day)}</p>
          <h1 className="mt-1 text-[34px] font-bold leading-tight">Today</h1>
        </header>

        <QuickCapture />
        <p className="mb-6 mt-3 text-center text-xs text-faint">Just write. <code>#tag</code> · <code>[[link]]</code> · <code>- [ ] task</code></p>

        <div className="grid gap-4 lg:grid-cols-3">
          <Card title="Calendar" className="rise min-w-0 lg:col-start-3 lg:row-start-1">
            <Calendar today={day} selected={selected} onSelect={(k) => setPicked(k === day ? null : k)} />
            <DayAgenda day={selected} tz={tz} onToggle={(id, title, done) => void tick(id, title, done)} />
          </Card>

          <Card
            title={isToday ? 'Written today' : `Written on ${formatFullDate(selected)}`}
            aside={<>{stream.length ? `${stream.length} note${stream.length === 1 ? '' : 's'}` : null}{!isToday && <button className="ml-3 text-accent" onClick={() => setPicked(null)}>Back to today</button>}</>}
            className="rise min-w-0 lg:col-span-2 lg:row-span-2 lg:row-start-1 lg:self-start" pad={false}
          >
            <div className="px-2 pb-3">
              {today.isLoading && <div className="space-y-2 p-3"><div className="skeleton h-14" /><div className="skeleton h-14 opacity-60" /></div>}
              {!today.isLoading && stream.length === 0 && <p className="px-3 py-4 text-sm text-faint">{isToday ? 'Nothing written today yet.' : 'Nothing written on this day.'}</p>}
              {stream.map((n) => <NoteRow key={n.id} note={n} tz={tz} />)}
            </div>
          </Card>

          <div className="min-w-0 space-y-4 lg:col-start-3">
            {!!tasks.data?.length && (
              <Card title="Tasks due" aside={<Link to="/tasks">All →</Link>} className="rise">
                <ul className="-mx-2">
                  {tasks.data.map((t) => (
                    <li key={t.id} className="flex items-start gap-3 rounded-lg px-2 py-2 hover:bg-hover">
                      <input type="checkbox" aria-label={`Complete: ${t.title}`} className="mt-1 size-4 accent-[var(--accent)]" onChange={() => void tick(t.id, t.title)} />
                      <span className="min-w-0 flex-1 text-sm">{t.title}{t.note_public_id && <Link to={`/n/${t.note_public_id}`} className="ml-2 text-xs tabular-nums text-faint">{t.note_public_id}</Link>}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
            {!!starred.data?.length && (
              <Card title="Starred" className="rise">
                <div className="flex flex-wrap gap-2">
                  {starred.data.map((n) => <Link key={n.id} to={`/n/${n.public_id}`} className="max-w-full truncate rounded-full border border-line px-3.5 py-1.5 text-sm text-ink no-underline hover:bg-hover hover:no-underline">★ {displayTitle(n)}</Link>)}
                </div>
              </Card>
            )}
            {!!recent.data?.length && (
              <Card title="Recently opened" className="rise">
                <div className="flex flex-wrap gap-2">
                  {recent.data.map((n) => <Link key={n.id} to={`/n/${n.public_id}`} className="max-w-full truncate rounded-full bg-panel px-3.5 py-1.5 text-sm text-ink no-underline hover:bg-hover hover:no-underline">{displayTitle(n)}</Link>)}
                </div>
              </Card>
            )}
            {!!inbox.data && <Link to="/inbox" className="glass block rounded-2xl px-5 py-4 text-sm text-muted no-underline hover:no-underline hover:text-ink"><span className="label-caps block">Inbox</span><span className="mt-1 block text-base font-medium text-ink">{inbox.data} to process →</span></Link>}
          </div>
        </div>
      </div>
    </div>
  )
}
