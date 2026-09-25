import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Editor } from '@/components/Editor'
import { SaveStatus } from '@/components/SaveStatus'
import { useToast } from '@/contexts/ToastContext'
import { useNoteEditor } from '@/hooks/useNoteEditor'

function Box({ onSaved }: { onSaved: (publicId: string) => void }) {
  const [meta] = useState(() => ({ id: crypto.randomUUID(), createdAt: new Date().toISOString() }))
  const qc = useQueryClient()
  const ed = useNoteEditor({
    id: meta.id, initial: null, createdAt: meta.createdAt,
    onSaved: () => { void qc.invalidateQueries({ queryKey: ['notes'] }); void qc.invalidateQueries({ queryKey: ['inbox-count'] }); void qc.invalidateQueries({ queryKey: ['tag-counts'] }) },
  })
  const done = async () => {
    if (!ed.hasText()) return
    await ed.flush()
    const pid = ed.getPublicId()
    if (pid) onSaved(pid)
  }
  return (
    <div data-tour="capture" className="glass rounded-3xl px-5 pb-3.5 pt-4 transition-shadow focus-within:shadow-[0_0_0_3px_var(--accent-soft),var(--glass-shadow)]">
      <Editor value={ed.content} onChange={ed.setContent} onSaveAndClose={() => void done()} minRows={3} minHeight="min-h-28" showBar={false} placeholder="Write something…" autoFocus={typeof window !== 'undefined' && window.innerWidth >= 1024} />
      <div className="mt-1 flex items-center justify-between gap-3">
        <SaveStatus status={ed.status} error={ed.errorMsg} onRetry={ed.retryNow} />
        <div className="flex items-center gap-2">
          <span className="hidden text-xs text-faint sm:inline">Ctrl+Enter</span>
          <button disabled={!ed.hasText() && !ed.content} className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-on-accent" onClick={() => void done()}>Save</button>
        </div>
      </div>
    </div>
  )
}

/** Capture without leaving Home: Ctrl+Enter saves and hands you a fresh, empty box. */
export function QuickCapture() {
  const [n, setN] = useState(0)
  const { toast } = useToast()
  const nav = useNavigate()
  return <Box key={n} onSaved={(pid) => { setN((v) => v + 1); toast(`Saved ${pid}`, { action: { label: 'Open', onClick: () => nav(`/n/${pid}`) } }) }} />
}
