import { useEffect, useState } from 'react'

export function useMedia(query: string): boolean {
  const [match, setMatch] = useState(() => (typeof window !== 'undefined' ? window.matchMedia(query).matches : false))
  useEffect(() => {
    const m = window.matchMedia(query)
    const on = () => setMatch(m.matches)
    on()
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [query])
  return match
}

/** ≥1024px: three-pane desktop layout. */
export const useIsDesktop = () => useMedia('(min-width: 1024px)')
