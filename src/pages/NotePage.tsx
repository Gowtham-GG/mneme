import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { deleteNoteForever, fetchNoteByPublicId, markViewed, patchNote, restoreNote, setNoteType, unarchiveNote } from '@/api/notes'
import { addManualTag, noteContext, removeManualTag } from '@/api/tags'
import { ConfirmDialog } from '@/components/Dialog'
import { ConflictDialog } from '@/components/ConflictDialog'
import { ContextPanel } from '@/components/ContextPanel'
import { Editor } from '@/components/Editor'
import { HistoryDialog } from '@/components/HistoryDialog'
import { IconArchive, IconBack, IconLink, IconMore, IconNotes, IconStar, IconStarFill, IconTrash } from '@/components/icons'
import { NoteBody } from '@/components/NoteBody'
import { SaveStatus } from '@/components/SaveStatus'
import { TitleField } from '@/components/TitleField'
import { TypeChip } from '@/components/TypeChip'
import { useToast } from '@/contexts/ToastContext'
import { useSettings } from '@/contexts/SettingsContext'
import { useHotkeys } from '@/hooks/useHotkeys'
import { useIsDesktop } from '@/hooks/useMedia'
import { useNoteEditor } from '@/hooks/useNoteEditor'
import { formatLongDate } from '@/lib/dates'
import { removeInlineTag, toggleTaskInContent } from '@/lib/text'
import type { Note, NoteContext, NoteType } from '@/types/db'

/** /n/new starts a capture; /n/N-260920-042 opens an existing note. The session key keeps the editor
 *  mounted when the URL flips from /n/new to the note's real ID after its first save. */
export function NotePage() {
  const { publicId = 'new' } = useParams()
  const loc = useLocation()
  const isNew = publicId === 'new'
  const sid = isNew ? loc.key : ((loc.state as { sid?: string } | null)?.sid ?? publicId.toUpperCase())
  return <NoteSession key={sid} publicId={publicId} sid={sid} isNew={isNew} />
}

function NoteSession({ publicId, sid, isNew }: { publicId: string; sid: string; isNew: boolean }) {
  const [fresh] = useState(() => ({ id: crypto.randomUUID(), createdAt: new Date().toISOString() }))
  // A session that STARTED as a new note stays one for its whole life. After the first save the URL flips to
  // the real ID, but the editor must keep running (same instance, same caret) rather than reload the note.
  const [startedNew] = useState(isNew)
  const q = useQuery({ queryKey: ['note', publicId.toUpperCase()], queryFn: () => fetchNoteByPublicId(publicId), enabled: !startedNew, staleTime: 0, gcTime: 0 })

  if (startedNew) return <NoteEditorView id={fresh.id} initial={null} createdAt={fresh.createdAt} sid={sid} startEditing />
  if (q.isLoading) return <div className="mx-auto max-w-[44rem] space-y-4 p-10" aria-busy="true"><div className="skeleton h-9 w-2/3" /><div className="skeleton h-4" /><div className="skeleton h-4 w-11/12" /><div className="skeleton h-4 w-4/5" /></div>
  if (q.isError) return <div className="p-8 text-sm text-danger">Couldn’t open this note. Check your connection and try again.</div>
  if (!q.data) return <div className="p-8"><h1 className="text-lg font-semibold">Note not found</h1><p className="text-sm text-muted">{publicId} doesn’t exist, or it belongs to another account.</p></div>
  return <NoteEditorView id={q.data.id} initial={q.data} createdAt={q.data.created_at} sid={sid} />
}

