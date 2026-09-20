import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { insertNote } from '@/api/notes'
import { putDraft, removeDraft } from '@/lib/drafts'

/** Android "Share → Mneme" (PWA share_target): the shared text becomes a capture immediately. */
export function Share() {
  const [sp] = useSearchParams()
  const nav = useNavigate()
  const qc = useQueryClient()
  const [err, setErr] = useState<string | null>(null)
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true
    const parts = [sp.get('title'), sp.get('text'), sp.get('url')].map((s) => s?.trim()).filter(Boolean) as string[]
    const content = [...new Set(parts)].join('\n')
    if (!content) { nav('/n/new', { replace: true }); return }
    const id = crypto.randomUUID(), createdAt = new Date().toISOString()
    void (async () => {
      // durable first: if the network is down the SyncManager delivers it later
      await putDraft({ id, title: null, content, createdAt, baseVersion: null, dirty: true, updatedAt: Date.now() })
      try {
        const n = await insertNote({ id, title: null, content, created_at: createdAt })
        await removeDraft(id)
        void qc.invalidateQueries({ queryKey: ['notes'] }); void qc.invalidateQueries({ queryKey: ['inbox-count'] })
        nav(`/n/${n.public_id}`, { replace: true })
      } catch { setErr('Saved on this device. It will sync when you’re back online.') }
    })()
  }, [sp, nav, qc])

  return <div className="p-8 text-sm text-muted">{err ?? 'Saving to Mneme…'}</div>
}
