import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { tasksOnDay } from '@/api/calendar'
import { inboxCount, listNotes, recentViewed } from '@/api/notes'
import { addStandaloneTask, listTasks, setTaskDone } from '@/api/tasks'
import { Calendar } from '@/components/Calendar'
import { Card } from '@/components/Card'
import { HabitStrip } from '@/components/HabitStrip'
import { IconClock, IconSearch } from '@/components/icons'
import { DueDialog } from '@/components/DueDialog'
import { NoteRow } from '@/components/NoteRow'
import { QuickCapture } from '@/components/QuickCapture'
import { useSettings } from '@/contexts/SettingsContext'
import { useToast } from '@/contexts/ToastContext'
import { useOpenJournal } from '@/hooks/useOpenJournal'
import { addDays, formatDayHeading, formatDueDate, formatFullDate, formatTimeOfDay, startOfDayISO, taskDueStatus, todayKey } from '@/lib/dates'
import { displayTitle } from '@/lib/text'

/** Everything due on one day: timed items first as a schedule, then all-day tasks, plus a quick add. */
function DayAgenda({ day, tz, onToggle }: { day: string; tz: string; onToggle: (id: string, title: string, done: boolean) => void }) {
  const { toast } = useToast()
  const qc = useQueryClient()
  const [title, setTitle] = useState('')
  const [time, setTime] = useState('')
  const [pickTime, setPickTime] = useState(false)
  const [busy, setBusy] = useState(false)
  const isToday = day === todayKey(tz)
  const items = useQuery({ queryKey: ['tasks', 'day', day], queryFn: () => tasksOnDay(day) })
  // on today, carry forward anything still open from earlier days
  const overdue = useQuery({ queryKey: ['tasks', 'today'], queryFn: () => listTasks('today'), enabled: isToday })
  const openJournal = useOpenJournal()

  const add = async (e: FormEvent) => {
    e.preventDefault()
    if (!title.trim() || busy) return
    setBusy(true)
    try {
      const made = await addStandaloneTask(title, day, time || null)
      setTitle(''); setTime('')
      // a date typed into the title was read: say what it became
      if (made.title !== title.trim() && made.due_date) toast(`Added “${made.title}” · ${formatDueDate(made.due_date, tz)}${made.due_time ? ` · ${formatTimeOfDay(made.due_time)}` : ''}`)
      void qc.invalidateQueries({ queryKey: ['tasks'] }); void qc.invalidateQueries({ queryKey: ['notes'] })
    } catch { toast('Couldn’t add that.', { kind: 'error' }) } finally { setBusy(false) }
  }

  const list = [...(isToday ? (overdue.data ?? []).filter((t) => t.due_date! < day) : []), ...(items.data ?? [])]
  return (
    <div>
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
          const late = !done && taskDueStatus(t.due_date, t.due_time, tz) === 'overdue'
          return (
            <li key={t.id} className="flex items-start gap-3 rounded-lg px-2 py-1.5 hover:bg-hover">
              <input type="checkbox" checked={done} aria-label={`${done ? 'Reopen' : 'Complete'}: ${t.title}`} className="mt-1 size-4 accent-[var(--accent)]" onChange={() => onToggle(t.id, t.title, !done)} />
              <span className={`w-14 shrink-0 pt-0.5 text-xs tabular-nums ${late ? 'text-danger' : t.due_time ? 'text-important' : 'text-faint'}`}>
                {t.due_date !== day ? formatDueDate(t.due_date!, tz) : t.due_time ? formatTimeOfDay(t.due_time) : 'All day'}
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
        <button type="button" onClick={() => setPickTime(true)} aria-label={time ? `Time: ${formatTimeOfDay(time)}` : 'Time (optional)'}
          className={`flex min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-line bg-bg px-2 py-1.5 text-left text-sm ${time ? '' : 'text-faint'}`}>
          <IconClock size={15} /> {time ? formatTimeOfDay(time) : 'Time'}
        </button>
        <DueDialog open={pickTime} timeOnly title="Time" date={day} time={time || null} tz={tz}
          onOk={(_, t) => setTime(t ?? '')} onClose={() => setPickTime(false)} />
        <button type="submit" disabled={!title.trim() || busy} className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-on-accent disabled:opacity-50">Add</button>
      </form>
    </div>
  )
}

/** The same day a month and a year back (the 31st → the month's last day; 29 Feb → 28 Feb). */
function sameDayBack(key: string, months: number): string {
  const [y, m, d] = key.split('-').map(Number)
  const first = new Date(Date.UTC(y, m - 1 - months, 1))
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate()
  return `${first.getUTCFullYear()}-${String(first.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`
}

/** Notes and journal pages written a month / a year ago today — quiet, only when there are some. */
function OnThisDay({ day, tz }: { day: string; tz: string }) {
  const backs = [['A year ago', sameDayBack(day, 12)], ['A month ago', sameDayBack(day, 1)]] as const
  const q = useQuery({
    queryKey: ['notes', 'on-this-day', day, tz],
    queryFn: () => Promise.all(backs.map(([, k]) => listNotes({ from: startOfDayISO(k, tz), to: startOfDayISO(addDays(k, 1), tz), state: 'all', limit: 5 }))),
    staleTime: 10 * 60_000,
  })
  if (!q.data?.some((l) => l.length)) return null
  return (
    <Card title="On this day" className="rise">
      <div className="space-y-2">
        {backs.map(([label], i) => !!q.data![i].length && (
          <div key={label} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
            <span className="text-xs text-faint">{label}</span>
            {q.data![i].map((n) => (
              <Link key={n.id} to={`/n/${n.public_id}`} className="max-w-full truncate rounded-full bg-panel px-3 py-1 text-ink no-underline hover:bg-hover hover:no-underline">
                {n.note_type === 'journal' && <span className="text-accent">✎ </span>}{displayTitle(n)}
              </Link>
            ))}
          </div>
        ))}
      </div>
    </Card>
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
  const starred = useQuery({ queryKey: ['notes', 'home-starred'], queryFn: () => listNotes({ starred: true, state: 'all', order: 'updated', limit: 6 }) })
  const recent = useQuery({ queryKey: ['recent-viewed'], queryFn: () => recentViewed(6) })
  const inbox = useQuery({ queryKey: ['inbox-count'], queryFn: inboxCount, staleTime: 30_000 })

  // a page in a notebook reads top → bottom, oldest first
  const stream = [...(today.data ?? [])].reverse()
  // starred first, then recently opened (without repeats)
  const quick = [...(starred.data ?? []).map((n) => ({ n, star: true })), ...(recent.data ?? []).map((n) => ({ n, star: false }))]
    .filter((x, i, all) => all.findIndex((y) => y.n.id === x.n.id) === i).slice(0, 10)

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

        <header className="rise mb-5 flex items-end justify-between gap-3">
          <div>
            <p className="label-caps">{formatFullDate(day)}</p>
            <h1 className="mt-1 text-[34px] font-bold leading-tight">Today</h1>
          </div>
          {!!inbox.data && <Link to="/inbox" className="mb-1.5 rounded-full bg-accent-soft px-3 py-1 text-sm font-medium text-accent no-underline hover:no-underline hover:opacity-80">Inbox {inbox.data}</Link>}
        </header>

        <QuickCapture />
        <p className="mb-4 mt-3 text-center text-xs text-faint">Just write. <code>#tag</code> · <code>[[link]]</code> · <code>- [ ] task</code></p>
        <HabitStrip day={selected} today={day} tz={tz} />

        <div className="grid gap-4 lg:grid-cols-3">
          <Card title="Calendar" className="rise min-w-0 lg:col-start-3 lg:row-start-1 lg:self-start">
            <Calendar today={day} selected={selected} onSelect={(k) => setPicked(k === day ? null : k)} />
          </Card>

          <div className="min-w-0 space-y-4 lg:col-span-2 lg:col-start-1 lg:row-start-1">
            <Card className="rise relative focus-within:z-20">
              <DayAgenda day={selected} tz={tz} onToggle={(id, title, done) => void tick(id, title, done)} />
            </Card>

            <Card
              title={isToday ? 'Written today' : `Written on ${formatFullDate(selected)}`}
              aside={<>{stream.length ? `${stream.length} note${stream.length === 1 ? '' : 's'}` : null}{!isToday && <button className="ml-3 text-accent" onClick={() => setPicked(null)}>Back to today</button>}</>}
              className="rise" pad={false}
            >
              <div className="px-2 pb-3">
                {today.isLoading && <div className="space-y-2 p-3"><div className="skeleton h-14" /><div className="skeleton h-14 opacity-60" /></div>}
                {!today.isLoading && stream.length === 0 && <p className="px-3 py-4 text-sm text-faint">{isToday ? 'Nothing written today yet.' : 'Nothing written on this day.'}</p>}
                {stream.map((n) => <NoteRow key={n.id} note={n} tz={tz} />)}
              </div>
            </Card>

            {isToday && <OnThisDay day={day} tz={tz} />}

            {!!quick.length && (
              <Card title="Starred & recent" className="rise">
                <div className="flex flex-wrap gap-2">
                  {quick.map(({ n, star }) => (
                    <Link key={n.id} to={`/n/${n.public_id}`} className={`max-w-full truncate rounded-full px-3 py-1 text-sm text-ink no-underline hover:bg-hover hover:no-underline ${star ? 'border border-line' : 'bg-panel'}`}>
                      {star && <span className="text-important">★ </span>}{displayTitle(n)}
                    </Link>
                  ))}
                </div>
              </Card>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
