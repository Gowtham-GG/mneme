import { useState } from 'react'
import { useToast } from '@/contexts/ToastContext'
import { CLIPBOARD_CLEAR_MS, copySecret } from '@/lib/clipboard'
import { IconCheck, IconCopy } from '../icons'

/** Copies a value. Secrets (passwords) are wiped from the clipboard after 30 s. */
export function CopyButton({ value, label, secret = false }: { value: string; label: string; secret?: boolean }) {
  const { toast } = useToast()
  const [done, setDone] = useState(false)
  const click = async () => {
    if (await copySecret(value, secret ? CLIPBOARD_CLEAR_MS : 0)) {
      setDone(true); setTimeout(() => setDone(false), 1400)
      toast(secret ? `${label} copied — clears from the clipboard in 30 s` : `${label} copied`)
    } else toast('Couldn’t copy — your browser blocked clipboard access.', { kind: 'error' })
  }
  return (
    <button type="button" onClick={() => void click()} disabled={!value} aria-label={`Copy ${label}`} title={`Copy ${label}`}
      className={`inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-line ${done ? 'text-task' : 'text-muted hover:bg-hover hover:text-ink'}`}>
      {done ? <IconCheck size={17} /> : <IconCopy size={17} />}
    </button>
  )
}
