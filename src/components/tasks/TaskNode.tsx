import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useSettings } from '@/contexts/SettingsContext'
import { childrenOf, isResolved, linksOf, STATES, type LinkEnd } from '@/lib/taskTree'
import { DuePicker, PriorityPicker } from './pickers'
import { useTaskTree, useTaskUi } from './TaskUi'
import type { TaskItem, TaskSequence, TaskTree } from '@/types/db'
import { IconCheck, IconChevron, IconEdit, IconLock, IconMore, IconSteps, IconX } from '@/components/icons'

/** Task id to ring (and scroll to) inside a whole-tree view. */
// eslint-disable-next-line react-refresh/only-export-components
export const HighlightContext = createContext<string | null>(null)

// Row actions stay visible on touch screens; only devices that can hover hide them until hover/focus.
export const ROW_ACTION = 'rounded p-1 text-faint hover:bg-hover focus:opacity-100 group-focus-within/row:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/row:opacity-100'

const STATE_PILL: Partial<Record<TaskItem['state'], string>> = {
  in_progress: 'bg-accent-soft text-accent',
  on_hold: 'bg-important-soft text-important',
  cancelled: 'bg-panel text-faint',
}
const pill = 'rounded px-1.5 py-px text-[11px] leading-4'

function StatusBox({ t }: { t: TaskItem }) {
  const ui = useTaskUi()
  const resolved = isResolved(t.state)
  if (t.blocked) {
    return <span className="mt-[3px] inline-flex size-4 shrink-0 items-center justify-center text-faint" title="Blocked — waiting on what comes first" aria-label="Blocked"><IconLock size={15} /></span>
  }
  const waiting = !resolved && t.child_count > t.child_resolved
  return (
    <button
      type="button" role="checkbox" aria-checked={resolved}
      aria-label={`${resolved ? 'Reopen' : 'Complete'}: ${t.title}`}
      title={waiting ? 'Finishes when its subtasks do' : undefined}
      disabled={waiting}
      onClick={() => void ui.act.tick(t, !resolved)}
      className={`mt-[3px] inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] border disabled:opacity-40 ${
        t.state === 'done' ? 'border-task bg-task text-bg' : t.state === 'cancelled' ? 'border-faint text-faint' : t.state === 'in_progress' ? 'border-accent' : 'border-faint hover:border-task'}`}
    >
      {t.state === 'done' && <IconCheck size={12} strokeWidth={3} />}
      {t.state === 'cancelled' && <IconX size={11} strokeWidth={2.5} />}
      {t.state === 'in_progress' && <span className="size-1.5 rounded-full bg-accent" />}
    </button>
  )
}

function LinkChip({ end, label, onRemove }: { end: LinkEnd; label: string; onRemove: () => void }) {
  const ui = useTaskUi()
  return (
    <span className={`${pill} inline-flex max-w-full items-center gap-1 bg-panel text-muted`}>
      <button className={`truncate ${isResolved(end.state) ? 'line-through' : ''}`} onClick={() => ui.openTree(end.rootId, end.id)}>{label} {end.title}</button>
      <button aria-label={`Remove link to ${end.title}`} className="text-faint hover:text-danger" onClick={onRemove}><IconX size={10} strokeWidth={2.5} /></button>
    </span>
  )
}

function AddInline({ placeholder, onAdd, onDone, allowEmpty }: { placeholder: string; onAdd: (v: string) => Promise<unknown> | void; onDone: () => void; allowEmpty?: boolean }) {
  const [v, setV] = useState('')
  const submit = async () => {
    const x = v.trim()
    if (!x && !allowEmpty) return onDone()
    await onAdd(x)
    setV('')
    if (allowEmpty) onDone()
  }
  return (
    <input
      autoFocus value={v} maxLength={500} placeholder={placeholder} aria-label={placeholder}
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void submit() } else if (e.key === 'Escape') onDone() }}
      onBlur={() => { if (!v.trim()) onDone() }}
      className="my-1 ml-7 w-[calc(100%-2rem)] rounded-lg border border-line bg-bg px-2 py-1 text-sm outline-none focus:border-accent"
    />
  )
}

interface NodeProps {
  t: TaskItem
  /** The tree this node is drawn from; absent for a row in a flat list (fetched when expanded). */
  tree?: TaskTree
  depth?: number
  /** 1-based position when the task is a step of a sequence. */
  step?: number
  siblings?: TaskItem[]
  parentSeqs?: TaskSequence[]
}

