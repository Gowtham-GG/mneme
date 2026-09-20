import { useState } from 'react'
import { formatLongDate } from '@/lib/dates'
import type { ConflictInfo } from '@/hooks/useNoteEditor'
import { Dialog } from './Dialog'

export function ConflictDialog({ conflict, mine, tz, onResolve }: {
  conflict: ConflictInfo | null
  mine: string
  tz: string
  onResolve: (choice: 'mine' | 'theirs') => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const run = async (c: 'mine' | 'theirs') => { setBusy(true); try { await onResolve(c) } finally { setBusy(false) } }
  return (
    <Dialog open={!!conflict} onClose={() => {}} title="Edited on another device" wide>
      <h2 className="mb-1 text-base font-semibold">This note was edited somewhere else</h2>
      <p className="mb-4 text-sm text-muted">
        Nothing is lost. Whichever version you don’t keep is saved as a separate note.
        {conflict && <> The other edit was made {formatLongDate(conflict.updated_at, tz)}.</>}
      </p>
      <div className="mb-5 grid gap-3 sm:grid-cols-2">
        {([['This device', mine], ['Other device', conflict?.content ?? '']] as const).map(([h, text]) => (
          <div key={h}>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-faint">{h}</div>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-panel p-2.5 font-serif text-sm">{text.slice(0, 1500)}{text.length > 1500 ? '…' : ''}</pre>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <button disabled={busy} className="rounded-lg border border-line px-3 py-2 text-sm hover:bg-hover" onClick={() => run('theirs')}>Use the other device’s version</button>
        <button disabled={busy} className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-on-accent" onClick={() => run('mine')}>Keep mine</button>
      </div>
    </Dialog>
  )
}
