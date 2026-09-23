import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { openJournal } from '@/api/journal'
import { useToast } from '@/contexts/ToastContext'

/** Opens (creating if needed) a day's journal page in the editor. */
export function useOpenJournal() {
  const nav = useNavigate()
  const qc = useQueryClient()
  const { toast } = useToast()
  return async (day: string) => {
    try {
      const id = await openJournal(day)
      void qc.invalidateQueries({ queryKey: ['notes'] })
      nav(`/n/${id}`)
    } catch { toast('Couldn’t open the journal.', { kind: 'error' }) }
  }
}
