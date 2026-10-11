import { useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createHabit, EVERY_DAY, listCheckins, listHabits, setRhythm, type Checkin, type Rhythm } from '@/api/habits'
import { useSettings } from '@/contexts/SettingsContext'
import { useToast } from '@/contexts/ToastContext'
import { HabitHeatmap } from '@/components/HabitHeatmap'
import { DayPicker, inputCls } from '@/components/RhythmFields'
import { TaskUiProvider, useTaskUi } from '@/components/tasks/TaskUi'
import { addDays, dayKey, formatDueDate, todayKey } from '@/lib/dates'
import { habitStats, rhythmLabel } from '@/lib/habits'
import { IconFlame, IconMore, IconSteps, IconX } from '@/components/icons'
import type { TaskItem, TaskState } from '@/types/db'

interface History { values: Map<string, number>; skipped: Set<string>; notes: Checkin[] }
const EMPTY: History = { values: new Map(), skipped: new Set(), notes: [] }

function HabitRow({ h, hist, today, tz, showStreaks, onSave }: {
  h: TaskItem; hist: History; today: string; tz: string; showStreaks: boolean; onSave: (p: Partial<Rhythm>) => void
}) {
  const ui = useTaskUi()
  const [name, setName] = useState(h.title)
  const [target, setTarget] = useState(String(h.rhythm_target))
  const [unit, setUnit] = useState(h.rhythm_unit ?? '')
  const mask = h.rhythm_days!
  // the days it is really on: steps with their own days can leave rest days (gym on weekdays only)
  const dueMask = h.due_days || mask
  // a routine counts a day when all its steps were ticked (stored as 1)
  const steps = h.child_count - h.child_resolved
  const goal = steps > 0 ? 1 : h.rhythm_target
  // the first logged day may predate the habit (backfilled progress)
  const created = dayKey(h.created_at, tz)
  const first = [...hist.values.keys()][0]
  const start = first && first < created ? first : created
  const st = habitStats(hist.values, dueMask, goal, start, today, hist.skipped)
  const { toast } = useToast()
  const retire = () => void ui.act.state(h, 'cancelled').then((ok) => {
    if (ok) toast(`Retired ${h.title}`, { action: { label: 'Undo', onClick: () => void ui.act.state(h, 'open') } })
  })
  return (
    <li className="border-b border-line py-3 last:border-0">
      <div className="flex flex-wrap items-center gap-2">
        <input value={name} aria-label="Name" maxLength={500} onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name.trim() !== h.title ? void ui.act.rename(h, name.trim()) : setName(h.title)}
          className={`${inputCls} min-w-0 flex-1 basis-40`} />
        {steps > 0 ? (
          <button className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-muted hover:bg-hover hover:text-ink" title="Its steps — tick them on Today; a step can have its own days (More → Days & count)"
            onClick={() => ui.openTree(h.id)}><IconSteps size={14} />{steps} step{steps === 1 ? '' : 's'}</button>
        ) : (
          <>
            <input value={target} inputMode="numeric" aria-label="Daily target" title="Daily target (1 = yes/no)"
              onChange={(e) => setTarget(e.target.value.replace(/\D/g, ''))}
              onBlur={() => { const n = Math.min(1000, Math.max(1, Number(target) || 1)); setTarget(String(n)); if (n !== h.rhythm_target) onSave({ rhythm_target: n }) }}
              className={`${inputCls} w-14 text-center tabular-nums`} />
            <input value={unit} aria-label="Unit" placeholder="unit" maxLength={20} onChange={(e) => setUnit(e.target.value)}
              onBlur={() => (unit.trim() || null) !== h.rhythm_unit && onSave({ rhythm_unit: unit.trim() || null })}
              className={`${inputCls} w-24`} />
          </>
        )}
        <DayPicker value={mask} onChange={(days) => onSave({ rhythm_days: days })} />
        <button aria-label={`More for ${h.title}`} title="Steps, pause, links, note…" className="rounded-lg p-1.5 text-faint hover:bg-hover hover:text-ink"
          onClick={() => ui.openMenu({ t: h, onAddSub: () => ui.openTree(h.id), onAddSeq: () => ui.openTree(h.id) })}><IconMore size={16} /></button>
        <button aria-label={`Retire ${h.title}`} title="Retire (history kept)" onClick={retire} className="rounded-lg p-1.5 text-faint hover:bg-hover hover:text-danger"><IconX size={16} /></button>
      </div>
      <div className="mt-2.5 flex flex-wrap items-end gap-x-5 gap-y-2">
        <HabitHeatmap values={hist.values} skipped={hist.skipped} mask={dueMask} target={goal} start={start} today={today} />
        <div className="flex gap-4 text-xs text-muted">
          {showStreaks && <span title="Current streak"><span className="text-base font-semibold text-ink tabular-nums"><IconFlame size={16} className="-mt-1 mr-0.5 inline text-important" />{st.current}</span></span>}
          {showStreaks && <span title="Best streak (last year)">best <span className="font-semibold text-ink tabular-nums">{st.best}</span></span>}
          {st.rate30 !== null && <span title="Due days met, last 30 days"><span className="font-semibold text-ink tabular-nums">{Math.round(st.rate30 * 100)}%</span> 30d</span>}
        </div>
      </div>
      {hist.notes.length > 0 && (
        <ul className="mt-2 grid gap-0.5 text-xs">
          {hist.notes.slice(-3).reverse().map((n) => (
            <li key={n.day} className="flex gap-2"><span className="w-14 shrink-0 text-faint">{formatDueDate(n.day, tz)}</span><span className="text-muted">{n.note}</span></li>
          ))}
        </ul>
      )}
    </li>
  )
}