export function TaskNode({ t, tree, depth = 0, step, siblings, parentSeqs }: NodeProps) {
  const ui = useTaskUi()
  const { timezone: tz } = useSettings()
  const highlight = useContext(HighlightContext)
  const flat = !tree
  const [open, setOpen] = useState(!flat)
  const [adding, setAdding] = useState<null | 'sub' | 'seq'>(null)
  // a just-created sequence opens its first-step input; kept here so a refetch can't lose it
  const [newSeq, setNewSeq] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const own = useTaskTree(t.root_id, flat && open)
  const data = tree ?? own.data
  const ref = useRef<HTMLLIElement>(null)
  const lit = highlight === t.id
  useEffect(() => { if (lit) ref.current?.scrollIntoView({ block: 'center' }) }, [lit])

  const resolved = isResolved(t.state)
  // an empty sequence has no subtasks yet but is still structure to show
  const hasKids = t.child_count > 0 || !!data?.sequences.some((q) => q.task_id === t.id)
  const links = linksOf(data, t.id)
  // the pill marks where a block starts; its subtasks (and later steps) just show the lock
  const parentBlocked = !!data?.tasks.find((x) => x.id === t.parent_id)?.blocked
  const canvases = t.parent_id ? [] : ui.canvasNames(t.id)
  const save = () => {
    setEditing(false)
    const v = draft.trim()
    if (v && v !== t.title) void ui.act.rename(t, v)
  }
  const startAdd = (k: 'sub' | 'seq') => { setOpen(true); setAdding(k) }

  return (
    <li ref={ref}>
      <div className={`group/row rounded-lg px-2 py-1.5 hover:bg-hover ${lit ? 'ring-2 ring-accent' : ''}`}>
        <div className="flex items-start gap-2">
          {hasKids ? (
            <button aria-label={open ? 'Collapse' : 'Expand'} aria-expanded={open} onClick={() => setOpen((v) => !v)}
              className="-ml-1 mt-[1px] shrink-0 rounded p-0.5 text-faint hover:text-ink">
              <IconChevron size={14} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
            </button>
          ) : <span className="-ml-1 w-[18px] shrink-0" aria-hidden />}
          <StatusBox t={t} />
          {step !== undefined && <span className="mt-px w-4 shrink-0 text-right text-xs tabular-nums text-faint">{step}.</span>}
          <div className="min-w-0 flex-1">
            {editing ? (
              <input autoFocus value={draft} maxLength={500} aria-label="Task text" onChange={(e) => setDraft(e.target.value)} onBlur={save}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save() } else if (e.key === 'Escape') setEditing(false) }}
                className="w-full rounded border border-line bg-bg px-1.5 py-0.5 text-[15px] outline-none focus:border-accent" />
            ) : (
              <div className={`text-[15px] leading-snug ${resolved ? 'text-faint line-through' : t.blocked ? 'text-muted' : ''}`}>{t.title}</div>
            )}
          </div>
          {!resolved && t.priority && <PriorityPicker priority={t.priority} onChange={(p) => void ui.act.priority(t, p)} />}
          {!resolved && <DuePicker task={t} tz={tz} compact onChange={(d, time) => void ui.act.due(t, d, time)} />}
          {!editing && (
            <button aria-label={`Edit task: ${t.title}`} title={t.source === 'note' ? 'Edit (updates the line in its note)' : 'Edit'}
              className={`${ROW_ACTION} hover:text-ink`} onClick={() => { setDraft(t.title); setEditing(true) }}><IconEdit size={16} /></button>
          )}
          <button aria-label={`More for: ${t.title}`} className={`${ROW_ACTION} hover:text-ink`}
            onClick={() => ui.openMenu({ t, tree: data, siblings, parentSeqs, onAddSub: () => startAdd('sub'), onAddSeq: () => startAdd('seq') })}><IconMore size={16} /></button>
          <button aria-label={`Delete task: ${t.title}`} title={t.source === 'note' ? 'Delete (removes the line from its note)' : 'Delete'}
            className={`${ROW_ACTION} hover:text-danger`} onClick={() => ui.act.del(t)}><IconX size={16} /></button>
        </div>
        {/* full row width, aligned under the title */}
        <div className="mt-0.5 flex flex-wrap items-center gap-1 empty:hidden" style={{ paddingLeft: step === undefined ? 46 : 70 }}>
          {flat && t.parent_title && (
            <button className="text-xs text-faint hover:text-accent" onClick={() => ui.openTree(t.root_id, t.id)}>↳ {t.parent_title}</button>
          )}
          {t.note_public_id && (
            <Link to={`/n/${t.note_public_id}`} className="text-xs text-faint no-underline hover:text-accent">
              <span className="tabular-nums">{t.note_public_id}</span>{t.note_title ? ` · ${t.note_title}` : ''}
            </Link>
          )}
          {STATE_PILL[t.state] && <span className={`${pill} ${STATE_PILL[t.state]}`}>{STATES.find((s) => s.id === t.state)?.label}</span>}
          {t.blocked && !parentBlocked && !t.sequence_id && <span className={`${pill} bg-panel text-faint`}>Blocked</span>}
          {t.child_count > 0 && <span className={`${pill} bg-task-soft tabular-nums text-task`}>{t.child_resolved}/{t.child_count}</span>}
          {canvases.map((c) => <span key={c} className={`${pill} bg-accent-soft text-accent`}>{c}</span>)}
          {links.after.map((e) => <LinkChip key={e.link.id} end={e} label="after" onRemove={() => void ui.act.unlink(e.link.id)} />)}
          {links.before.map((e) => <LinkChip key={e.link.id} end={e} label="before" onRemove={() => void ui.act.unlink(e.link.id)} />)}
          {links.related.map((e) => <LinkChip key={e.link.id} end={e} label="↔" onRemove={() => void ui.act.unlink(e.link.id)} />)}
        </div>
      </div>
      {open && (hasKids || adding) && (
        data || !hasKids
          ? <TaskChildren tree={data} parent={t} depth={depth} adding={adding} setAdding={setAdding} newSeq={newSeq} setNewSeq={setNewSeq} />
          : <div className="skeleton ml-7 h-8" />
      )}
    </li>
  )
}

