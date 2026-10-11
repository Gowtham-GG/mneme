import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { checkIn, habitsForDay } from '@/api/habits'
import { ruleMessage } from '@/api/errors'
import { useSettings } from '@/contexts/SettingsContext'
import { useToast } from '@/contexts/ToastContext'
import { formatDueDate } from '@/lib/dates'
import { fillStep, logStep, tallySteps } from '@/lib/habits'
import type { HabitDay, HabitStep } from '@/types/db'
import { IconCheck, IconChevron, IconFlame } from '@/components/icons'

/**
 * One tap per habit for `day`: a yes/no habit toggles, a count habit adds one (− takes one back),
 * a routine opens the steps that are on that day underneath (tick them one by one, a group at a
 * time, or all at once). A routine's count is its innermost steps.
 */
export function HabitStrip({ day, today, tz, className = 'mb-6' }: { day: string; today: string; tz: string; className?: string }) {
  const qc = useQueryClient()
  const { toast } = useToast()
  const { showStreaks } = useSettings()
  const [openId, setOpenId] = useState<string | null>(null)
  const key = ['habits', 'day', day]
  const q = useQuery({ queryKey: key, queryFn: () => habitsForDay(day), enabled: day <= today })

  if (day > today || !q.data) return null
  // a routine counts its innermost steps, so the chip follows every tick
  const due = q.data.filter((h) => h.due).map((h) => {
    if (!h.steps.length) return h
    const [value, target] = tallySteps(h.steps)
    return { ...h, value, target }
  })
  const routine = due.find((h) => h.id === openId && h.steps.length)

  const patch = (id: string, f: (h: HabitDay) => HabitDay) => qc.setQueryData<HabitDay[]>(key, (rows) => rows?.map((r) => (r.id === id ? f(r) : r)))
  const save = async (taskId: string, delta: number, undo: () => void) => {
    try {
      await checkIn(taskId, day, delta)
    } catch (e) {
      undo()
      toast(ruleMessage(e, 'Couldn’t save that.'), { kind: 'error' })
    } finally {
      void qc.invalidateQueries({ queryKey: ['habits'] })   // refresh streaks
      void qc.invalidateQueries({ queryKey: ['tasks'] })    // ticks show in task trees and on the board
    }
  }
  const bump = (h: HabitDay, delta: number) => {
    patch(h.id, (r) => ({ ...r, value: Math.max(0, r.value + delta) }))   // optimistic: the chip reacts instantly
    void save(h.id, delta, () => patch(h.id, () => h))
  }
  // a step: tick / untick, a counted one (3 sets) one more / one less, a group all of it
  const logOne = (h: HabitDay, stepId: string, delta: number) => {
    const before = q.data?.find((r) => r.id === h.id)
    patch(h.id, (r) => ({ ...r, steps: logStep(r.steps, stepId, delta) }))
    void save(stepId, delta, () => before && patch(h.id, () => before))
  }
  const tickAll = (h: HabitDay, done: boolean) => {
    const before = q.data?.find((r) => r.id === h.id)
    patch(h.id, (r) => ({ ...r, steps: r.steps.map((s) => fillStep(s, done)) }))
    void save(h.id, done ? 1 : -1, () => before && patch(h.id, () => before))
  }

  return (
    <div className={className}>
      <div data-tour="habits" className="flex items-center gap-2 overflow-x-auto pb-1 [scrollbar-width:none]">
        <span className="label-caps shrink-0">{day === today ? 'Habits' : formatDueDate(day, tz)}</span>
        {due.map((h) => {
          const done = h.value >= h.target
          const isRoutine = h.steps.length > 0
          const counted = h.target > 1 && !isRoutine
          const pct = Math.min(100, (h.value / h.target) * 100)
          return (
            <div key={h.id} className={`flex shrink-0 items-stretch overflow-hidden rounded-full border text-sm ${done ? 'border-transparent bg-accent text-on-accent' : 'border-line'} ${openId === h.id ? 'ring-2 ring-accent/50' : ''}`}>
              {counted && h.value > 0 && !done && (
                <button aria-label={`One less ${h.name}`} onClick={() => bump(h, -1)} className="px-2.5 text-muted hover:bg-hover">−</button>
              )}
              <button
                onClick={() => isRoutine ? setOpenId(openId === h.id ? null : h.id) : bump(h, counted ? 1 : done ? -h.value : 1)}
                onContextMenu={(e) => { if (counted && h.value > 0) { e.preventDefault(); bump(h, -1) } }}
                aria-pressed={isRoutine ? undefined : done}
                aria-expanded={isRoutine ? openId === h.id : undefined}
                aria-label={`${h.name}${counted || isRoutine ? `, ${h.value} of ${h.target}${counted && h.unit ? ` ${h.unit}` : ''}` : ''}${done ? ', done' : ''}`}
                className="relative flex items-center gap-1.5 px-3.5 py-1.5"
                style={!done && (counted || isRoutine) && pct > 0 ? { background: `linear-gradient(90deg, var(--accent-soft) ${pct}%, transparent ${pct}%)` } : undefined}
              >
                {!counted && !isRoutine && (done ? <IconCheck size={15} /> : <span aria-hidden className="size-3 rounded-full border-[1.5px] border-current opacity-60" />)}
                <span>{h.name}</span>
                {(counted || isRoutine) && <span className={`tabular-nums text-xs ${done ? '' : 'text-muted'}`}>{h.value}/{h.target}</span>}
                {isRoutine && <IconChevron size={12} className={`transition-transform ${openId === h.id ? '-rotate-90' : 'rotate-90'} ${done ? '' : 'text-faint'}`} />}
                {showStreaks && h.streak >= 2 && <span className={`text-xs tabular-nums ${done ? '' : 'text-important'}`} title={`${h.streak}-day streak`}><IconFlame size={13} className="-mt-0.5 mr-px inline" />{h.streak}</span>}
              </button>
            </div>
          )
        })}
        <Link to="/habits" aria-label="Manage habits" className="shrink-0 rounded-full px-2.5 py-1.5 text-sm text-faint no-underline hover:bg-hover hover:text-ink hover:no-underline">
          {q.data.length ? 'Edit' : '+ Habit'}
        </Link>
      </div>
      {routine && (
        <div className="mt-1.5 grid gap-1.5 pl-1" role="group" aria-label={`${routine.name} steps`}>
          <StepChips steps={routine.steps} onLog={(id, delta) => logOne(routine, id, delta)}
            tail={
              <button onClick={() => tickAll(routine, routine.value < routine.target)} className="rounded-full px-2.5 py-1 text-xs text-faint hover:bg-hover hover:text-ink">
                {routine.value < routine.target ? 'All done' : 'Clear'}
              </button>
            } />
        </div>
      )}
    </div>
  )
}