const ASIDE: { state: TaskState; label: string }[] = [
  { state: 'on_hold', label: 'Paused' }, { state: 'done', label: 'Graduated' }, { state: 'cancelled', label: 'Retired' },
]

/** Habits set aside: resume, or delete for good. */
function AsideList({ label, rows }: { label: string; rows: TaskItem[] }) {
  const ui = useTaskUi()
  if (!rows.length) return null
  return (
    <details className="glass rise mt-3 rounded-2xl px-4 py-2">
      <summary className="cursor-pointer py-1 text-sm text-muted">{label} <span className="tabular-nums text-faint">{rows.length}</span></summary>
      <ul className="pb-1">
        {rows.map((h) => (
          <li key={h.id} className="flex items-center gap-2 py-1.5 text-sm">
            <span className="min-w-0 flex-1 truncate">{h.title} <span className="text-xs text-faint">· {rhythmLabel(h.rhythm_days!)}</span></span>
            <button className="rounded-lg px-2.5 py-1 text-xs text-accent hover:bg-hover" onClick={() => void ui.act.state(h, 'open')}>Resume</button>
            <button aria-label={`Delete ${h.title}`} title="Delete with its history" className="rounded-lg p-1 text-faint hover:bg-hover hover:text-danger" onClick={() => ui.act.del(h)}><IconX size={14} /></button>
          </li>
        ))}
      </ul>
    </details>
  )
}

function HabitsPage() {
  const qc = useQueryClient()
  const { toast } = useToast()
  const { timezone: tz, showStreaks } = useSettings()
  const today = todayKey(tz)
  const since = addDays(today, -370)
  const q = useQuery({ queryKey: ['habits', 'list'], queryFn: listHabits })
  const logs = useQuery({ queryKey: ['habits', 'checkins', since], queryFn: () => listCheckins(since) })
  const byHabit = new Map<string, History>()
  for (const l of logs.data ?? []) {
    if (!byHabit.has(l.task_id)) byHabit.set(l.task_id, { values: new Map(), skipped: new Set(), notes: [] })
    const h = byHabit.get(l.task_id)!
    if (l.skipped) h.skipped.add(l.day)
    else if (l.value > 0) h.values.set(l.day, l.value)
    if (l.note) h.notes.push(l)
  }
  const active = (q.data ?? []).filter((h) => h.state === 'open' || h.state === 'in_progress')
  const [name, setName] = useState('')
  const [target, setTarget] = useState('1')
  const [unit, setUnit] = useState('')
  const [days, setDays] = useState(EVERY_DAY)

  const refresh = () => { void qc.invalidateQueries({ queryKey: ['habits'] }); void qc.invalidateQueries({ queryKey: ['tasks'] }) }

  const add = (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    // clear straight away so typing the next habit is never wiped by a late reset; restore on failure
    const draft = { name, target, unit, days }
    setName(''); setTarget('1'); setUnit(''); setDays(EVERY_DAY)
    void createHabit(draft.name, { rhythm_days: draft.days, rhythm_target: Math.min(1000, Math.max(1, Number(draft.target) || 1)), rhythm_unit: draft.unit || null })
      .then(refresh)
      .catch(() => {
        setName(draft.name); setTarget(draft.target); setUnit(draft.unit); setDays(draft.days)
        toast('Couldn’t add that habit.', { kind: 'error' })
      })
  }

  const save = (h: TaskItem, p: Partial<Rhythm>) =>
    void setRhythm(h.id, p).then(refresh, () => toast('Couldn’t save that.', { kind: 'error' }))

  return (
    <div className="h-full overflow-y-auto">
      <div className="page-top mx-auto max-w-3xl px-4 pb-32 lg:px-6 lg:pb-8">
        <h1 className="rise mb-5 text-[34px] font-bold leading-tight">Habits</h1>

        <form onSubmit={add} className="glass rise mb-4 flex flex-wrap items-center gap-2 rounded-2xl p-4">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New habit, e.g. Read" aria-label="New habit name"
            className={`${inputCls} min-w-0 flex-1 basis-40`} />
          <input value={target} inputMode="numeric" onChange={(e) => setTarget(e.target.value.replace(/\D/g, ''))}
            aria-label="Daily target" title="Daily target (1 = yes/no)" className={`${inputCls} w-14 text-center tabular-nums`} />
          <input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="unit" aria-label="Unit" maxLength={20} className={`${inputCls} w-24`} />
          <DayPicker value={days} onChange={setDays} />
          <button type="submit" disabled={!name.trim()} className="rounded-lg bg-accent px-4 py-1.5 text-sm font-medium text-on-accent disabled:opacity-50">Add</button>
        </form>

        <p className="-mt-2 mb-4 px-1 text-xs text-faint">Target 1 = done / not done · more = a daily count · or type “stretch every day” in any task box</p>

        <div className="glass rise rounded-2xl px-4">
          {q.isLoading && <div className="skeleton my-4 h-10" />}
          {q.isSuccess && !active.length && <p className="py-5 text-sm text-faint">No habits yet.</p>}
          <ul>
            {active.map((h) => (
              <HabitRow key={h.id} h={h} hist={byHabit.get(h.id) ?? EMPTY} today={today} tz={tz} showStreaks={showStreaks} onSave={(p) => save(h, p)} />
            ))}
          </ul>
        </div>

        {ASIDE.map((a) => <AsideList key={a.state} label={a.label} rows={(q.data ?? []).filter((h) => h.state === a.state)} />)}
      </div>
    </div>
  )
}

export function Habits() {
  return <TaskUiProvider><HabitsPage /></TaskUiProvider>
}