function TaskChildren({ tree, parent, depth, adding, setAdding, newSeq, setNewSeq }: {
  tree: TaskTree | undefined; parent: TaskItem; depth: number
  adding: null | 'sub' | 'seq'; setAdding: (v: null | 'sub' | 'seq') => void
  newSeq: string | null; setNewSeq: (id: string | null) => void
}) {
  const ui = useTaskUi()
  const { sequences, loose } = childrenOf(tree, parent.id)
  const seqs = sequences.map((s) => s.seq)
  return (
    <div className="ml-[1.05rem] border-l border-line pl-1 sm:pl-2">
      {sequences.map(({ seq, steps }) => (
        <SequenceBlock key={seq.id} seq={seq} steps={steps} tree={tree} depth={depth} startAdding={newSeq === seq.id} onStarted={() => setNewSeq(null)} />
      ))}
      {loose.length > 0 && (
        <ul>{loose.map((k) => <TaskNode key={k.id} t={k} tree={tree} depth={depth + 1} siblings={loose} parentSeqs={seqs} />)}</ul>
      )}
      {adding === 'sub' && <AddInline placeholder="Subtask" onAdd={(v) => ui.act.addSub(parent.id, v)} onDone={() => setAdding(null)} />}
      {adding === 'seq' && (
        <AddInline placeholder="Sequence name (optional)" allowEmpty onDone={() => setAdding(null)}
          onAdd={async (v) => { const id = await ui.act.addSeq(parent.id, v || null); if (id) setNewSeq(id) }} />
      )}
      {!adding && parent.source === 'standalone' && (
        <div className="flex gap-3 py-0.5 pl-7 text-xs text-faint">
          <button className="hover:text-accent" onClick={() => setAdding('sub')}>+ Subtask</button>
          <button className="hover:text-accent" onClick={() => setAdding('seq')}>+ Sequence</button>
        </div>
      )}
    </div>
  )
}

function SequenceBlock({ seq, steps, tree, depth, startAdding, onStarted }: { seq: TaskSequence; steps: TaskItem[]; tree: TaskTree | undefined; depth: number; startAdding: boolean; onStarted: () => void }) {
  const ui = useTaskUi()
  const [adding, setAdding] = useState(startAdding)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  useEffect(() => { if (startAdding) { setAdding(true); onStarted() } }, [startAdding, onStarted])
  const done = steps.filter((s) => isResolved(s.state)).length
  const save = () => {
    setEditing(false)
    if (draft.trim() !== (seq.title ?? '')) void ui.act.renameSeq(seq.id, draft)
  }
  return (
    <div className="mt-0.5">
      <div className="group/row flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-muted hover:bg-hover">
        <IconSteps size={14} className="ml-[18px] shrink-0 text-faint" />
        {editing ? (
          <input autoFocus value={draft} maxLength={200} aria-label="Sequence name" placeholder="Sequence" onChange={(e) => setDraft(e.target.value)} onBlur={save}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save() } else if (e.key === 'Escape') setEditing(false) }}
            className="min-w-0 flex-1 rounded border border-line bg-bg px-1.5 py-0.5 text-xs outline-none focus:border-accent" />
        ) : (
          <span className="min-w-0 flex-1 truncate font-medium">{seq.title || 'Sequence'} <span className="font-normal tabular-nums text-faint">{done}/{steps.length}</span></span>
        )}
        <button aria-label="Add step" className={`${ROW_ACTION} hover:text-ink`} onClick={() => setAdding(true)}>+</button>
        {!editing && <button aria-label="Rename sequence" className={`${ROW_ACTION} hover:text-ink`} onClick={() => { setDraft(seq.title ?? ''); setEditing(true) }}><IconEdit size={14} /></button>}
        <button aria-label="Delete sequence" className={`${ROW_ACTION} hover:text-danger`} onClick={() => ui.act.delSeq(seq, steps.length)}><IconX size={14} /></button>
      </div>
      <ol>{steps.map((s, i) => <TaskNode key={s.id} t={s} tree={tree} depth={depth + 1} step={i + 1} siblings={steps} />)}</ol>
      {adding && <AddInline placeholder={`Step ${steps.length + 1}`} onAdd={(v) => ui.act.addSub(seq.task_id, v, seq.id)} onDone={() => setAdding(false)} />}
    </div>
  )
}