const stepChip = (done: boolean) =>
  `flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs ${done ? 'border-transparent bg-accent-soft text-accent' : 'border-line text-muted hover:bg-hover'}`

/**
 * A routine's steps for the day: plain steps as numbered chips in a row; a group (Upper body)
 * gets its own line — its chip ticks all of it, its steps follow — and deeper groups indent.
 * `tail` (All done / Clear) ends the row, or gets its own line under groups.
 */
function StepChips({ steps, onLog, tail, depth = 0 }: { steps: HabitStep[]; onLog: (id: string, delta: number) => void; tail?: ReactNode; depth?: number }) {
  const leaves = steps.filter((s) => !s.steps.length)
  const groups = steps.filter((s) => s.steps.length)
  return (
    <>
      {(leaves.length > 0 || (tail && !groups.length)) && (
        <div className="flex flex-wrap items-center gap-1.5" style={{ paddingLeft: depth * 12 }}>
          {leaves.map((s, i) => <LeafChip key={s.id} s={s} n={i + 1} onLog={onLog} />)}
          {!groups.length && tail}
        </div>
      )}
      {groups.map((g) => {
        const [done, total] = tallySteps(g.steps)
        return (
          <div key={g.id} className="grid gap-1.5">
            <div className="flex flex-wrap items-center gap-1.5" style={{ paddingLeft: depth * 12 }}>
              <button aria-pressed={g.done} onClick={() => onLog(g.id, g.done ? -1 : 1)} className={`${stepChip(g.done)} font-medium`}
                aria-label={`${g.title}, ${done} of ${total}${g.done ? ', done' : ''}`}>
                {g.done ? <IconCheck size={13} /> : <span className="tabular-nums text-faint">{done}/{total}</span>}
                {g.title}
              </button>
              {g.steps.filter((c) => !c.steps.length).map((c, i) => <LeafChip key={c.id} s={c} n={i + 1} onLog={onLog} />)}
            </div>
            {g.steps.some((c) => c.steps.length) && (
              <StepChips steps={g.steps.filter((c) => c.steps.length)} onLog={onLog} depth={depth + 1} />
            )}
          </div>
        )
      })}
      {groups.length > 0 && tail && <div>{tail}</div>}
    </>
  )
}

/** One step: a tick, or a count ("Bench press 1/3 sets") where a tap adds one and − takes one back. */
function LeafChip({ s, n, onLog }: { s: HabitStep; n: number; onLog: (id: string, delta: number) => void }) {
  const counted = s.target > 1
  return (
    <span className={`flex items-stretch overflow-hidden rounded-full border text-xs ${s.done ? 'border-transparent bg-accent-soft text-accent' : 'border-line text-muted'}`}>
      {counted && s.value > 0 && !s.done && (
        <button aria-label={`One less ${s.title}`} onClick={() => onLog(s.id, -1)} className="pl-2.5 pr-1 hover:bg-hover">−</button>
      )}
      <button aria-pressed={s.done} onClick={() => onLog(s.id, counted ? (s.done ? -s.value : 1) : s.done ? -1 : 1)}
        onContextMenu={(e) => { if (counted && s.value > 0) { e.preventDefault(); onLog(s.id, -1) } }}
        aria-label={`${s.title}${counted ? `, ${s.value} of ${s.target}${s.unit ? ` ${s.unit}` : ''}` : ''}${s.done ? ', done' : ''}`}
        className={`flex items-center gap-1.5 px-3 py-1 ${s.done ? '' : 'hover:bg-hover'}`}>
        {s.done ? <IconCheck size={13} /> : !counted && <span className="tabular-nums text-faint">{n}</span>}
        {s.title}
        {counted && <span className={`tabular-nums ${s.done ? '' : 'text-faint'}`}>{s.value}/{s.target}{s.unit ? ` ${s.unit}` : ''}</span>}
      </button>
    </span>
  )
}
