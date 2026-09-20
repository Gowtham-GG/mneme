import { useEffect, useRef, type ReactNode } from 'react'

/** Modal on the native <dialog>: focus trap, Esc to close and inert background come for free. */
export function Dialog({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => { if (e.target === ref.current) onClose() }}
      aria-label={title}
      className={`m-auto w-[calc(100%-2rem)] ${wide ? 'max-w-2xl' : 'max-w-md'} glass-strong rounded-3xl p-0 text-ink`}
    >
      {open && <div className="p-6">{children}</div>}
    </dialog>
  )
}

export function ConfirmDialog({
  open, title, body, confirmLabel, danger, onConfirm, onClose,
}: { open: boolean; title: string; body: ReactNode; confirmLabel: string; danger?: boolean; onConfirm: () => void; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <h2 className="mb-2 text-base font-semibold">{title}</h2>
      <div className="mb-5 text-sm text-muted">{body}</div>
      <div className="flex justify-end gap-2">
        <button className="rounded-xl px-4 py-2 text-sm hover:bg-hover" onClick={onClose}>Cancel</button>
        <button
          className={`rounded-xl px-4 py-2 text-sm font-medium ${danger ? 'bg-danger text-white shadow-lg shadow-danger/30' : 'bg-accent text-on-accent'}`}
          onClick={() => { onConfirm(); onClose() }}
        >{confirmLabel}</button>
      </div>
    </Dialog>
  )
}
