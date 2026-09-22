import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { bulkPatchNotes, recentViewed } from '@/api/notes'
import { searchNotes } from '@/api/search'
import { createSavedSearch, deleteSavedSearch, listSavedSearches, setSavedSearchPinned } from '@/api/savedSearches'
import { bulkAddTag, tagCounts } from '@/api/tags'
import { BulkBar } from '@/components/BulkBar'
import { Card } from '@/components/Card'
import { Dialog } from '@/components/Dialog'
import { NoteRow } from '@/components/NoteRow'
import { IconSearch, IconStarFill, IconX } from '@/components/icons'
import { useSettings } from '@/contexts/SettingsContext'
import { useToast } from '@/contexts/ToastContext'
import { useDebounced } from '@/hooks/useDebounced'
import { useSelection } from '@/hooks/useSelection'

const HINTS = ['#', 'type:question', 'is:starred', 'is:task', 'is:inbox', 'after:', 'before:']
const RECENT_KEY = 'mneme-recent-searches'
const PAGE = 30

const loadRecent = (): string[] => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') } catch { return [] } }
const saveRecent = (q: string) => { try { localStorage.setItem(RECENT_KEY, JSON.stringify([q, ...loadRecent().filter((x) => x !== q)].slice(0, 6))) } catch { /* ignore */ } }

