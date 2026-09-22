import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { bulkDeleteForever, bulkPatchNotes, emptyTrash, listNotes, type NoteState } from '@/api/notes'
import { bulkAddTag } from '@/api/tags'
import { useSettings } from '@/contexts/SettingsContext'
import { useToast } from '@/contexts/ToastContext'
import { useSelection } from '@/hooks/useSelection'
import { dayKey, formatDayHeading, presetRange, todayKey, type RangePreset } from '@/lib/dates'
import { NOTE_TYPES, NOTE_TYPE_LABEL, type NoteListItem, type NoteType } from '@/types/db'
import { BulkBar } from './BulkBar'
import { ConfirmDialog, Dialog } from './Dialog'
import { NoteRow } from './NoteRow'

export type ListMode = 'active' | 'starred' | 'archive' | 'trash'

const TITLES: Record<ListMode, string> = { active: 'Notes', starred: 'Starred', archive: 'Archive', trash: 'Trash' }
const RANGES: { id: RangePreset; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'today', label: 'Today' }, { id: 'yesterday', label: 'Yesterday' }, { id: 'week', label: 'This week' }, { id: 'month', label: 'This month' },
]
const PAGE = 30

export function NotesList({ mode, selected }: { mode: ListMode; selected?: string }) {
  const { timezone: tz } = useSettings()
  const { toast } = useToast()
  const qc = useQueryClient()
  const [sp, setSp] = useSearchParams()
  const range = (sp.get('range') as RangePreset) || 'all'
  const type = (sp.get('type') as NoteType | null) || null
  const order: 'created' | 'updated' = sp.get('sort') === 'edited' ? 'updated' : 'created'
  const [confirm, setConfirm] = useState(false)
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)
  const sel = useSelection()
  const day = todayKey(tz)

  const state: NoteState = mode === 'archive' ? 'archived' : mode === 'trash' ? 'trash' : 'active'
  const q = useInfiniteQuery({
    queryKey: ['notes', mode, range, type, order, tz, day],
    initialPageParam: null as { ts: string; id: string } | null,
    queryFn: ({ pageParam }) => {
      const r = presetRange(range, tz)
      return listNotes({ state: mode === 'starred' ? 'all' : state, starred: mode === 'starred' ? true : null, type, order, from: r.from, to: r.to, cursor: pageParam, limit: PAGE })
    },
    getNextPageParam: (last) => (last.length < PAGE ? undefined : { ts: order === 'updated' ? last[last.length - 1].updated_at : last[last.length - 1].created_at, id: last[last.length - 1].id }),
  })

  const items = useMemo(() => q.data?.pages.flat() ?? [], [q.data])
  const groups = useMemo(() => {
    const out: { key: string; notes: NoteListItem[] }[] = []
    for (const n of items) {
      const k = dayKey(order === 'updated' ? n.updated_at : n.created_at, tz)
      const last = out[out.length - 1]
      if (last?.key === k) last.notes.push(n); else out.push({ key: k, notes: [n] })
    }
    return out
  }, [items, tz, order])

  // infinite scroll: load the next page when the sentinel scrolls into view
  const sentinel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = sentinel.current
    if (!el || !q.hasNextPage) return
    const io = new IntersectionObserver((e) => { if (e[0].isIntersecting && !q.isFetchingNextPage) void q.fetchNextPage() }, { rootMargin: '400px' })
    io.observe(el)
    return () => io.disconnect()
  }, [q, q.hasNextPage, q.isFetchingNextPage, items.length])

  const setParam = (k: string, v: string | null) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n, { replace: true }) }

  const selectedIds = useMemo(() => [...sel.ids], [sel.ids])
  const refreshAfterBulk = () => {
    void qc.invalidateQueries({ queryKey: ['notes'] })
    void qc.invalidateQueries({ queryKey: ['tag-counts'] })
    void qc.invalidateQueries({ queryKey: ['inbox-count'] })
  }
  const runBulk = (fn: () => Promise<void>, done: string, fail: string) =>
    void fn().then(() => { sel.stop(); refreshAfterBulk(); toast(done) }).catch(() => toast(fail, { kind: 'error' }))
  const [tagPrompt, setTagPrompt] = useState(false)
  const [tagDraft, setTagDraft] = useState('')
  const submitBulkTag = () => {
    const name = tagDraft.trim()
    if (!name) return
    setTagPrompt(false); setTagDraft('')
    runBulk(() => bulkAddTag(selectedIds, name), `Tagged ${selectedIds.length} note(s)`, 'That isn’t a valid tag name.')
  }

  const bulkActions =
    mode === 'trash'
      ? [
          { label: 'Restore', onClick: () => runBulk(() => bulkPatchNotes(selectedIds, { deleted_at: null }), `Restored ${selectedIds.length}`, 'Couldn’t restore those notes.') },
          { label: 'Delete forever', danger: true, onClick: () => setConfirmBulkDelete(true) },
        ]
      : mode === 'archive'
      ? [
          { label: 'Unarchive', onClick: () => runBulk(() => bulkPatchNotes(selectedIds, { archived_at: null }), `Restored ${selectedIds.length}`, 'Couldn’t restore those notes.') },
          { label: 'Add tag…', onClick: () => setTagPrompt(true) },
          { label: 'Move to trash', danger: true, onClick: () => runBulk(() => bulkPatchNotes(selectedIds, { deleted_at: new Date().toISOString() }), `Moved ${selectedIds.length} to trash`, 'Couldn’t move those notes.') },
        ]
      : [
          { label: 'Star', onClick: () => runBulk(() => bulkPatchNotes(selectedIds, { is_starred: true }), `Starred ${selectedIds.length}`, 'Couldn’t star those notes.') },
          { label: 'Add tag…', onClick: () => setTagPrompt(true) },
          { label: 'Archive', onClick: () => runBulk(() => bulkPatchNotes(selectedIds, { archived_at: new Date().toISOString() }), `Archived ${selectedIds.length}`, 'Couldn’t archive those notes.') },
          { label: 'Move to trash', danger: true, onClick: () => runBulk(() => bulkPatchNotes(selectedIds, { deleted_at: new Date().toISOString() }), `Moved ${selectedIds.length} to trash`, 'Couldn’t move those notes.') },
        ]

  return (
    <section aria-label={TITLES[mode]} className="flex h-full min-h-0 flex-col">
      <header className="border-b border-line px-5 pb-3 pt-[max(1.1rem,env(safe-area-inset-top))]">
        <div className="mb-2 flex items-center justify-between">
          <h1 className="text-[22px] font-semibold tracking-tight">{TITLES[mode]}</h1>
          <div className="flex items-center gap-3">
            {items.length > 0 && (
              <button className="text-sm text-muted hover:text-ink hover:underline" onClick={() => (sel.active ? sel.stop() : sel.start())}>
                {sel.active ? 'Cancel' : 'Select'}
              </button>
            )}
            {mode === 'trash' && items.length > 0 && <button className="text-sm text-danger hover:underline" onClick={() => setConfirm(true)}>Empty trash</button>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filters">
          {mode === 'active' && RANGES.map((r) => (
            <button key={r.id} aria-pressed={range === r.id} onClick={() => setParam('range', r.id === 'all' ? null : r.id)}
              className={`rounded-full px-3 py-1 text-xs ${range === r.id ? 'bg-accent text-on-accent' : 'border border-line text-muted hover:bg-hover'}`}>{r.label}</button>
          ))}
          <label className="ml-auto text-xs text-muted">
            <span className="sr-only">Order</span>
            <select value={order === 'updated' ? 'edited' : 'created'} onChange={(e) => setParam('sort', e.target.value === 'edited' ? 'edited' : null)} className="rounded-full border border-line bg-transparent px-2.5 py-1 text-xs outline-none">
              <option value="created">Newest</option>
              <option value="edited">Recently edited</option>
            </select>
          </label>
          <label className="text-xs text-muted">
            <span className="sr-only">Filter by type</span>
            <select value={type ?? ''} onChange={(e) => setParam('type', e.target.value || null)} className="rounded-full border border-line bg-transparent px-2.5 py-1 text-xs outline-none">
              <option value="">All types</option>
              {NOTE_TYPES.map((t) => <option key={t} value={t}>{NOTE_TYPE_LABEL[t]}</option>)}
            </select>
          </label>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto pb-24 lg:pb-4">
        {q.isLoading && <div className="space-y-3 p-4" aria-busy="true" aria-label="Loading notes">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="skeleton h-[72px]" style={{ opacity: 1 - i * 0.16 }} />)}</div>}
        {q.isError && <p className="p-6 text-sm text-danger">Couldn’t load notes. <button className="underline" onClick={() => void q.refetch()}>Try again</button></p>}
        {!q.isLoading && !q.isError && items.length === 0 && (
          <div className="p-8 text-center text-sm text-muted">
            {mode === 'trash' ? 'The trash is empty.' : mode === 'archive' ? 'Nothing archived.' : mode === 'starred' ? 'Star a note to keep it close.' : range !== 'all' || type ? 'No notes match these filters.' : 'No notes yet — press + to capture your first one.'}
          </div>
        )}
        {groups.map((g) => (
          <div key={g.key}>
            <h2 className="sticky top-0 z-10 bg-[var(--sticky)] px-5 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-faint backdrop-blur-md">{formatDayHeading(g.key, tz)}</h2>
            <div className="px-2.5 pb-1">
              {g.notes.map((n) => (
                <NoteRow
                  key={n.id} note={n} tz={tz} selected={n.public_id === selected} time={order === 'updated' ? n.updated_at : undefined}
                  selectMode={sel.active} checked={sel.isSelected(n.id)} onToggleCheck={() => sel.toggle(n.id)}
                />
              ))}
            </div>
          </div>
        ))}
        <div ref={sentinel} />
        {q.isFetchingNextPage && <p className="p-4 text-center text-xs text-faint">Loading more…</p>}
        {q.hasNextPage && !q.isFetchingNextPage && <button className="mx-auto my-3 block text-sm text-accent hover:underline" onClick={() => void q.fetchNextPage()}>Load more</button>}
      </div>

      {sel.active && <BulkBar count={sel.count} onClear={sel.clear} actions={bulkActions} />}

      <ConfirmDialog open={confirm} title="Empty the trash?" danger confirmLabel="Delete forever" onClose={() => setConfirm(false)}
        body="Every note in the trash is permanently deleted, with its tags, links and tasks. This can’t be undone."
        onConfirm={() => void emptyTrash().then((n) => { void qc.invalidateQueries({ queryKey: ['notes'] }); toast(`Deleted ${n} note${n === 1 ? '' : 's'}`) }).catch(() => toast('Couldn’t empty the trash.', { kind: 'error' }))} />

      <ConfirmDialog open={confirmBulkDelete} title="Delete forever?" danger confirmLabel="Delete forever" onClose={() => setConfirmBulkDelete(false)}
        body={`This permanently deletes ${selectedIds.length} note(s), with their tags, links and tasks. This can’t be undone.`}
        onConfirm={() => runBulk(() => bulkDeleteForever(selectedIds), `Deleted ${selectedIds.length} forever`, 'Couldn’t delete those notes.')} />

      <Dialog open={tagPrompt} onClose={() => setTagPrompt(false)} title="Add tag">
        <h2 className="mb-2 text-base font-semibold">Add a tag to {selectedIds.length} note(s)</h2>
        <input autoFocus value={tagDraft} onChange={(e) => setTagDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submitBulkTag()}
          placeholder="tag" aria-label="Tag name" className="mb-5 w-full rounded-xl border border-line bg-raised px-3 py-2 text-sm outline-none" />
        <div className="flex justify-end gap-2">
          <button className="rounded-xl px-4 py-2 text-sm hover:bg-hover" onClick={() => setTagPrompt(false)}>Cancel</button>
          <button disabled={!tagDraft.trim()} className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-on-accent" onClick={submitBulkTag}>Add</button>
        </div>
      </Dialog>
    </section>
  )
}
