import { useEffect, useRef } from 'react'
import { addDays, formatFullDate } from '@/lib/dates'
import { isDue } from '@/lib/habits'

/** GitHub-style grid, Monday-first columns ending with this week; shade = share of the daily target. */
export function HabitHeatmap({ values, mask, target, start, today, weeks = 26 }: {
  values: Map<string, number>; mask: number; target: number; start: string; today: string; weeks?: number
}) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => { if (box.current) box.current.scrollLeft = box.current.scrollWidth }, [])

  const [y, m, d] = today.split('-').map(Number)
  const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7
  const first = addDays(today, -dow - (weeks - 1) * 7)
  const cols = Array.from({ length: weeks }, (_, w) => Array.from({ length: 7 }, (_, i) => addDays(first, w * 7 + i)))

  return (
    <div ref={box} className="overflow-x-auto [scrollbar-width:none]">
      <div className="flex w-max gap-[3px]" role="img" aria-label={`Last ${weeks} weeks`}>
        {cols.map((col, i) => (
          <div key={i} className="flex flex-col gap-[3px]">
            {col.map((day) => {
              if (day > today) return <span key={day} className="size-[11px]" />
              const v = values.get(day) ?? 0
              const due = isDue(mask, day) && day >= start
              const pct = Math.min(1, v / target)
              const bg = v > 0
                ? `color-mix(in oklab, var(--accent) ${Math.round(25 + pct * 75)}%, transparent)`
                : due ? 'var(--panel)' : 'transparent'
              return (
                <span key={day} title={`${formatFullDate(day)}: ${due || v ? `${v}/${target}` : 'not due'}`}
                  className={`size-[11px] rounded-[3px] ${!due && !v ? 'border border-line/50' : ''} ${day === today ? 'ring-1 ring-ink/40' : ''}`}
                  style={{ background: bg }} />
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}
