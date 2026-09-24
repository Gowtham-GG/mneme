import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { Dialog } from '@/components/Dialog'
import { dialValue, joinTime, splitTime } from '@/lib/clock'
import { addDays, addMonths, formatDueDate, formatMonth, formatTimeOfDay, monthGrid, todayKey } from '@/lib/dates'
import { IconChevron } from '@/components/icons'

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']
const chip = (on: boolean) => `rounded-full px-3 py-1.5 text-sm ${on ? 'bg-accent font-medium text-on-accent' : 'bg-panel hover:bg-hover'}`

function MonthPicker({ value, today, onPick }: { value: string | null; today: string; onPick: (d: string) => void }) {
  const [month, setMonth] = useState(() => addMonths(value ?? today, 0))
  const grid = monthGrid(month)
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <button type="button" aria-label="Previous month" className="rounded-full p-1.5 hover:bg-hover" onClick={() => setMonth(addMonths(month, -1))}>
          <IconChevron size={16} className="rotate-180" />
        </button>
        <span className="text-sm font-medium">{formatMonth(month)}</span>
        <button type="button" aria-label="Next month" className="rounded-full p-1.5 hover:bg-hover" onClick={() => setMonth(addMonths(month, 1))}>
          <IconChevron size={16} />
        </button>
      </div>
      <div className="grid grid-cols-7 gap-0.5 text-center" role="grid" aria-label={formatMonth(month)}>
        {WEEKDAYS.map((w) => <div key={w} className="py-1 text-[11px] text-faint">{w}</div>)}
        {grid.map((d) => {
          const on = d === value, inMonth = d.slice(0, 7) === month.slice(0, 7)
          return (
            <button key={d} type="button" role="gridcell" aria-selected={on} aria-label={d} onClick={() => onPick(d)}
              className={`mx-auto flex size-9 items-center justify-center rounded-full text-sm tabular-nums ${
                on ? 'bg-accent font-semibold text-on-accent' : d === today ? 'ring-1 ring-accent' : 'hover:bg-hover'} ${inMonth || on ? '' : 'text-faint'}`}>
              {Number(d.slice(8))}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** Analog dial: pick the hour (tap or drag), then it flips to minutes. */
function ClockPicker({ value, onChange }: { value: string; onChange: (hhmm: string) => void }) {
  const { h12, m, pm } = splitTime(value)
  const [mode, setMode] = useState<'hour' | 'minute'>('hour')
  const dragging = useRef(false)
  const svg = useRef<SVGSVGElement>(null)
  const R = 88, C = 110
  const set = (h: number, min: number, p: boolean) => onChange(joinTime(h, min, p))
  const pick = (e: PointerEvent<SVGSVGElement>) => {
    const r = svg.current!.getBoundingClientRect()
    const v = dialValue(e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2, mode)
    if (mode === 'hour') set(v === 0 ? 12 : v, m, pm)
    else set(h12, v, pm)
  }
  const onKey = (e: KeyboardEvent) => {
    const d = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? -1 : 0
    if (!d) return
    e.preventDefault()
    if (mode === 'hour') set(((h12 - 1 + d + 12) % 12) + 1, m, pm)
    else set(h12, (m + d + 60) % 60, pm)
  }
  const sel = mode === 'hour' ? h12 % 12 : m
  const angle = ((mode === 'hour' ? sel * 30 : sel * 6) - 90) * (Math.PI / 180)
  const labels = mode === 'hour' ? [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] : [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]
  const seg = (on: boolean) => `rounded-lg px-2 py-0.5 ${on ? 'bg-accent-soft text-accent' : 'hover:bg-hover'}`

  return (
    <div className="flex flex-col items-center">
      <div className="mb-2 flex items-center gap-1 text-3xl font-semibold tabular-nums">
        <button type="button" className={seg(mode === 'hour')} aria-label="Set the hour" onClick={() => setMode('hour')}>{String(h12).padStart(2, '0')}</button>
        <span className="text-faint">:</span>
        <button type="button" className={seg(mode === 'minute')} aria-label="Set the minutes" onClick={() => setMode('minute')}>{String(m).padStart(2, '0')}</button>
        <div className="ml-2 flex flex-col gap-0.5 text-xs font-medium">
          <button type="button" aria-pressed={!pm} className={`rounded px-1.5 py-0.5 ${!pm ? 'bg-accent text-on-accent' : 'bg-panel hover:bg-hover'}`} onClick={() => set(h12, m, false)}>AM</button>
          <button type="button" aria-pressed={pm} className={`rounded px-1.5 py-0.5 ${pm ? 'bg-accent text-on-accent' : 'bg-panel hover:bg-hover'}`} onClick={() => set(h12, m, true)}>PM</button>
        </div>
      </div>
      <svg ref={svg} viewBox="0 0 220 220" className="size-[220px] touch-none select-none outline-none" tabIndex={0} role="slider"
        aria-label={mode === 'hour' ? 'Hour' : 'Minutes'} aria-valuenow={mode === 'hour' ? h12 : m} aria-valuemin={mode === 'hour' ? 1 : 0} aria-valuemax={mode === 'hour' ? 12 : 59}
        onKeyDown={onKey}
        onPointerDown={(e) => { dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId); pick(e) }}
        onPointerMove={(e) => { if (dragging.current) pick(e) }}
        onPointerUp={() => { dragging.current = false; if (mode === 'hour') setMode('minute') }}
        onPointerCancel={() => { dragging.current = false }}>
        <circle cx={C} cy={C} r={104} style={{ fill: 'var(--panel)' }} />
        <line x1={C} y1={C} x2={C + Math.cos(angle) * R} y2={C + Math.sin(angle) * R} style={{ stroke: 'var(--accent)' }} strokeWidth={2} />
        <circle cx={C} cy={C} r={3.5} style={{ fill: 'var(--accent)' }} />
        <circle cx={C + Math.cos(angle) * R} cy={C + Math.sin(angle) * R} r={16} style={{ fill: 'var(--accent)' }} />
        {labels.map((v, i) => {
          const a = (i * 30 - 90) * (Math.PI / 180)
          const on = mode === 'hour' ? v % 12 === sel : v === sel
          return (
            <text key={v} x={C + Math.cos(a) * R} y={C + Math.sin(a) * R} textAnchor="middle" dominantBaseline="central"
              className="text-[13px] tabular-nums" style={{ fill: on ? 'var(--on-accent)' : 'var(--ink)' }}>
              {mode === 'hour' ? v : String(v).padStart(2, '0')}
            </text>
          )
        })}
      </svg>
    </div>
  )
}

/**
 * Due date + time picker: a month calendar and a clock dial. Nothing is saved until OK;
 * Cancel (or closing) leaves the task as it was. `timeOnly` = just the clock.
 */
export function DueDialog({ open, date, time, tz, onOk, onClose, timeOnly, title = 'Due' }: {
  open: boolean; date: string | null; time: string | null; tz: string
  onOk: (date: string | null, time: string | null) => void; onClose: () => void
  timeOnly?: boolean; title?: string
}) {
  const today = todayKey(tz)
  const [d, setD] = useState(date)
  const [t, setT] = useState(time)
  const [tab, setTab] = useState<'date' | 'time'>(timeOnly ? 'time' : 'date')
  // each opening starts from the saved values
  useEffect(() => {
    if (!open) return
    setD(date); setT(time); setTab(timeOnly ? 'time' : 'date')
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const startTime = () => { setT(t ?? '09:00'); if (!d && !timeOnly) setD(today); setTab('time') }
  const summary = timeOnly ? (t ? formatTimeOfDay(t) : 'No time') : d ? `${formatDueDate(d, tz)}${t ? ` · ${formatTimeOfDay(t)}` : ''}` : 'No date'
  const tabCls = (on: boolean) => `flex-1 rounded-xl px-3 py-2 text-sm ${on ? 'bg-accent-soft font-medium text-accent' : 'hover:bg-hover'}`

  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-base font-semibold">{title}</h2>
        <span className="text-sm text-muted">{summary}</span>
      </div>
      {!timeOnly && (
        <div className="mb-3 flex gap-1" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'date'} className={tabCls(tab === 'date')} onClick={() => setTab('date')}>Date</button>
          <button type="button" role="tab" aria-selected={tab === 'time'} className={tabCls(tab === 'time')} onClick={() => (t ? setTab('time') : startTime())}>Time</button>
        </div>
      )}

      {tab === 'date' ? (
        <>
          <div className="mb-3 flex flex-wrap gap-1.5">
            {([['Today', today], ['Tomorrow', addDays(today, 1)], ['Next week', addDays(today, 7)]] as const).map(([l, k]) => (
              <button key={l} type="button" className={chip(d === k)} onClick={() => setD(k)}>{l}</button>
            ))}
          </div>
          <MonthPicker value={d} today={today} onPick={setD} />
        </>
      ) : (
        <>
          {t ? <ClockPicker value={t} onChange={setT} /> : (
            <div className="flex justify-center py-10"><button type="button" className={chip(false)} onClick={startTime}>Add a time</button></div>
          )}
          {t && <div className="mt-2 text-center"><button type="button" className="text-sm text-muted hover:text-ink" onClick={() => setT(null)}>No time</button></div>}
        </>
      )}

      <div className="mt-5 flex items-center gap-2">
        {!timeOnly && (date || d) && <button type="button" className="rounded-xl px-3 py-2 text-sm text-muted hover:bg-hover" onClick={() => { setD(null); setT(null) }}>Clear</button>}
        <div className="flex-1" />
        <button type="button" className="rounded-xl px-4 py-2 text-sm hover:bg-hover" onClick={onClose}>Cancel</button>
        <button type="button" className="rounded-xl bg-accent px-5 py-2 text-sm font-medium text-on-accent"
          onClick={() => { onOk(timeOnly ? date : d, (timeOnly || d) ? t : null); onClose() }}>OK</button>
      </div>
    </Dialog>
  )
}
