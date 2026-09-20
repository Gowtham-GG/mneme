import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchSettings, saveSettings } from '@/api/settings'
import { useAuth } from '@/hooks/useAuth'
import { browserTimezone, isValidTimezone } from '@/lib/dates'
import { normalizePref, resolveTheme, type ThemeId, type ThemePref } from '@/lib/themes'
import type { Settings } from '@/types/db'

interface SettingsValue {
  timezone: string
  /** what the user chose ('system' = match my device) */
  theme: ThemePref
  /** the concrete theme currently applied */
  activeTheme: ThemeId
  ready: boolean
  update: (patch: { timezone?: string; theme?: ThemePref }) => Promise<void>
}

const SettingsContext = createContext<SettingsValue>({ timezone: 'UTC', theme: 'amethyst', activeTheme: 'amethyst', ready: false, update: async () => {} })
const THEME_KEY = 'mneme-theme'

const prefersDark = () => typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
const storedPref = (): ThemePref => { try { return normalizePref(localStorage.getItem(THEME_KEY)) } catch { return 'amethyst' } }

function applyTheme(pref: ThemePref) {
  document.documentElement.setAttribute('data-theme', resolveTheme(pref, prefersDark()))
  try { localStorage.setItem(THEME_KEY, pref) } catch { /* ignore */ }
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['settings', user?.id], queryFn: fetchSettings, enabled: !!user, staleTime: 5 * 60_000 })
  // Until the account's setting has loaded, use what this device remembers (also what theme-init.js applied).
  const [local, setLocal] = useState<ThemePref>(storedPref)

  const timezone = q.data?.timezone && isValidTimezone(q.data.timezone) ? q.data.timezone : browserTimezone()
  const theme: ThemePref = q.data ? normalizePref(q.data.theme) : local

  const [dark, setDark] = useState(prefersDark)
  useEffect(() => {
    const m = window.matchMedia('(prefers-color-scheme: dark)')
    const on = () => setDark(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])

  useEffect(() => { applyTheme(theme) }, [theme, dark])

  const update = useCallback(async (patch: { timezone?: string; theme?: ThemePref }) => {
    if (patch.theme) { setLocal(patch.theme); applyTheme(patch.theme) } // instant, even before the save returns
    const saved = await saveSettings(patch)
    qc.setQueryData<Settings | null>(['settings', user?.id], saved)
  }, [qc, user?.id])

  // First login: remember the browser's timezone so note IDs / "today" use the user's day.
  useEffect(() => {
    if (!user || !q.isSuccess) return
    if (!q.data || q.data.timezone === 'UTC') {
      const tz = browserTimezone()
      if (tz !== 'UTC' && isValidTimezone(tz)) void update({ timezone: tz }).catch(() => {})
    }
  }, [user, q.isSuccess, q.data, update])

  const value = useMemo(
    () => ({ timezone, theme, activeTheme: resolveTheme(theme, dark), ready: !user || q.isSuccess, update }),
    [timezone, theme, dark, user, q.isSuccess, update],
  )
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useSettings() { return useContext(SettingsContext) }
