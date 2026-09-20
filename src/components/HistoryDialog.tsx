import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { listRevisions, snapshotCurrent, type Revision } from '@/api/revisions'
import { formatLongDate } from '@/lib/dates'
import { deriveTitle } from '@/lib/text'
import { Dialog } from './Dialog'

/** Browse and restore earlier versions. Restoring first snapshots the current text, so it can always be undone. */
export function HistoryDialog({ open, onClose, noteId, title, content, tz, onRestore }: {
  open: boolean; onClose: () => void; noteId: string; title: string; content: string; tz: string
  onRestore: (r: Revision) => void
}) {
  const q = useQuery({ queryKey: ['revisions', noteId], queryFn: () => listRevisions(noteId), enabled: open, staleTime: 0 })
  const [sel, setSel] = useState<string | null>(null)
  const list = q.data ?? []
  const cur = list.find((r) => r.id === sel) ?? list[0]

  const restore = async () => {
    if (!cur) return
    try { await snapshotCurrent(noteId, title.trim() || null, content) } catch { /* the restore is still safe: the old text is in the list */ }
    onRestore(cur)
    onClose()
  }

  return (
    <Dialog open={open} onClose={onClose} title="Version history" wide>
      <h2 className="mb-1 text-base font-semibold">Version history</h2>
      <p className="mb-4 text-sm text-muted">Earlier versions of this note, saved automatically while you edit. Restoring keeps your current text in the list too.</p>
      {q.isLoading && <p className="text-sm text-faint">Loading…</p>}
      {q.isError && <p className="text-sm text-danger">Couldn’t load the history.</p>}
      {!q.isLoading && !list.length && <p className="text-sm text-faint">No earlier versions yet — they appear after you edit the note.</p>}
      {!!list.length && (
        <div className="grid gap-3 sm:grid-cols-[13rem_1fr]">
          <ul className="max-h-64 space-y-1 overflow-y-auto" aria-label="Versions">
            {list.map((r) => (
              <li key={r.id}>
                <button className={`w-full rounded-lg px-3 py-2 text-left text-sm ${cur?.id === r.id ? 'bg-accent-soft' : 'hover:bg-hover'}`} onClick={() => setSel(r.id)}>
                  <div className="text-xs text-faint">{formatLongDate(r.saved_at, tz)}</div>
                  <div className="truncate">{r.title || deriveTitle(r.content) || 'Untitled'}</div>
                </button>
              </li>
            ))}
          </ul>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-panel p-3 font-serif text-sm" aria-label="Selected version">{cur?.content}</pre>
        </div>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <button className="rounded-lg px-3 py-2 text-sm hover:bg-hover" onClick={onClose}>Close</button>
        <button disabled={!cur} className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-on-accent" onClick={() => void restore()}>Restore this version</button>
      </div>
    </Dialog>
  )
}
