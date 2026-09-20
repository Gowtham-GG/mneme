import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { flushDrafts } from '@/lib/sync'
import { useToast } from '@/contexts/ToastContext'

/**
 * Background safety net: whenever the app starts, regains connection or every
 * 30 s, unsent drafts (offline captures, crash leftovers) are pushed to the server.
 * Drafts are keyed by client UUID, so replays can never create duplicates.
 */
export function SyncManager() {
  const qc = useQueryClient()
  const { toast } = useToast()
  useEffect(() => {
    let stopped = false
    const run = async (announce: boolean) => {
      const r = await flushDrafts(() => {})
      if (stopped) return
      if (r.sent) {
        void qc.invalidateQueries({ queryKey: ['notes'] })
        void qc.invalidateQueries({ queryKey: ['inbox-count'] })
        if (announce) toast(r.sent === 1 ? 'Synced 1 note saved offline' : `Synced ${r.sent} notes saved offline`)
      }
      if (r.conflicts) toast(`${r.conflicts} note(s) were edited on two devices — open them to choose.`, { kind: 'error', ms: 8000 })
    }
    void run(true)
    const onOnline = () => void run(true)
    const id = setInterval(() => void run(false), 30_000)
    window.addEventListener('online', onOnline)
    return () => { stopped = true; clearInterval(id); window.removeEventListener('online', onOnline) }
  }, [qc, toast])
  return null
}
