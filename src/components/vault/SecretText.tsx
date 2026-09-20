import { useEffect, useState } from 'react'
import { IconEye, IconEyeOff } from '../icons'
import { CopyButton } from './CopyButton'

/** A masked password with a reveal toggle (auto-hides after 15 s) and a copy button. The mask never leaks the length. */
export function SecretText({ value, label = 'password' }: { value: string; label?: string }) {
  const [show, setShow] = useState(false)
  useEffect(() => {
    if (!show) return
    const t = setTimeout(() => setShow(false), 15_000)
    return () => clearTimeout(t)
  }, [show])
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className={`min-w-0 flex-1 truncate rounded-lg bg-panel px-3 py-2 ${show ? 'font-mono text-[13px]' : 'text-sm tracking-[0.25em] text-muted'}`} aria-label={show ? label : `${label} hidden`}>
        {value ? (show ? value : '••••••••••') : <span className="tracking-normal text-faint">—</span>}
      </span>
      <button type="button" onClick={() => setShow((v) => !v)} disabled={!value} aria-pressed={show} aria-label={show ? `Hide ${label}` : `Show ${label}`} title={show ? 'Hide' : 'Show'}
        className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-line text-muted hover:bg-hover hover:text-ink">
        {show ? <IconEyeOff size={17} /> : <IconEye size={17} />}
      </button>
      <CopyButton value={value} label={label} secret />
    </div>
  )
}
