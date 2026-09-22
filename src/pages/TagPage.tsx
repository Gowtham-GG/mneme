import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { searchNotes } from '@/api/search'
import { mergeTags, renameTag, tagCounts } from '@/api/tags'
import { Card } from '@/components/Card'
import { Dialog } from '@/components/Dialog'
import { NoteRow } from '@/components/NoteRow'
import { useSettings } from '@/contexts/SettingsContext'
import { useToast } from '@/contexts/ToastContext'

const PAGE = 30

function invalidateAfterTagChange(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ['tag-counts'] })
  void qc.invalidateQueries({ queryKey: ['search'] })
  void qc.invalidateQueries({ queryKey: ['notes'] })
  void qc.invalidateQueries({ queryKey: ['note-context'] })
}

function RenameDialog({ open, onClose, name }: { open: boolean; onClose: () => void; name: string }) {
  const [value, setValue] = useState(name)
  const nav = useNavigate()
  const qc = useQueryClient()
  const { toast } = useToast()
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    const next = value.trim().toLowerCase()
    if (!next || next === name) return onClose()
    setBusy(true)
    try {
      await renameTag(name, next)
      invalidateAfterTagChange(qc)
      onClose()
      nav(`/tags/${next}`, { replace: true })
    } catch { toast('Couldn’t rename that tag — check the new name, or it may already exist.', { kind: 'error' }) } finally { setBusy(false) }
  }
  return (
    <Dialog open={open} onClose={onClose} title="Rename tag">
      <h2 className="mb-2 text-base font-semibold">Rename #{name}</h2>
      <p className="mb-3 text-sm text-muted">Nested tags (e.g. {name}/child) move with it. Every note using this tag is updated.</p>
      <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void submit()}
        aria-label="New tag name" className="mb-5 w-full rounded-xl border border-line bg-raised px-3 py-2 text-sm outline-none" />
      <div className="flex justify-end gap-2">
        <button className="rounded-xl px-4 py-2 text-sm hover:bg-hover" onClick={onClose}>Cancel</button>
        <button disabled={busy} className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-on-accent" onClick={() => void submit()}>{busy ? 'Renaming…' : 'Rename'}</button>
      </div>
    </Dialog>
  )
}

function MergeDialog({ open, onClose, name }: { open: boolean; onClose: () => void; name: string }) {
  const [value, setValue] = useState('')
  const nav = useNavigate()
  const qc = useQueryClient()
  const { toast } = useToast()
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    const target = value.trim().toLowerCase()
    if (!target || target === name) return
    setBusy(true)
    try {
      await mergeTags([name], target)
      invalidateAfterTagChange(qc)
      onClose()
      nav(`/tags/${target}`, { replace: true })
    } catch { toast('Couldn’t merge that tag.', { kind: 'error' }) } finally { setBusy(false) }
  }
  return (
    <Dialog open={open} onClose={onClose} title="Merge tag">
      <h2 className="mb-2 text-base font-semibold">Merge #{name} into…</h2>
      <p className="mb-3 text-sm text-muted">Every note tagged #{name} gets the target tag instead; #{name} is removed. This does not cascade to nested children.</p>
      <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void submit()}
        placeholder="target tag name" aria-label="Target tag name" className="mb-5 w-full rounded-xl border border-line bg-raised px-3 py-2 text-sm outline-none" />
      <div className="flex justify-end gap-2">
        <button className="rounded-xl px-4 py-2 text-sm hover:bg-hover" onClick={onClose}>Cancel</button>
        <button disabled={busy || !value.trim()} className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-on-accent" onClick={() => void submit()}>{busy ? 'Merging…' : 'Merge'}</button>
      </div>
    </Dialog>
  )
}

export function TagPage() {
  const { '*': raw = '' } = useParams()
  const name = decodeURIComponent(raw).toLowerCase()
  const { timezone: tz } = useSettings()
  const [pages, setPages] = useState(1)
  const [renaming, setRenaming] = useState(false)
  const [merging, setMerging] = useState(false)
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
        <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="text-[28px] font-semibold leading-tight">#{name}</h1>
          <button className="text-xs text-muted hover:text-ink hover:underline" onClick={() => setRenaming(true)}>Rename</button>
          <button className="text-xs text-muted hover:text-ink hover:underline" onClick={() => setMerging(true)}>Merge into…</button>
        </div>
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
      <RenameDialog open={renaming} onClose={() => setRenaming(false)} name={name} />
      <MergeDialog open={merging} onClose={() => setMerging(false)} name={name} />
    </div>
  )
}
