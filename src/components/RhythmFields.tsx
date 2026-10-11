import { useState } from 'react'
import { Dialog } from '@/components/Dialog'
import { EVERY_DAY, type Rhythm, type StepRhythm } from '@/api/habits'

const DAY_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

export const inputCls = 'rounded-lg border border-line bg-bg px-2.5 py-1.5 text-sm'

/** Seven toggles, Monday first; at least one day always stays on. Days outside `allowed` can't be picked. */
export function DayPicker({ value, onChange, allowed = EVERY_DAY }: { value: number; onChange: (days: number) => void; allowed?: number }) {
  return (
    <div className="flex gap-1" role="group" aria-label="Days">
      {DAY_LETTERS.map((l, i) => {
        const bit = 1 << i
        const on = (value & bit) !== 0
        const off = (allowed & bit) === 0
        return (
          <button
            key={i} type="button" aria-pressed={on} aria-label={DAY_NAMES[i]} disabled={off}
            onClick={() => { const next = value ^ bit; if (next) onChange(next) }}
            className={`size-7 rounded-full text-xs font-medium disabled:opacity-30 ${on ? 'bg-accent text-on-accent' : 'border border-line text-faint enabled:hover:bg-hover'}`}
          >{l}</button>
        )
      })}
    </div>
  )
}

type RhythmProps = {
  open: boolean; title: string; initial: Rhythm | null; steps?: boolean
  onClose: () => void; onSave: (r: Rhythm) => void; onStop?: () => void
}

/** Days + daily target + unit for a task that repeats. `steps` hides the count (a routine counts its steps). */
export function RhythmDialog(p: RhythmProps) {
  return (
    <Dialog open={p.open} onClose={p.onClose} title={p.initial ? 'Rhythm' : 'Make it a habit'} closable>
      <RhythmForm {...p} />
    </Dialog>
  )
}

// mounted only while the dialog is open, so every opening starts from `initial`
function RhythmForm({ title, initial, steps, onClose, onSave, onStop }: RhythmProps) {
  const [days, setDays] = useState(initial?.rhythm_days ?? EVERY_DAY)
  const [target, setTarget] = useState(String(initial?.rhythm_target ?? 1))
  const [unit, setUnit] = useState(initial?.rhythm_unit ?? '')
  const save = () => {
    onSave({ rhythm_days: days, rhythm_target: Math.min(1000, Math.max(1, Number(target) || 1)), rhythm_unit: unit.trim() || null })
    onClose()
  }
  return (
    <>
      <h2 className="mb-1 pr-8 text-base font-semibold">{initial ? 'Rhythm' : 'Make it a habit'}</h2>
      <p className="mb-4 line-clamp-1 text-sm text-faint">{title}</p>
      <div className="grid gap-3">
        <DayPicker value={days} onChange={setDays} />
        {!steps && (
          <div className="flex items-center gap-2 text-sm">
            <input value={target} inputMode="numeric" aria-label="Daily target" onChange={(e) => setTarget(e.target.value.replace(/\D/g, ''))}
              className={`${inputCls} w-16 text-center tabular-nums`} />
            <input value={unit} aria-label="Unit" placeholder="unit" maxLength={20} onChange={(e) => setUnit(e.target.value)} className={`${inputCls} w-28`} />
            <span className="text-xs text-faint">a day</span>
          </div>
        )}
      </div>
      <div className="mt-5 flex items-center justify-end gap-2">
        {onStop && <button className="mr-auto rounded-xl px-3 py-2 text-sm text-muted hover:bg-hover hover:text-danger" onClick={() => { onStop(); onClose() }}>Stop repeating</button>}
        <button className="rounded-xl px-4 py-2 text-sm hover:bg-hover" onClick={onClose}>Cancel</button>
        <button className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-on-accent" onClick={save}>Save</button>
      </div>
    </>
  )
}

type StepProps = {
  open: boolean; title: string; initial: StepRhythm; /** the days its parent is on */ allowed: number; /** has steps of its own: no count */ group: boolean
  onClose: () => void; onSave: (r: StepRhythm) => void
}

/** A habit's step: its own days within its parent's (all of them = follow the parent), and a count like "3 sets". */
export function StepRhythmDialog(p: StepProps) {
  return (
    <Dialog open={p.open} onClose={p.onClose} title="Days & count" closable>
      <StepForm {...p} />
    </Dialog>
  )
}

function StepForm({ title, initial, allowed, group, onClose, onSave }: StepProps) {
  const [days, setDays] = useState((initial.step_days ?? allowed) & allowed || allowed)
  const [target, setTarget] = useState(String(initial.rhythm_target))
  const [unit, setUnit] = useState(initial.rhythm_unit ?? '')
  const save = () => {
    onSave({
      step_days: days === allowed ? null : days,
      rhythm_target: group ? initial.rhythm_target : Math.min(1000, Math.max(1, Number(target) || 1)),
      rhythm_unit: group ? initial.rhythm_unit : unit.trim() || null,
    })
    onClose()
  }
  return (
    <>
      <h2 className="mb-1 pr-8 text-base font-semibold">Days & count</h2>
      <p className="mb-4 line-clamp-1 text-sm text-faint">{title}</p>
      <div className="grid gap-3">
        <div>
          <DayPicker value={days} allowed={allowed} onChange={setDays} />
          <p className="mt-1.5 text-xs text-faint">{days === allowed ? 'Same days as the step above it' : 'Only on these days'}</p>
        </div>
        {!group && (
          <div className="flex items-center gap-2 text-sm">
            <input value={target} inputMode="numeric" aria-label="Count" onChange={(e) => setTarget(e.target.value.replace(/\D/g, ''))}
              className={`${inputCls} w-16 text-center tabular-nums`} />
            <input value={unit} aria-label="Unit" placeholder="sets, reps…" maxLength={20} onChange={(e) => setUnit(e.target.value)} className={`${inputCls} w-28`} />
            <span className="text-xs text-faint">each time</span>
          </div>
        )}
      </div>
      <div className="mt-5 flex items-center justify-end gap-2">
        <button className="rounded-xl px-4 py-2 text-sm hover:bg-hover" onClick={onClose}>Cancel</button>
        <button className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-on-accent" onClick={save}>Save</button>
      </div>
    </>
  )
}

type NoteProps = { open: boolean; title: string; initial: string; onClose: () => void; onSave: (note: string) => void }

/** The day's one-line note on a habit. */
export function CheckinNoteDialog(p: NoteProps) {
  return (
    <Dialog open={p.open} onClose={p.onClose} title="Note for today" closable>
      <NoteForm {...p} />
    </Dialog>
  )
}

function NoteForm({ title, initial, onClose, onSave }: NoteProps) {
  const [v, setV] = useState(initial)
  return (
    <>
      <h2 className="mb-1 pr-8 text-base font-semibold">Note for today</h2>
      <p className="mb-3 line-clamp-1 text-sm text-faint">{title}</p>
      <form onSubmit={(e) => { e.preventDefault(); onSave(v); onClose() }}>
        <input autoFocus value={v} maxLength={500} placeholder="What stuck?" aria-label="Note" onChange={(e) => setV(e.target.value)}
          className="w-full rounded-xl border border-line bg-bg px-3 py-2 text-sm outline-none focus:border-accent" />
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="rounded-xl px-4 py-2 text-sm hover:bg-hover" onClick={onClose}>Cancel</button>
          <button className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-on-accent">Save</button>
        </div>
      </form>
    </>
  )
}