export function Search() {
  const { timezone: tz } = useSettings()
  const { toast } = useToast()
  const qc = useQueryClient()
  const [sp, setSp] = useSearchParams()
  const [text, setText] = useState(sp.get('q') ?? '')
  const [pages, setPages] = useState(1)
  const q = useDebounced(text.trim(), 200)
  const sel = useSelection()
  const [savePrompt, setSavePrompt] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [tagPrompt, setTagPrompt] = useState(false)
  const [tagDraft, setTagDraft] = useState('')

  useEffect(() => { const n = new URLSearchParams(); if (q) n.set('q', q); setSp(n, { replace: true }) }, [q]) // eslint-disable-line react-hooks/exhaustive-deps

  const results = useQuery({ queryKey: ['search', q, pages], queryFn: () => searchNotes(q, PAGE * pages, 0), enabled: q.length > 0, placeholderData: (p) => p })
  const tags = useQuery({ queryKey: ['tag-counts'], queryFn: tagCounts, staleTime: 60_000 })
  const recent = useQuery({ queryKey: ['recent-viewed'], queryFn: () => recentViewed(6), enabled: q.length === 0 })
  const saved = useQuery({ queryKey: ['saved-searches'], queryFn: listSavedSearches, staleTime: 30_000 })
  const pinned = useMemo(() => (saved.data ?? []).filter((s) => s.pinned), [saved.data])

  const selectedIds = useMemo(() => [...sel.ids], [sel.ids])
  const refreshAfterBulk = () => { void qc.invalidateQueries({ queryKey: ['search'] }); void qc.invalidateQueries({ queryKey: ['tag-counts'] }) }
  const runBulk = (fn: () => Promise<void>, done: string, fail: string) =>
    void fn().then(() => { sel.stop(); refreshAfterBulk(); toast(done) }).catch(() => toast(fail, { kind: 'error' }))
  const bulkActions = [
    { label: 'Star', onClick: () => runBulk(() => bulkPatchNotes(selectedIds, { is_starred: true }), `Starred ${selectedIds.length}`, 'Couldn’t star those notes.') },
    { label: 'Add tag…', onClick: () => setTagPrompt(true) },
    { label: 'Archive', onClick: () => runBulk(() => bulkPatchNotes(selectedIds, { archived_at: new Date().toISOString() }), `Archived ${selectedIds.length}`, 'Couldn’t archive those notes.') },
    { label: 'Move to trash', danger: true, onClick: () => runBulk(() => bulkPatchNotes(selectedIds, { deleted_at: new Date().toISOString() }), `Moved ${selectedIds.length} to trash`, 'Couldn’t move those notes.') },
  ]
  const submitBulkTag = () => {
    const name = tagDraft.trim()
    if (!name) return
    setTagPrompt(false); setTagDraft('')
    runBulk(() => bulkAddTag(selectedIds, name), `Tagged ${selectedIds.length} note(s)`, 'That isn’t a valid tag name.')
  }

  const submitSave = () => {
    const name = saveName.trim()
    if (!name || !q) return
    void createSavedSearch(name, q)
      .then(() => { setSavePrompt(false); setSaveName(''); void qc.invalidateQueries({ queryKey: ['saved-searches'] }); toast('Search saved') })
      .catch(() => toast('Couldn’t save that search.', { kind: 'error' }))
  }
  const togglePin = (id: string, isPinned: boolean) =>
    void setSavedSearchPinned(id, !isPinned).then(() => qc.invalidateQueries({ queryKey: ['saved-searches'] }))
  const removeSaved = (id: string) =>
    void deleteSavedSearch(id).then(() => qc.invalidateQueries({ queryKey: ['saved-searches'] }))

  // Index-style matches: tags whose name contains a typed word (the "dynamic index").
  const words = useMemo(() => q.split(/\s+/).filter((w) => w && !/^\w+:/.test(w) && !w.startsWith('#')).map((w) => w.toLowerCase()), [q])
  const tagHits = useMemo(() => {
    if (!words.length) return []
    return (tags.data ?? []).filter((t) => words.some((w) => t.name.includes(w))).sort((a, b) => b.note_count - a.note_count).slice(0, 8)
  }, [tags.data, words])
  const topTags = useMemo(() => [...(tags.data ?? [])].filter((t) => !t.name.includes('/')).sort((a, b) => b.note_count - a.note_count).slice(0, 10), [tags.data])
  const recentSearches = q.length === 0 ? loadRecent() : []

  return (
    <div className="h-full overflow-y-auto">
      <div className="page-top mx-auto max-w-3xl px-4 pb-32 lg:px-6 lg:pb-8">
        <h1 className="sr-only">Search</h1>
        <div className="relative">
          <IconSearch className="pointer-events-none absolute left-4 top-1/2 z-10 -translate-y-1/2 text-faint" />
          <input
            autoFocus type="search" value={text} onChange={(e) => { setText(e.target.value); setPages(1) }}
            onKeyDown={(e) => { if (e.key === 'Enter' && text.trim()) saveRecent(text.trim()) }}
            aria-label="Search notes" placeholder="Search words, #tags, N-260920-042…"
            className={`glass w-full rounded-2xl py-3.5 pl-11 text-base outline-none ${q.length ? 'pr-24' : 'pr-4'}`}
          />
          {q.length > 0 && (
            <button onClick={() => setSavePrompt(true)} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full border border-line px-3 py-1.5 text-xs text-muted hover:bg-hover">
              Save…
            </button>
          )}
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Search operators">
          {HINTS.map((h) => (
            <button key={h} className="rounded-full border border-line px-2.5 py-0.5 text-xs text-muted hover:bg-hover" onClick={() => { setPages(1); setText((t) => `${t}${t && !t.endsWith(' ') ? ' ' : ''}${h}`) }}>{h}</button>
          ))}
        </div>

        {q.length === 0 ? (
          <div className="mt-8 space-y-7">
            {!!pinned.length && (
              <section><h2 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-faint">Pinned searches</h2>
                <div className="flex flex-wrap gap-2">
                  {pinned.map((s) => (
                    <span key={s.id} className="group inline-flex items-center gap-1 rounded-full bg-accent-soft py-1 pl-3 pr-1 text-sm text-accent">
                      <button onClick={() => { setPages(1); setText(s.query) }} className="max-w-[16rem] truncate">{s.name}</button>
                      <button aria-label={`Unpin ${s.name}`} className="rounded-full p-1 opacity-60 hover:bg-hover hover:opacity-100" onClick={() => togglePin(s.id, s.pinned)}><IconStarFill size={12} /></button>
                      <button aria-label={`Delete saved search ${s.name}`} className="rounded-full p-1 opacity-60 hover:bg-hover hover:opacity-100" onClick={() => removeSaved(s.id)}><IconX size={12} /></button>
                    </span>
                  ))}
                </div>
              </section>)}
            {!!recentSearches.length && (
              <section><h2 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-faint">Recent searches</h2>
                <div className="flex flex-wrap gap-2">{recentSearches.map((r) => <button key={r} className="rounded-full bg-panel px-3 py-1 text-sm hover:bg-hover" onClick={() => { setPages(1); setText(r) }}>{r}</button>)}</div>
              </section>)}
            {!!recent.data?.length && (
              <section><h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-faint">Recently opened</h2>
                <Card pad={false}><div className="p-2">{recent.data.map((n) => <NoteRow key={n.id} note={n} tz={tz} showTime={false} />)}</div></Card>
              </section>)}
            {!!topTags.length && (
              <section><h2 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-faint">Top tags</h2>
                <div className="flex flex-wrap gap-2">{topTags.map((t) => <Link key={t.name} to={`/tags/${t.name}`} className="rounded-full bg-accent-soft px-3 py-1 text-sm text-accent no-underline">#{t.name} <span className="text-xs opacity-70">{t.note_count}</span></Link>)}</div>
              </section>)}
          </div>
        ) : (
          <div className="mt-6" aria-live="polite">
            {!!tagHits.length && (
              <section className="mb-6"><h2 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-faint">Tags</h2>
                <div className="flex flex-wrap gap-2">{tagHits.map((t) => <Link key={t.name} to={`/tags/${t.name}`} className="rounded-full bg-accent-soft px-3 py-1 text-sm text-accent no-underline">#{t.name} <span className="text-xs opacity-70">{t.note_count} note{t.note_count === 1 ? '' : 's'}</span></Link>)}</div>
              </section>)}
            <div className="mb-1 flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-faint">Notes {results.data && <span className="font-normal">· {results.data.length}{results.data.length >= PAGE * pages ? '+' : ''}</span>}</h2>
              {!!results.data?.length && (
                <button className="text-xs text-muted hover:text-ink hover:underline" onClick={() => (sel.active ? sel.stop() : sel.start())}>{sel.active ? 'Cancel' : 'Select'}</button>
              )}
            </div>
            {results.isLoading && <p className="py-4 text-sm text-faint">Searching…</p>}
            {results.isError && <p className="py-4 text-sm text-danger">Search failed. Check your connection and try again.</p>}
            {results.data && results.data.length === 0 && <p className="py-4 text-sm text-faint">No notes match “{q}”.</p>}
            <Card pad={false}>
              <div className="p-2">
                {results.data?.map((n) => (
                  <NoteRow key={n.id} note={n} tz={tz} highlight showTime={false} selectMode={sel.active} checked={sel.isSelected(n.id)} onToggleCheck={() => sel.toggle(n.id)} />
                ))}
              </div>
            </Card>
            {results.data && results.data.length >= PAGE * pages && <button className="mx-auto mt-2 block text-sm text-accent hover:underline" onClick={() => setPages((p) => p + 1)}>Show more</button>}
          </div>
        )}
      </div>

      {sel.active && <BulkBar count={sel.count} onClear={sel.clear} actions={bulkActions} />}

      <Dialog open={savePrompt} onClose={() => setSavePrompt(false)} title="Save this search">
        <h2 className="mb-2 text-base font-semibold">Save this search</h2>
        <p className="mb-3 truncate text-sm text-muted">“{q}”</p>
        <input autoFocus value={saveName} onChange={(e) => setSaveName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submitSave()}
          placeholder="Name it, e.g. “Open questions”" aria-label="Saved search name" className="mb-5 w-full rounded-xl border border-line bg-raised px-3 py-2 text-sm outline-none" />
        <div className="flex justify-end gap-2">
          <button className="rounded-xl px-4 py-2 text-sm hover:bg-hover" onClick={() => setSavePrompt(false)}>Cancel</button>
          <button disabled={!saveName.trim()} className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-on-accent" onClick={submitSave}>Save</button>
        </div>
      </Dialog>

      <Dialog open={tagPrompt} onClose={() => setTagPrompt(false)} title="Add tag">
        <h2 className="mb-2 text-base font-semibold">Add a tag to {selectedIds.length} note(s)</h2>
        <input autoFocus value={tagDraft} onChange={(e) => setTagDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submitBulkTag()}
          placeholder="tag" aria-label="Tag name" className="mb-5 w-full rounded-xl border border-line bg-raised px-3 py-2 text-sm outline-none" />
        <div className="flex justify-end gap-2">
          <button className="rounded-xl px-4 py-2 text-sm hover:bg-hover" onClick={() => setTagPrompt(false)}>Cancel</button>
          <button disabled={!tagDraft.trim()} className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-on-accent" onClick={submitBulkTag}>Add</button>
        </div>
      </Dialog>
    </div>
  )
}