function NoteEditorView({ id, initial, createdAt, sid, startEditing }: { id: string; initial: Note | null; createdAt: string; sid: string; startEditing?: boolean }) {
  const { timezone: tz } = useSettings()
  const { toast } = useToast()
  const nav = useNavigate()
  const qc = useQueryClient()
  const desktop = useIsDesktop()
  const [editing, setEditing] = useState(!!startEditing)
  const [meta, setMeta] = useState({
    note_type: (initial?.note_type ?? 'capture') as NoteType, is_starred: initial?.is_starred ?? false,
    archived_at: initial?.archived_at ?? null, deleted_at: initial?.deleted_at ?? null, paper_ref: initial?.paper_ref ?? '',
    updated_at: initial?.updated_at ?? createdAt,
  })
  const [menu, setMenu] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [history, setHistory] = useState(false)
  const created = useRef(false)

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['notes'] })
    void qc.invalidateQueries({ queryKey: ['inbox-count'] })
    void qc.invalidateQueries({ queryKey: ['tag-counts'] })
    void qc.invalidateQueries({ queryKey: ['note-context', id] })
  }

  const ed = useNoteEditor({
    id, initial, createdAt,
    onSaved: (n) => {
      setMeta((m) => ({ ...m, updated_at: n.updated_at }))
      refresh()
      if (!initial && !created.current) { created.current = true; nav(`/n/${n.public_id}`, { replace: true, state: { sid } }) }
    },
  })

  const ctx = useQuery({
    queryKey: ['note-context', id], queryFn: () => noteContext(id),
    enabled: !!ed.publicId, staleTime: 0,
  })
  const titleMap = useMemo(() => {
    const m = new Map<string, string>()
    for (const l of ctx.data?.links_to ?? []) if (l.title) m.set(l.title.toLowerCase(), `/n/${l.public_id}`)
    return (t: string) => m.get(t.toLowerCase())
  }, [ctx.data])

  useEffect(() => { if (initial) void markViewed(id).then(() => qc.invalidateQueries({ queryKey: ['recent-viewed'] })) }, [id, initial, qc])

  const persisted = !!ed.publicId
  const inTrash = !!meta.deleted_at

  const patch = async (p: Parameters<typeof patchNote>[1], done?: string, undo?: Parameters<typeof patchNote>[1]) => {
    if (!persisted) return
    try {
      const n = await patchNote(id, p)
      setMeta((m) => ({ ...m, note_type: n.note_type, is_starred: n.is_starred, archived_at: n.archived_at, deleted_at: n.deleted_at, paper_ref: n.paper_ref ?? '' }))
      refresh()
      if (done) toast(done, undo ? { action: { label: 'Undo', onClick: () => void patch(undo) } } : undefined)
    } catch { toast('Couldn’t update the note. Try again.', { kind: 'error' }) }
  }

  const toggleTask = (line: number, done: boolean) => ed.setContent(toggleTaskInContent(ed.content, line, done))
  const onRemoveTag = async (t: NoteContext['tags'][number]) => {
    try {
      if (t.source === 'manual') { await removeManualTag(id, t.id); void ctx.refetch(); refresh() }
      else ed.setContent(removeInlineTag(ed.content, t.name)) // inline tags live in the text
    } catch { toast('Couldn’t remove the tag.', { kind: 'error' }) }
  }

  const finish = async () => {
    await ed.flush()
    if (initial || ed.getPublicId()) setEditing(false)
    else nav(-1)
  }
  const back = () => { void ed.flush(); if (window.history.state?.idx > 0) nav(-1); else nav('/notes') }

  useHotkeys([
    { combo: 'e', handler: (e) => { if (!editing && persisted) { e.preventDefault(); setEditing(true) } } },
    { combo: 'escape', handler: () => { if (editing && persisted) void finish() }, inInputs: true },
  ])

  const copy = async (text: string, msg: string) => { try { await navigator.clipboard.writeText(text); toast(msg) } catch { toast('Couldn’t copy', { kind: 'error' }) } }

  return (
    <div className="flex h-full min-h-0 flex-col lg:flex-row">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* header */}
        <header className="header-safe relative z-20 flex items-center gap-1 border-b border-line bg-[var(--sticky)] px-2 backdrop-blur-md lg:px-4">
          <button aria-label="Back" className="rounded-xl p-2 hover:bg-hover lg:hidden" onClick={back}><IconBack /></button>
          <div className="min-w-0 flex-1 pl-1"><SaveStatus status={ed.status} error={ed.errorMsg} onRetry={ed.retryNow} /></div>
          {persisted && (
            <>
              <button aria-label={meta.is_starred ? 'Remove star' : 'Star'} aria-pressed={meta.is_starred} className={`rounded-xl p-2 hover:bg-hover ${meta.is_starred ? 'text-important' : 'text-muted'}`}
                onClick={() => void patch({ is_starred: !meta.is_starred })}>
                {meta.is_starred ? <IconStarFill /> : <IconStar />}
              </button>
              <div className="relative">
                <button aria-label="More actions" aria-haspopup="menu" aria-expanded={menu} className="rounded-xl p-2 text-muted hover:bg-hover" onClick={() => setMenu((v) => !v)}><IconMore /></button>
                {menu && (
                  <>
                    <div className="fixed inset-0 z-20" onClick={() => setMenu(false)} />
                    <div role="menu" className="pop absolute right-0 z-30 mt-1 w-56 glass-strong overflow-hidden rounded-xl py-1 shadow-xl" onClick={() => setMenu(false)}>
                      <MenuItem icon={<IconLink size={16} />} onClick={() => void copy(ed.publicId!, 'Note ID copied')}>Copy ID</MenuItem>
                      <MenuItem icon={<IconNotes size={16} />} onClick={() => setHistory(true)}>Version history…</MenuItem>
                      <MenuItem icon={<IconLink size={16} />} onClick={() => void copy(`[[${ed.publicId}|${(ed.title || 'note').replace(/[\]|]/g, ' ')}]]`, 'Link copied')}>Copy [[link]]</MenuItem>
                      {meta.archived_at
                        ? <MenuItem icon={<IconArchive size={16} />} onClick={() => void unarchiveNote(id).then(() => { setMeta((m) => ({ ...m, archived_at: null })); refresh(); toast('Moved back to your notes') })}>Unarchive</MenuItem>
                        : <MenuItem icon={<IconArchive size={16} />} onClick={() => void patch({ archived_at: new Date().toISOString() }, 'Archived', { archived_at: null })}>Archive</MenuItem>}
                      {inTrash
                        ? <MenuItem icon={<IconTrash size={16} />} onClick={() => void restoreNote(id).then(() => { setMeta((m) => ({ ...m, deleted_at: null })); refresh(); toast('Restored') })}>Restore</MenuItem>
                        : <MenuItem danger icon={<IconTrash size={16} />} onClick={() => void patch({ deleted_at: new Date().toISOString() }, 'Moved to trash', { deleted_at: null })}>Move to trash</MenuItem>}
                      {inTrash && <MenuItem danger icon={<IconTrash size={16} />} onClick={() => setConfirmDelete(true)}>Delete forever…</MenuItem>}
                    </div>
                  </>
                )}
              </div>
            </>
          )}
          {editing
            ? <button className="ml-1 rounded-xl bg-accent px-4 py-1.5 text-sm font-medium text-on-accent" onClick={() => void finish()}>Done</button>
            : <button className="ml-1 rounded-xl border border-line bg-raised px-4 py-1.5 text-sm font-medium hover:bg-hover" onClick={() => setEditing(true)}>Edit</button>}
        </header>

        {inTrash && (
          <div className="flex items-center justify-between gap-3 bg-danger-soft px-4 py-2 text-sm text-danger">
            <span>This note is in the trash.</span>
            <button className="font-medium underline" onClick={() => void restoreNote(id).then(() => { setMeta((m) => ({ ...m, deleted_at: null })); refresh(); toast('Restored') })}>Restore</button>
          </div>
        )}

        {/* body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-10 pt-6 lg:px-10 lg:pt-9">
          <div className="rise mx-auto max-w-[44rem]">
            {editing
              ? <TitleField value={ed.title} onChange={ed.setTitle} />
              : (ed.title.trim() ? <h1 className="mb-2 text-[32px] font-semibold leading-tight tracking-tight">{ed.title}</h1> : null)}
            <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted">
              {ed.publicId
                ? <button className="tabular-nums hover:text-ink" title="Copy ID" onClick={() => void copy(ed.publicId!, 'Note ID copied')}>{ed.publicId}</button>
                : <span className="text-faint">New note</span>}
              <span>{formatLongDate(createdAt, tz)}</span>
              {persisted && <TypeChip value={meta.note_type} onChange={(t) => void patch({ note_type: t }).then(() => undefined)} />}
              {persisted && meta.note_type === 'capture' && (
                <button className="rounded-full bg-accent-soft px-2.5 py-1 text-accent hover:opacity-80" onClick={() => void setNoteType(id, 'knowledge').then(() => { setMeta((m) => ({ ...m, note_type: 'knowledge' })); refresh(); toast('Promoted to knowledge') })}>
                  Promote ▸
                </button>
              )}
              {meta.archived_at && <span className="rounded-full bg-panel px-2 py-0.5">Archived</span>}
            </div>

            {editing
              ? <Editor value={ed.content} onChange={ed.setContent} onSaveAndClose={() => void finish()} autoFocus={!persisted || editing} selfId={initial?.id} placeholder="Write something…" />
              : <NoteBody content={ed.content} onToggleTask={toggleTask} resolveTitle={titleMap} />}

            {/* context: below the note on small screens */}
            {!desktop && persisted && (
              <div className="mt-8 border-t border-line pt-5">
                <ContextPanel ctx={ctx.data} tz={tz} publicId={ed.publicId} createdAt={createdAt} updatedAt={meta.updated_at}
                  paperRef={meta.paper_ref} onPaperRef={(v) => setMeta((m) => ({ ...m, paper_ref: v }))} onAddTag={(n) => void addManualTag(id, n).then(() => { void ctx.refetch(); refresh() }).catch(() => toast('That isn’t a valid tag name.', { kind: 'error' }))}
                  onRemoveTag={(t) => void onRemoveTag(t)} onToggleTask={toggleTask} />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* context panel: right column on desktop */}
      {desktop && persisted && (
        <aside aria-label="Note context" className="w-72 shrink-0 overflow-y-auto border-l border-line bg-panel p-5">
          <ContextPanel ctx={ctx.data} tz={tz} publicId={ed.publicId} createdAt={createdAt} updatedAt={meta.updated_at}
            paperRef={meta.paper_ref} onPaperRef={(v) => setMeta((m) => ({ ...m, paper_ref: v }))} onAddTag={(n) => void addManualTag(id, n).then(() => { void ctx.refetch(); refresh() }).catch(() => toast('That isn’t a valid tag name.', { kind: 'error' }))}
            onRemoveTag={(t) => void onRemoveTag(t)} onToggleTask={toggleTask} />
        </aside>
      )}

      <PaperRefSaver id={id} value={meta.paper_ref} initial={initial?.paper_ref ?? ''} enabled={persisted} onSaved={refresh} />

      <ConflictDialog conflict={ed.conflict} mine={ed.content} tz={tz}
        onResolve={async (c) => {
          try { const copyNote = await ed.resolveConflict(c); refresh(); toast(`Saved the other version as ${copyNote?.public_id ?? 'a separate note'}`) }
          catch (e) { toast((e as Error).message || 'Couldn’t resolve the conflict.', { kind: 'error' }) }
        }} />
      <HistoryDialog open={history} onClose={() => setHistory(false)} noteId={id} title={ed.title} content={ed.content} tz={tz}
        onRestore={(r) => { ed.setTitle(r.title ?? ''); ed.setContent(r.content); toast('Restored an earlier version — your previous text is kept in the history') }} />
      <ConfirmDialog open={confirmDelete} title="Delete forever?" danger confirmLabel="Delete forever" onClose={() => setConfirmDelete(false)}
        body="This permanently removes the note, its tags, links and tasks. It can’t be undone."
        onConfirm={() => void deleteNoteForever(id).then(() => { refresh(); toast('Deleted'); nav('/trash') })} />
    </div>
  )
}

function MenuItem({ children, icon, onClick, danger }: { children: React.ReactNode; icon: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button role="menuitem" className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-hover ${danger ? 'text-danger' : ''}`} onClick={onClick}>
      <span className="text-muted">{icon}</span>{children}
    </button>
  )
}

/** Debounced save of the optional paper reference (kept out of the text autosave path). */
function PaperRefSaver({ id, value, initial, enabled, onSaved }: { id: string; value: string; initial: string; enabled: boolean; onSaved: () => void }) {
  const last = useRef(initial)
  useEffect(() => {
    if (!enabled || value === last.current) return
    const t = setTimeout(() => {
      void patchNote(id, { paper_ref: value.trim() || null }).then(() => { last.current = value; onSaved() }).catch(() => {})
    }, 700)
    return () => clearTimeout(t)
  }, [id, value, enabled, onSaved])
  return null
}
