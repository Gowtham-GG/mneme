import { NOTE_TYPE_LABEL, SETTABLE_NOTE_TYPES, type NoteType } from '@/types/db'

export const TYPE_GLYPH: Record<NoteType, string> = { capture: '○', knowledge: '◆', question: '?', idea: '✦', meeting: '◐', reference: '❡', journal: '✎' }
export const TYPE_TONE: Record<NoteType, string> = {
  capture: 'text-faint', knowledge: 'text-accent', question: 'text-question', idea: 'text-important', meeting: 'text-muted', reference: 'text-muted', journal: 'text-accent',
}

export function TypeGlyph({ type }: { type: NoteType }) {
  return <span className={`inline-block w-4 text-center text-sm leading-none ${TYPE_TONE[type]}`} title={NOTE_TYPE_LABEL[type]} aria-label={NOTE_TYPE_LABEL[type]}>{TYPE_GLYPH[type]}</span>
}

/** Native <select> styled as a chip: accessible, works everywhere, zero JS menu code. */
export function TypeChip({ value, onChange }: { value: NoteType; onChange: (t: NoteType) => void }) {
  return (
    <label className="inline-flex items-center gap-1.5 rounded-full border border-line bg-raised px-3 py-1 text-xs font-medium text-ink hover:bg-hover">
      <span className={TYPE_TONE[value]} aria-hidden>{TYPE_GLYPH[value]}</span>
      <span className="sr-only">Note type</span>
      <select value={value} onChange={(e) => onChange(e.target.value as NoteType)} className="cursor-pointer appearance-none bg-transparent pr-0.5 outline-none">
        {SETTABLE_NOTE_TYPES.map((t) => <option key={t} value={t}>{NOTE_TYPE_LABEL[t]}</option>)}
      </select>
    </label>
  )
}
