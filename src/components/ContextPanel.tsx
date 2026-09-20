import { useState } from 'react'
import { Link } from 'react-router-dom'
import { formatDueDate, formatLongDate } from '@/lib/dates'
import { displayTitle } from '@/lib/text'
import type { LinkedNote, NoteContext } from '@/types/db'
import { IconPlus, IconX } from './icons'

interface Props {
  ctx: NoteContext | undefined
  tz: string
  publicId: string | null
  createdAt: string
  updatedAt: string
  paperRef: string
  onPaperRef: (v: string) => void
  onAddTag: (name: string) => void
  onRemoveTag: (t: NoteContext['tags'][number]) => void
  onToggleTask: (line: number, done: boolean) => void
  disabled?: boolean
}

function Section({ title, children, empty }: { title: string; children: React.ReactNode; empty?: string }) {
  return (
    <section className="mb-5">
      <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint">{title}</h3>
      {children ?? <p className="text-sm text-faint">{empty}</p>}
    </section>
  )
}

function LinkList({ items, arrow }: { items: LinkedNote[]; arrow: string }) {
  if (!items.length) return <p className="text-sm text-faint">None yet</p>
  return (
    <ul className="space-y-1">
      {items.map((l) => (
        <li key={l.link_id}>
          <Link to={`/n/${l.public_id}`} className="group flex items-baseline gap-1.5 rounded px-1 py-0.5 text-sm no-underline hover:bg-hover">
            <span className="text-faint">{arrow}</span>
            <span className="min-w-0 flex-1 truncate">{displayTitle({ title: l.title })}</span>
            <span className="shrink-0 text-xs tabular-nums text-faint">{l.public_id}</span>
          </Link>
        </li>
      ))}
    </ul>
  )
}

export function ContextPanel({ ctx, tz, publicId, createdAt, updatedAt, paperRef, onPaperRef, onAddTag, onRemoveTag, onToggleTask, disabled }: Props) {
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const submit = () => { const v = draft.trim(); if (v) onAddTag(v); setDraft(''); setAdding(false) }

  return (
    <div className="text-sm">
      <Section title="Tags">
        <div className="flex flex-wrap items-center gap-1.5">
          {(ctx?.tags ?? []).map((t) => (
            <span key={t.id} className="inline-flex items-center gap-0.5 rounded-full bg-accent-soft py-0.5 pl-2.5 pr-1 text-xs text-accent">
              <Link to={`/tags/${t.name}`} className="no-underline">#{t.name}</Link>
              <button aria-label={`Remove tag ${t.name}`} disabled={disabled} className="rounded-full p-0.5 hover:bg-hover" onClick={() => onRemoveTag(t)}><IconX size={12} /></button>
            </span>
          ))}
          {adding ? (
            <input
              autoFocus value={draft} aria-label="New tag"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit() } else if (e.key === 'Escape') { setAdding(false); setDraft('') } }}
              onBlur={submit}
              placeholder="tag"
              className="w-28 rounded-full border border-line bg-raised px-2.5 py-0.5 text-xs outline-none"
            />
          ) : (
            <button disabled={disabled} className="inline-flex items-center gap-0.5 rounded-full border border-dashed border-line px-2 py-0.5 text-xs text-muted hover:bg-hover" onClick={() => setAdding(true)}>
              <IconPlus size={12} /> tag
            </button>
          )}
        </div>
      </Section>

      <Section title="Links to"><LinkList items={ctx?.links_to ?? []} arrow="→" /></Section>
      <Section title="Referenced by"><LinkList items={ctx?.linked_from ?? []} arrow="←" /></Section>

      <Section title="Tasks">
        {(ctx?.tasks ?? []).length ? (
          <ul className="space-y-1">
            {ctx!.tasks.map((t) => (
              <li key={t.id} className="flex items-start gap-2">
                <input
                  type="checkbox" checked={t.status === 'done'} disabled={disabled}
                  aria-label={`Task: ${t.title}`}
                  onChange={(e) => onToggleTask(t.position, e.target.checked)}
                  className="mt-1 accent-[var(--task)]"
                />
                <span className={t.status === 'done' ? 'text-faint line-through' : ''}>
                  {t.title}
                  {t.due_date && <span className="ml-1.5 rounded bg-task-soft px-1 text-xs text-task">{formatDueDate(t.due_date, tz)}</span>}
                </span>
              </li>
            ))}
          </ul>
        ) : <p className="text-faint">Write <code className="rounded bg-panel px-1">- [ ] something</code> to add one</p>}
      </Section>

      <Section title="Paper reference">
        <input
          value={paperRef} onChange={(e) => onPaperRef(e.target.value)} disabled={disabled}
          aria-label="Paper notebook reference" placeholder="e.g. N1-042 (optional)" maxLength={64}
          className="w-full rounded-xl border border-line bg-raised px-3 py-2 text-sm outline-none"
        />
      </Section>

      <Section title="Details">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-muted">
          <dt>ID</dt><dd className="tabular-nums">{publicId ?? '—'}</dd>
          <dt>Created</dt><dd>{formatLongDate(createdAt, tz)}</dd>
          <dt>Edited</dt><dd>{formatLongDate(updatedAt, tz)}</dd>
        </dl>
      </Section>
    </div>
  )
}
