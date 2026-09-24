import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { bumpHabit, habitsForDay } from '@/api/habits'
import { useSettings } from '@/contexts/SettingsContext'
import { useToast } from '@/contexts/ToastContext'
import { formatDueDate } from '@/lib/dates'
import type { HabitDay } from '@/types/db'
import { IconCheck, IconFlame } from '@/components/icons'

/** One tap per habit for `day`: a yes/no habit toggles, a count habit adds one (− takes one back). */
export function HabitStrip({ day, today, tz }: { day: string; today: string; tz: string }) {
  const qc = useQueryClient()
  const { toast } = useToast()
  const { showStreaks } = useSettings()
  const key = ['habits', 'day', day]
  const q = useQuery({ queryKey: key, queryFn: () => habitsForDay(day), enabled: day <= today })

  if (day > today || !q.data) return null
  const due = q.data.filter((h) => h.due)

  const bump = async (h: HabitDay, delta: number) => {
    const set = (value: number) => qc.setQueryData<HabitDay[]>(key, (rows) => rows?.map((r) => (r.id === h.id ? { ...r, value } : r)))
    set(Math.max(0, h.value + delta))   // optimistic: the chip reacts instantly
    try {
      set(await bumpHabit(h.id, day, delta))
    } catch {
      set(h.value)
      toast('Couldn’t save that.', { kind: 'error' })
    } finally {
      void qc.invalidateQueries({ queryKey: ['habits'] })   // refresh streaks
    }
  }

  return (
    <div className="mb-6 flex items-center gap-2 overflow-x-auto pb-1 [scrollbar-width:none]">
      <span className="label-caps shrink-0">{day === today ? 'Habits' : formatDueDate(day, tz)}</span>
      {due.map((h) => {
        const done = h.value >= h.target
        const counted = h.target > 1
        const pct = Math.min(100, (h.value / h.target) * 100)
        return (
          <div key={h.id} className={`flex shrink-0 items-stretch overflow-hidden rounded-full border text-sm ${done ? 'border-transparent bg-accent text-on-accent' : 'border-line'}`}>
            {counted && h.value > 0 && !done && (
              <button aria-label={`One less ${h.name}`} onClick={() => void bump(h, -1)} className="px-2.5 text-muted hover:bg-hover">−</button>
            )}
            <button
              onClick={() => void bump(h, counted ? 1 : done ? -h.value : 1)}
              onContextMenu={(e) => { if (counted && h.value > 0) { e.preventDefault(); void bump(h, -1) } }}
              aria-pressed={done}
              aria-label={`${h.name}${counted ? `, ${h.value} of ${h.target}${h.unit ? ` ${h.unit}` : ''}` : ''}${done ? ', done' : ''}`}
              className="relative flex items-center gap-1.5 px-3.5 py-1.5"
              style={!done && counted && pct > 0 ? { background: `linear-gradient(90deg, var(--accent-soft) ${pct}%, transparent ${pct}%)` } : undefined}
            >
              {!counted && (done ? <IconCheck size={15} /> : <span aria-hidden className="size-3 rounded-full border-[1.5px] border-current opacity-60" />)}
              <span>{h.name}</span>
              {counted && <span className={`tabular-nums text-xs ${done ? '' : 'text-muted'}`}>{h.value}/{h.target}</span>}
              {showStreaks && h.streak >= 2 && <span className={`text-xs tabular-nums ${done ? '' : 'text-important'}`} title={`${h.streak}-day streak`}><IconFlame size={13} className="-mt-0.5 mr-px inline" />{h.streak}</span>}
            </button>
          </div>
        )
      })}
      <Link to="/habits" aria-label="Manage habits" className="shrink-0 rounded-full px-2.5 py-1.5 text-sm text-faint no-underline hover:bg-hover hover:text-ink hover:no-underline">
        {q.data.length ? 'Edit' : '+ Habit'}
      </Link>
    </div>
  )
}
