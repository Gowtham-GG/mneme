import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { calendarMonth } from '@/api/calendar'
import { IconChevron } from '@/components/icons'
import { addDays, addMonths, formatFullDate, formatMonth, monthGrid } from '@/lib/dates'
import type { CalendarDay } from '@/types/db'

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']

function describe(key: string, c: CalendarDay | undefined): string {
  const bits = [formatFullDate(key)]
  if (c?.journal) bits.push('journal')
  if (c?.notes) bits.push(`${c.notes} note${c.notes === 1 ? '' : 's'} written`)
  if (c?.scheduled) bits.push(`${c.scheduled} scheduled`)
  const plain = (c?.open_tasks ?? 0) - (c?.scheduled ?? 0)
  if (plain > 0) bits.push(`${plain} task${plain === 1 ? '' : 's'} due`)
  if (c?.done_tasks && !c.open_tasks) bits.push('all tasks done')
  return bits.join(', ')
}

/**
 * Month calendar. A ring round a date = notes were written that day; a corner
 * dot = that day has a journal page; dots
 * under it = something due: amber for scheduled items (timed tasks) or
 * meeting notes, teal for open tasks (red once the day has passed), grey
 * when that day's tasks are all done.
 */
export function Calendar({ today, selected, onSelect }: { today: string; selected: string; onSelect: (key: string) => void }) {
  const [month, setMonth] = useState(() => addMonths(selected, 0))
  const [focusKey, setFocusKey] = useState(selected)
  const grid = monthGrid(month)
  const from = grid[0], to = grid[grid.length - 1]
  const gridRef = useRef<HTMLDivElement>(null)
  const moved = useRef(false)

  // keep the visible month in step when the selection jumps elsewhere (e.g. "Back to today")
  useEffect(() => {
    if (selected.slice(0, 7) !== month.slice(0, 7)) setMonth(addMonths(selected, 0))
    setFocusKey(selected)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected])

  useEffect(() => {
    if (!moved.current) return
    moved.current = false
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-day="${focusKey}"]`)?.focus()
  }, [focusKey, month])

  const q = useQuery({
    queryKey: ['notes', 'calendar', from, to],
    queryFn: () => calendarMonth(from, to),
    placeholderData: (prev) => prev,
  })
  const byDay = new Map((q.data ?? []).map((d) => [d.day, d]))

  const onKey = (e: KeyboardEvent) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key]
    if (step === undefined) return
    e.preventDefault()
    const next = addDays(focusKey, step)
    moved.current = true
    if (next.slice(0, 7) !== month.slice(0, 7)) setMonth(addMonths(next, 0))
    setFocusKey(next)
  }

  return (
    <div>
      <div className="mb-2 flex items-center gap-1">
        <h3 className="flex-1 text-base font-semibold" aria-live="polite">{formatMonth(month)}</h3>
        {(month.slice(0, 7) !== today.slice(0, 7) || selected !== today) && (
          <button className="rounded-lg px-2 py-1 text-xs text-muted hover:bg-hover hover:text-ink" onClick={() => { setMonth(addMonths(today, 0)); onSelect(today) }}>Today</button>
        )}
        <button aria-label="Previous month" className="rounded-lg p-1.5 text-muted hover:bg-hover hover:text-ink" onClick={() => setMonth(addMonths(month, -1))}>
          <IconChevron size={16} className="rotate-180" />
        </button>
        <button aria-label="Next month" className="rounded-lg p-1.5 text-muted hover:bg-hover hover:text-ink" onClick={() => setMonth(addMonths(month, 1))}>
          <IconChevron size={16} />
        </button>
      </div>

      <div ref={gridRef} role="grid" aria-label={formatMonth(month)} onKeyDown={onKey} className="grid grid-cols-7 gap-y-1 text-center">
        {WEEKDAYS.map((w) => <div key={w} role="columnheader" className="pb-1 text-[11px] font-medium uppercase tracking-wide text-faint">{w}</div>)}
        {grid.map((key) => {
          const c = byDay.get(key)
          const inMonth = key.slice(0, 7) === month.slice(0, 7)
          const isToday = key === today
          const isSel = key === selected
          const plainOpen = (c?.open_tasks ?? 0) - (c?.scheduled ?? 0)
          const dots: string[] = []
          if (c?.scheduled || c?.meetings) dots.push('bg-important')
          if (plainOpen > 0) dots.push(key < today ? 'bg-danger' : 'bg-task')
          if (!c?.open_tasks && c?.done_tasks) dots.push('bg-faint')
          return (
            <div key={key} role="gridcell" className="flex justify-center">
              <button
                data-day={key}
                tabIndex={key === focusKey ? 0 : -1}
                aria-label={describe(key, c)}
                aria-selected={isSel}
                aria-current={isToday ? 'date' : undefined}
                onClick={() => { setFocusKey(key); onSelect(key) }}
                className={[
                  'relative flex size-10 flex-col items-center justify-center rounded-full text-sm tabular-nums transition-colors focus-visible:rounded-full! focus-visible:outline-offset-1',
                  isSel ? 'bg-accent font-semibold text-on-accent' : isToday ? 'bg-accent-soft font-semibold text-accent' : 'hover:bg-hover',
                  !isSel && !inMonth ? 'text-faint opacity-60' : '',
                  c?.notes && !isSel ? 'ring-[1.5px] ring-accent/70 ring-inset' : '',
                ].join(' ')}
              >
                {c?.journal && <span aria-hidden className={`absolute right-1 top-1 size-1.5 rounded-full ${isSel ? 'bg-on-accent' : 'bg-accent'}`} />}
                <span className="leading-none">{Number(key.slice(8))}</span>
                <span className="absolute bottom-1 flex h-1 gap-0.5" aria-hidden>
                  {dots.map((d) => <span key={d} className={`size-1 rounded-full ${isSel ? 'bg-on-accent' : d}`} />)}
                </span>
              </button>
            </div>
          )
        })}
      </div>

      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-faint" aria-hidden>
        <span className="flex items-center gap-1"><span className="size-3 rounded-full ring-[1.5px] ring-accent/70 ring-inset" />Notes</span>
        <span className="flex items-center gap-1"><span className="size-1.5 rounded-full bg-accent" />Journal</span>
        <span className="flex items-center gap-1"><span className="size-1.5 rounded-full bg-important" />Scheduled</span>
        <span className="flex items-center gap-1"><span className="size-1.5 rounded-full bg-task" />Tasks</span>
        <span className="flex items-center gap-1"><span className="size-1.5 rounded-full bg-danger" />Overdue</span>
        <span className="flex items-center gap-1"><span className="size-1.5 rounded-full bg-faint" />Done</span>
      </div>
    </div>
  )
}
