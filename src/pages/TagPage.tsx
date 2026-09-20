import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { searchNotes } from '@/api/search'
import { tagCounts } from '@/api/tags'
import { Card } from '@/components/Card'
import { NoteRow } from '@/components/NoteRow'
import { useSettings } from '@/contexts/SettingsContext'

const PAGE = 30

export function TagPage() {
  const { '*': raw = '' } = useParams()
  const name = decodeURIComponent(raw).toLowerCase()
  const { timezone: tz } = useSettings()
  const [pages, setPages] = useState(1)
  const notes = useQuery({ queryKey: ['search', `#${name}`, pages], queryFn: () => searchNotes(`#${name}`, PAGE * pages), placeholderData: (p) => p })
  const tags = useQuery({ queryKey: ['tag-counts'], queryFn: tagCounts, staleTime: 60_000 })

  const self = tags.data?.find((t) => t.name === name)
  const children = useMemo(() => (tags.data ?? []).filter((t) => t.name.startsWith(name + '/') && t.name.split('/').length === name.split('/').length + 1), [tags.data, name])
  const also = useMemo(() => {
    const c = new Map<string, number>()
    for (const n of notes.data ?? []) for (const t of n.tags) if (t !== name && !t.startsWith(name + '/')) c.set(t, (c.get(t) ?? 0) + 1)
    return [...c].sort((a, b) => b[1] - a[1]).slice(0, 8)
  }, [notes.data, name])
  const parts = name.split('/')

  return (
    <div className="h-full overflow-y-auto">
      <div className="page-top mx-auto max-w-3xl px-4 pb-32 lg:px-6 lg:pb-8">
        <nav aria-label="Breadcrumb" className="mb-1 text-sm text-muted">
          <Link to="/tags">Index</Link>
          {parts.map((p, i) => <span key={i}> / <Link to={`/tags/${parts.slice(0, i + 1).join('/')}`}>{p}</Link></span>)}
        </nav>
        <h1 className="mb-1 text-[28px] font-semibold leading-tight">#{name}</h1>
        <p className="mb-5 text-sm text-muted">{self ? `${self.note_count} note${self.note_count === 1 ? '' : 's'}` : notes.isLoading ? '' : 'No notes with this tag'}</p>

        {!!children.length && (
          <section className="mb-5"><h2 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-faint">Within {name}</h2>
            <div className="flex flex-wrap gap-2">{children.map((t) => <Link key={t.name} to={`/tags/${t.name}`} className="rounded-full bg-accent-soft px-3 py-1 text-sm text-accent no-underline">{t.name.split('/').pop()} <span className="text-xs opacity-70">{t.note_count}</span></Link>)}</div>
          </section>)}
        {!!also.length && (
          <section className="mb-5"><h2 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-faint">Also tagged with</h2>
            <div className="flex flex-wrap gap-2">{also.map(([t, n]) => <Link key={t} to={`/tags/${t}`} className="rounded-full border border-line px-3 py-1 text-sm no-underline hover:bg-hover">#{t} <span className="text-xs text-faint">{n}</span></Link>)}</div>
          </section>)}

        {notes.isLoading && <p className="text-sm text-faint">Loading…</p>}
        {notes.isError && <p className="text-sm text-danger">Couldn’t load notes.</p>}
        <Card pad={false}><div className="p-2">{notes.data?.map((n) => <NoteRow key={n.id} note={n} tz={tz} showTime={false} />)}</div></Card>
        {notes.data && notes.data.length >= PAGE * pages && <button className="mx-auto mt-2 block text-sm text-accent hover:underline" onClick={() => setPages((p) => p + 1)}>Show more</button>}
      </div>
    </div>
  )
}
