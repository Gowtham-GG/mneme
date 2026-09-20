import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { recentViewed } from '@/api/notes'
import { searchNotes } from '@/api/search'
import { tagCounts } from '@/api/tags'
import { Card } from '@/components/Card'
import { NoteRow } from '@/components/NoteRow'
import { IconSearch } from '@/components/icons'
import { useSettings } from '@/contexts/SettingsContext'
import { useDebounced } from '@/hooks/useDebounced'

const HINTS = ['#', 'type:question', 'is:starred', 'is:task', 'is:inbox', 'after:', 'before:']
const RECENT_KEY = 'mneme-recent-searches'
const PAGE = 30

const loadRecent = (): string[] => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') } catch { return [] } }
const saveRecent = (q: string) => { try { localStorage.setItem(RECENT_KEY, JSON.stringify([q, ...loadRecent().filter((x) => x !== q)].slice(0, 6))) } catch { /* ignore */ } }

export function Search() {
  const { timezone: tz } = useSettings()
  const [sp, setSp] = useSearchParams()
  const [text, setText] = useState(sp.get('q') ?? '')
  const [pages, setPages] = useState(1)
  const q = useDebounced(text.trim(), 200)

  useEffect(() => { const n = new URLSearchParams(); if (q) n.set('q', q); setSp(n, { replace: true }) }, [q]) // eslint-disable-line react-hooks/exhaustive-deps

  const results = useQuery({ queryKey: ['search', q, pages], queryFn: () => searchNotes(q, PAGE * pages, 0), enabled: q.length > 0, placeholderData: (p) => p })
  const tags = useQuery({ queryKey: ['tag-counts'], queryFn: tagCounts, staleTime: 60_000 })
  const recent = useQuery({ queryKey: ['recent-viewed'], queryFn: () => recentViewed(6), enabled: q.length === 0 })

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
            className="glass w-full rounded-2xl py-3.5 pl-11 pr-4 text-base outline-none"
          />
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Search operators">
          {HINTS.map((h) => (
            <button key={h} className="rounded-full border border-line px-2.5 py-0.5 text-xs text-muted hover:bg-hover" onClick={() => { setPages(1); setText((t) => `${t}${t && !t.endsWith(' ') ? ' ' : ''}${h}`) }}>{h}</button>
          ))}
        </div>

        {q.length === 0 ? (
          <div className="mt-8 space-y-7">
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
            <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-faint">Notes {results.data && <span className="font-normal">· {results.data.length}{results.data.length >= PAGE * pages ? '+' : ''}</span>}</h2>
            {results.isLoading && <p className="py-4 text-sm text-faint">Searching…</p>}
            {results.isError && <p className="py-4 text-sm text-danger">Search failed. Check your connection and try again.</p>}
            {results.data && results.data.length === 0 && <p className="py-4 text-sm text-faint">No notes match “{q}”.</p>}
            <Card pad={false}><div className="p-2">{results.data?.map((n) => <NoteRow key={n.id} note={n} tz={tz} highlight showTime={false} />)}</div></Card>
            {results.data && results.data.length >= PAGE * pages && <button className="mx-auto mt-2 block text-sm text-accent hover:underline" onClick={() => setPages((p) => p + 1)}>Show more</button>}
          </div>
        )}
      </div>
    </div>
  )
}
