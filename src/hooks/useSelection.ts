import { useCallback, useMemo, useState } from 'react'

/** Multi-select state for a list of ids (Notes/Search bulk action bar). */
export function useSelection() {
  const [active, setActive] = useState(false)
  const [ids, setIds] = useState<Set<string>>(new Set())

  const toggle = useCallback((id: string) => {
    setIds((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  }, [])
  const clear = useCallback(() => setIds(new Set()), [])
  const start = useCallback(() => setActive(true), [])
  const stop = useCallback(() => { setActive(false); setIds(new Set()) }, [])

  return useMemo(() => ({
    active, ids, count: ids.size,
    isSelected: (id: string) => ids.has(id),
    toggle, clear, start, stop,
  }), [active, ids, toggle, clear, start, stop])
}
