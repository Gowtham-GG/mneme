import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'

interface Toast { id: number; message: string; kind: 'info' | 'error'; action?: { label: string; onClick: () => void } }
interface ToastApi { toast: (message: string, opts?: { kind?: 'info' | 'error'; action?: Toast['action']; ms?: number }) => void }

const ToastContext = createContext<ToastApi>({ toast: () => {} })

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([])
  const seq = useRef(0)

  const dismiss = useCallback((id: number) => setItems((l) => l.filter((t) => t.id !== id)), [])
  const toast = useCallback<ToastApi['toast']>((message, opts) => {
    const id = ++seq.current
    setItems((l) => [...l.slice(-2), { id, message, kind: opts?.kind ?? 'info', action: opts?.action }])
    setTimeout(() => dismiss(id), opts?.ms ?? 5000)
  }, [dismiss])

  const api = useMemo(() => ({ toast }), [toast])
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div aria-live="polite" role="status" className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 px-4 pb-[calc(env(safe-area-inset-bottom)+5.75rem)]">
        {items.map((t) => (
          <div key={t.id} className={`pop pointer-events-auto flex max-w-md items-center gap-3 glass-strong rounded-2xl px-4 py-3 text-sm font-medium ${t.kind === 'error' ? 'text-danger' : 'text-ink'}`}>
            <span>{t.message}</span>
            {t.action && (
              <button className="font-semibold text-accent hover:underline" onClick={() => { t.action!.onClick(); dismiss(t.id) }}>{t.action.label}</button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useToast() { return useContext(ToastContext) }
