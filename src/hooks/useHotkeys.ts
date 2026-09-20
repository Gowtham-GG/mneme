import { useEffect, useRef } from 'react'

export interface Hotkey {
  /** e.g. 'mod+n', 'mod+k', 'mod+enter', 'escape', '?' ('mod' = Ctrl on Windows/Linux, Cmd on macOS) */
  combo: string
  handler: (e: KeyboardEvent) => void
  /** fire even when focus is in a text field (default false, except combos using mod) */
  inInputs?: boolean
}

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
}

/** Global keyboard shortcuts. Handlers are read through a ref, so callers need not memoise. */
export function useHotkeys(keys: Hotkey[]) {
  const ref = useRef(keys)
  useEffect(() => { ref.current = keys })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase()
      const mod = e.ctrlKey || e.metaKey
      for (const h of ref.current) {
        const parts = h.combo.toLowerCase().split('+')
        const key = parts[parts.length - 1]
        const wantMod = parts.includes('mod'), wantShift = parts.includes('shift')
        if (k !== key || wantMod !== mod || (wantShift !== e.shiftKey && key.length > 1)) continue
        if (!wantMod && !h.inInputs && (isTyping(e.target) || e.altKey)) continue
        h.handler(e)
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
