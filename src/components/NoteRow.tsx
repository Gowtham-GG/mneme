import { Link } from 'react-router-dom'
import type { NoteListItem } from '@/types/db'
import { displayTitle, previewText, splitHighlight } from '@/lib/text'
import { formatTime } from '@/lib/dates'
import { IconStarFill, IconTasks } from './icons'
import { TypeGlyph } from './TypeChip'

interface Props {
  note: NoteListItem
  tz: string
  selected?: boolean
  /** Show HH:mm (timeline) or nothing */
  showTime?: boolean
  /** search snippets carry «hit» markers */
  highlight?: boolean
  to?: string
  /** instant to display instead of created_at (e.g. updated_at when sorting by edit time) */
  time?: string
  /** multi-select mode (Notes/Search bulk actions): shows a checkbox, clicking the row toggles instead of navigating */
  selectMode?: boolean
  checked?: boolean
  onToggleCheck?: () => void
}

export function NoteRow({ note, tz, selected, showTime = true, highlight, to, time, selectMode, checked, onToggleCheck }: Props) {
  const title = displayTitle(note)
  const preview = highlight ? null : previewText(note)
  return (
    <Link
      to={to ?? `/n/${note.public_id}`}
      aria-current={selected ? 'true' : undefined}
      onClick={selectMode ? (e) => { e.preventDefault(); onToggleCheck?.() } : undefined}
      className={`group flex gap-3 rounded-2xl px-3.5 py-3 no-underline hover:no-underline ${selected ? 'bg-accent-soft shadow-[inset_0_1px_0_var(--glass-hi)]' : 'hover:bg-hover'}`}
    >
      {selectMode && (
        <input
          type="checkbox" checked={!!checked} onChange={onToggleCheck} onClick={(e) => e.stopPropagation()}
          aria-label={`Select ${title}`} className="mt-1 size-4 shrink-0 accent-[var(--accent)]"
        />
      )}
      {showTime && <span className="w-11 shrink-0 pt-0.5 text-xs tabular-nums text-faint">{formatTime(time ?? note.created_at, tz)}</span>}
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <TypeGlyph type={note.note_type} />
          <span className="truncate font-semibold text-ink">{title}</span>
          {note.is_starred && <IconStarFill size={13} className="shrink-0 text-important" aria-label="Starred" />}
          {!!note.open_tasks && <span className="shrink-0 rounded-full bg-task-soft px-1.5 text-[11px] text-task" title={`${note.open_tasks} open task(s)`}><IconTasks size={11} className="-mt-0.5 mr-0.5 inline" />{note.open_tasks}</span>}
        </span>
        {highlight
          ? <span className="mt-0.5 line-clamp-2 block text-sm text-muted">{splitHighlight(note.snippet).map((s, i) => s.hit ? <mark key={i}>{s.text}</mark> : <span key={i}>{s.text}</span>)}</span>
          : preview && <span className="mt-0.5 line-clamp-2 block text-sm text-muted">{preview}</span>}
        <span className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-faint">
          <span className="tabular-nums">{note.public_id}</span>
          {note.tags.slice(0, 3).map((t) => <span key={t} className="text-accent/80">#{t}</span>)}
          {note.tags.length > 3 && <span>+{note.tags.length - 3}</span>}
        </span>
      </span>
    </Link>
  )
}
