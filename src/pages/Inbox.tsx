import { useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { listNotes, patchNote } from '@/api/notes'
import { addManualTag, tagCounts } from '@/api/tags'
import { NoteBody } from '@/components/NoteBody'
import { useSettings } from '@/contexts/SettingsContext'
import { useToast } from '@/contexts/ToastContext'
import { useHotkeys } from '@/hooks/useHotkeys'
import { formatLongDate } from '@/lib/dates'
import { displayTitle } from '@/lib/text'
import { NOTE_TYPE_LABEL, type NoteType } from '@/types/db'

const CHOICES: { key: string; type: NoteType }[] = [
  { key: '1', type: 'knowledge' }, { key: '2', type: 'question' }, { key: '3', type: 'idea' }, { key: '4', type: 'reference' }, { key: '5', type: 'meeting' },
]

/** REVIEW → PROCESS: captures one at a time. Never required; nothing here is automatic. */
export function Inbox() {
  const { timezone: tz } = useSettings()
  const { toast } = useToast()
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['notes', 'inbox'], queryFn: () => listNotes({ state: 'active', type: 'capture', order: 'created', limit: 100 }), staleTime: 0 })
  const tags = useQuery({ queryKey: ['tag-counts'], queryFn: tagCounts, staleTime: 60_000 })
  const [skipped, setSkipped] = useState<Set<string>>(new Set())
  const [tag, setTag] = useState('')
  const tagInput = useRef<HTMLInputElement>(null)
  const [handled, setHandled] = useState(0)

  const queue = useMemo(() => (q.data ?? []).filter((n) => !skipped.has(n.id)), [q.data, skipped])
  const cur = queue[0]
  const total = handled + queue.length
  const topTags = useMemo(() => [...(tags.data ?? [])].sort((a, b) => b.note_count - a.note_count).slice(0, 8), [tags.data])

  const refresh = () => { void qc.invalidateQueries({ queryKey: ['notes'] }); void qc.invalidateQueries({ queryKey: ['inbox-count'] }); void qc.invalidateQueries({ queryKey: ['tag-counts'] }) }
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    try { await fn(); setHandled((h) => h + 1); toast(msg); refresh() } catch { toast('That didn’t save. Try again.', { kind: 'error' }) }
  }
  const setType = (t: NoteType) => cur && void act(() => patchNote(cur.id, { note_type: t }), `Marked as ${NOTE_TYPE_LABEL[t].toLowerCase()}`)
  const archive = () => cur && void act(() => patchNote(cur.id, { archived_at: new Date().toISOString() }), 'Archived')
  const skip = () => { if (cur) { setSkipped((s) => new Set(s).add(cur.id)); setHandled((h) => h + 1) } }
  const addTag = async (name: string) => {
    if (!cur || !name.trim()) return
    try { await addManualTag(cur.id, name); toast(`Tagged #${name.trim().replace(/^#/, '').toLowerCase()}`); setTag(''); refresh() } catch { toast('That isn’t a valid tag name.', { kind: 'error' }) }
  }

  useHotkeys([
    ...CHOICES.map((c) => ({ combo: c.key, handler: () => setType(c.type) })),
    { combo: 'a', handler: archive }, { combo: 'j', handler: skip }, { combo: 'arrowright', handler: skip },
    { combo: 't', handler: (e: KeyboardEvent) => { e.preventDefault(); tagInput.current?.focus() } },
  ])

  return (
    <div className="h-full overflow-y-auto">
      <div className="page-top mx-auto max-w-2xl px-4 pb-32 lg:px-6 lg:pb-8">
        <div className="mb-1 flex items-baseline justify-between">
          <h1 className="text-[28px] font-semibold leading-tight">Inbox</h1>
          {cur ? <span className="text-sm text-muted">{handled + 1} of {total}</span> : null}
        </div>
        <p className="mb-5 text-sm text-muted">Captures waiting for a second look. Sort them now, later, or never — it’s optional.</p>

        {q.isLoading && <p className="text-sm text-faint">Loading…</p>}
        {q.isError && <p className="text-sm text-danger">Couldn’t load your captures.</p>}
        {!q.isLoading && !cur && (
          <div className="rounded-xl border border-dashed border-line p-8 text-center">
            <p className="text-lg">Nothing to process.</p>
            <p className="mt-1 text-sm text-muted">{skipped.size ? `${skipped.size} skipped for now.` : 'Everything you captured has been looked at.'}</p>
            <Link to="/" className="mt-3 inline-block text-sm">Back to today</Link>
          </div>
        )}

        {cur && (
          <article className="glass rounded-3xl p-6" aria-label="Capture to process">
            <div className="mb-2 flex items-center justify-between text-xs text-faint">
              <span className="tabular-nums">{cur.public_id}</span><span>{formatLongDate(cur.created_at, tz)}</span>
            </div>
            <h2 className="mb-2 text-xl font-semibold">{displayTitle(cur)}</h2>
            <div className="max-h-72 overflow-y-auto"><NoteBody content={cur.snippet} /></div>
            <Link to={`/n/${cur.public_id}`} className="mt-2 inline-block text-sm">Open full note →</Link>

            <div className="mt-5">
              <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-faint">What is it?</div>
              <div className="flex flex-wrap gap-2">
                {CHOICES.map((c) => <button key={c.type} className="rounded-full border border-line px-3.5 py-1.5 text-sm hover:bg-accent-soft" onClick={() => setType(c.type)}><kbd className="mr-1.5 text-xs text-faint">{c.key}</kbd>{NOTE_TYPE_LABEL[c.type]}</button>)}
              </div>
            </div>

            <div className="mt-5">
              <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-faint">Tag it <span className="font-normal normal-case">(optional)</span></div>
              <div className="flex flex-wrap items-center gap-1.5">
                {topTags.map((t) => <button key={t.name} className="rounded-full bg-accent-soft px-2.5 py-1 text-xs text-accent" onClick={() => void addTag(t.name)}>#{t.name}</button>)}
                <form onSubmit={(e) => { e.preventDefault(); void addTag(tag) }}>
                  <input ref={tagInput} value={tag} onChange={(e) => setTag(e.target.value)} placeholder="new tag (T)" aria-label="Add a tag" className="w-32 rounded-full border border-line bg-bg px-3 py-1 text-xs outline-none focus:border-accent" />
                </form>
              </div>
            </div>

            <div className="mt-6 flex items-center justify-between border-t border-line pt-4">
              <button className="rounded-lg px-3 py-2 text-sm text-danger hover:bg-danger-soft" onClick={archive}><kbd className="mr-1.5 text-xs opacity-70">A</kbd>Archive ×</button>
              <button className="rounded-lg border border-line px-4 py-2 text-sm hover:bg-hover" onClick={skip}>Skip <kbd className="ml-1.5 text-xs text-faint">→</kbd></button>
            </div>
          </article>
        )}
      </div>
    </div>
  )
}
