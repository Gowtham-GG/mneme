import { useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createHabit, EVERY_DAY, listHabitLogs, listHabits, updateHabit, type HabitInput } from '@/api/habits'
import { useSettings } from '@/contexts/SettingsContext'
import { useToast } from '@/contexts/ToastContext'
import { HabitHeatmap } from '@/components/HabitHeatmap'
import { addDays, dayKey, todayKey } from '@/lib/dates'
import { habitStats } from '@/lib/habits'
import { IconX } from '@/components/icons'
import type { Habit } from '@/types/db'

const DAY_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

/** Seven toggles, Monday first; at least one day always stays on. */
function DayPicker({ value, onChange }: { value: number; onChange: (days: number) => void }) {
  return (
    <div className="flex gap-1" role="group" aria-label="Days">
      {DAY_LETTERS.map((l, i) => {
        const bit = 1 << i
        const on = (value & bit) !== 0
        return (
          <button
            key={i} type="button" aria-pressed={on} aria-label={DAY_NAMES[i]}
            onClick={() => { const next = value ^ bit; if (next) onChange(next) }}
            className={`size-7 rounded-full text-xs font-medium ${on ? 'bg-accent text-on-accent' : 'border border-line text-faint hover:bg-hover'}`}
          >{l}</button>
        )
      })}
    </div>
  )
}

const inputCls = 'rounded-lg border border-line bg-bg px-2.5 py-1.5 text-sm'

function HabitRow({ h, values, today, tz, showStreaks, onSave, onRemove }: {
  h: Habit; values: Map<string, number>; today: string; tz: string; showStreaks: boolean
  onSave: (p: Partial<HabitInput>) => void; onRemove: () => void
}) {
  const [name, setName] = useState(h.name)
  const [target, setTarget] = useState(String(h.target))
  const [unit, setUnit] = useState(h.unit ?? '')
  // the first logged day may predate the habit (backfilled progress)
  const created = dayKey(h.created_at, tz)
  const first = [...values.keys()][0]
  const start = first && first < created ? first : created
  const st = habitStats(values, h.days, h.target, start, today)
  return (
    <li className="border-b border-line py-3 last:border-0">
      <div className="flex flex-wrap items-center gap-2">
        <input value={name} aria-label="Name" onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name.trim() !== h.name ? onSave({ name: name.trim() }) : setName(h.name)}
          className={`${inputCls} min-w-0 flex-1 basis-40`} />
        <input value={target} inputMode="numeric" aria-label="Daily target" title="Daily target (1 = yes/no)"
          onChange={(e) => setTarget(e.target.value.replace(/\D/g, ''))}
          onBlur={() => { const n = Math.min(1000, Math.max(1, Number(target) || 1)); setTarget(String(n)); if (n !== h.target) onSave({ target: n }) }}
          className={`${inputCls} w-14 text-center tabular-nums`} />
        <input value={unit} aria-label="Unit" placeholder="unit" maxLength={20} onChange={(e) => setUnit(e.target.value)}
          onBlur={() => (unit.trim() || null) !== h.unit && onSave({ unit: unit.trim() || null })}
          className={`${inputCls} w-24`} />
        <DayPicker value={h.days} onChange={(days) => onSave({ days })} />
        <button aria-label={`Remove ${h.name}`} onClick={onRemove} className="rounded-lg p-1.5 text-faint hover:bg-hover hover:text-danger"><IconX size={16} /></button>
      </div>
      <div className="mt-2.5 flex flex-wrap items-end gap-x-5 gap-y-2">
        <HabitHeatmap values={values} mask={h.days} target={h.target} start={start} today={today} />
        <div className="flex gap-4 text-xs text-muted">
          {showStreaks && <span title="Current streak"><span className="text-base font-semibold text-ink tabular-nums">🔥{st.current}</span></span>}
          {showStreaks && <span title="Best streak (last year)">best <span className="font-semibold text-ink tabular-nums">{st.best}</span></span>}
          {st.rate30 !== null && <span title="Due days met, last 30 days"><span className="font-semibold text-ink tabular-nums">{Math.round(st.rate30 * 100)}%</span> 30d</span>}
        </div>
      </div>
    </li>
  )
}

export function Habits() {
  const qc = useQueryClient()
  const { toast } = useToast()
  const { timezone: tz, showStreaks } = useSettings()
  const today = todayKey(tz)
  const since = addDays(today, -370)
  const q = useQuery({ queryKey: ['habits', 'list'], queryFn: listHabits })
  const logs = useQuery({ queryKey: ['habits', 'logs', since], queryFn: () => listHabitLogs(since) })
  const byHabit = new Map<string, Map<string, number>>()
  for (const l of logs.data ?? []) {
    if (!byHabit.has(l.habit_id)) byHabit.set(l.habit_id, new Map())
    byHabit.get(l.habit_id)!.set(l.day, l.value)
  }
  const [name, setName] = useState('')
  const [target, setTarget] = useState('1')
  const [unit, setUnit] = useState('')
  const [days, setDays] = useState(EVERY_DAY)

  const refresh = () => void qc.invalidateQueries({ queryKey: ['habits'] })
  const run = async (fn: () => Promise<void>, fail = 'Couldn’t save that.') => {
    try { await fn(); refresh() } catch { toast(fail, { kind: 'error' }) }
  }

  const add = (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    // clear straight away so typing the next habit is never wiped by a late reset; restore on failure
    const draft = { name, target, unit, days }
    setName(''); setTarget('1'); setUnit(''); setDays(EVERY_DAY)
    void createHabit({ name: draft.name, target: Math.min(1000, Math.max(1, Number(draft.target) || 1)), unit: draft.unit || null, days: draft.days })
      .then(refresh)
      .catch(() => {
        setName(draft.name); setTarget(draft.target); setUnit(draft.unit); setDays(draft.days)
        toast('Couldn’t add that habit.', { kind: 'error' })
      })
  }

  const remove = (h: Habit) => void run(async () => {
    await updateHabit(h.id, { archived_at: new Date().toISOString() })
    toast(`Removed ${h.name}`, { action: { label: 'Undo', onClick: () => void updateHabit(h.id, { archived_at: null }).then(refresh) } })
  })

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

        <p className="-mt-2 mb-4 px-1 text-xs text-faint">Target 1 = done / not done · more = a daily count (8 glasses)</p>

        <div className="glass rise rounded-2xl px-4">
          {q.isLoading && <div className="skeleton my-4 h-10" />}
          {q.data?.length === 0 && <p className="py-5 text-sm text-faint">No habits yet.</p>}
          <ul>
            {q.data?.map((h) => (
              <HabitRow key={h.id} h={h} values={byHabit.get(h.id) ?? new Map()} today={today} tz={tz} showStreaks={showStreaks} onSave={(p) => void run(() => updateHabit(h.id, p))} onRemove={() => remove(h)} />
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}
