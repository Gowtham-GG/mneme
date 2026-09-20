import { IconCheck, IconCloudOff } from './icons'
import type { SaveStatus as Status } from '@/hooks/useNoteEditor'

/** Always tells the user whether their text is safe. Polite live region for screen readers. */
export function SaveStatus({ status, error, onRetry }: { status: Status; error?: string | null; onRetry?: () => void }) {
  let body: React.ReactNode = null
  let tone = 'text-muted'
  if (status === 'saving') body = 'Saving…'
  else if (status === 'saved') { body = <><IconCheck size={14} /> Saved</>; tone = 'text-task' }
  else if (status === 'offline') { body = <><IconCloudOff size={14} /> Offline — saved locally</>; tone = 'text-important' }
  else if (status === 'error') {
    body = <>Couldn’t save. Retrying…{onRetry && <button className="ml-1 underline" onClick={onRetry}>Retry now</button>}</>
    tone = 'text-danger'
  } else if (status === 'conflict') { body = 'Edited on another device'; tone = 'text-important' }
  return (
    <span role="status" aria-live="polite" title={status === 'error' ? error ?? undefined : undefined} className={`inline-flex min-h-6 items-center gap-1 text-xs ${tone}`}>
      {body}
    </span>
  )
}
