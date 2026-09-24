import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchSettings, saveSettings, type SettingsPatch } from '@/api/settings'
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
  remindersEnabled: boolean
  reminderLeadMinutes: number
  reminderMorningTime: string
  showStreaks: boolean
  backupEnabled: boolean
  backupWeekday: number
  ready: boolean
  update: (patch: SettingsPatch) => Promise<void>
}

const SettingsContext = createContext<SettingsValue>({
  timezone: 'UTC', theme: 'amethyst', activeTheme: 'amethyst',
  remindersEnabled: false, reminderLeadMinutes: 60, reminderMorningTime: '09:00', showStreaks: true, backupEnabled: false, backupWeekday: 7,
  ready: false, update: async () => {},
})
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
  const remindersEnabled = q.data?.reminders_enabled ?? false
  const reminderLeadMinutes = q.data?.reminder_lead_minutes ?? 60
  const reminderMorningTime = q.data?.reminder_morning_time ?? '09:00'
  const showStreaks = q.data?.show_streaks ?? true
  const backupEnabled = q.data?.backup_enabled ?? false
  const backupWeekday = q.data?.backup_weekday ?? 7

  const [dark, setDark] = useState(prefersDark)
  useEffect(() => {
    const m = window.matchMedia('(prefers-color-scheme: dark)')
    const on = () => setDark(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])

  useEffect(() => { applyTheme(theme) }, [theme, dark])

  const update = useCallback(async (patch: SettingsPatch) => {
    if (patch.theme) { setLocal(patch.theme); applyTheme(patch.theme) } // instant, even before the save returns
    // every toggle reflects the change at once; put it back if the save fails
    const key = ['settings', user?.id]
    const before = qc.getQueryData<Settings | null>(key)
    if (before) qc.setQueryData<Settings | null>(key, { ...before, ...patch })
    try {
      qc.setQueryData<Settings | null>(key, await saveSettings(patch))
    } catch (e) {
      qc.setQueryData<Settings | null>(key, before)
      throw e
    }
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
    () => ({
      timezone, theme, activeTheme: resolveTheme(theme, dark),
      remindersEnabled, reminderLeadMinutes, reminderMorningTime, showStreaks, backupEnabled, backupWeekday,
      ready: !user || q.isSuccess, update,
    }),
    [timezone, theme, dark, remindersEnabled, reminderLeadMinutes, reminderMorningTime, showStreaks, backupEnabled, backupWeekday, user, q.isSuccess, update],
  )
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useSettings() { return useContext(SettingsContext) }
