// Timezone-aware date helpers without a tz library (Intl only).
// "Today" for a note-taker means the day in THEIR timezone (settings.timezone).

interface Parts { y: number; m: number; d: number; h: number; mi: number; s: number }

function parts(date: Date, tz: string): Parts {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const o: Record<string, number> = {}
  for (const p of f.formatToParts(date)) if (p.type !== 'literal') o[p.type] = Number(p.value)
  return { y: o.year, m: o.month, d: o.day, h: o.hour % 24, mi: o.minute, s: o.second }
}

export function browserTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' }
}

export function isValidTimezone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true } catch { return false }
}

function offsetMs(date: Date, tz: string): number {
  const p = parts(date, tz)
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(date.getTime() / 1000) * 1000
}

/** The instant at which local calendar day y-m-d begins in `tz`. */
export function zonedMidnight(y: number, m: number, d: number, tz: string): Date {
  const utc = Date.UTC(y, m - 1, d)
  let guess = utc - offsetMs(new Date(utc), tz)
  guess = utc - offsetMs(new Date(guess), tz)
  return new Date(guess)
}

/** 'YYYY-MM-DD' of an instant in tz. */
export function dayKey(iso: string | Date, tz: string): string {
  const p = parts(typeof iso === 'string' ? new Date(iso) : iso, tz)
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`
}

export function todayKey(tz: string, now: Date = new Date()): string {
  return dayKey(now, tz)
}

/** Add whole days to a 'YYYY-MM-DD' key (calendar arithmetic, tz independent). */
export function addDays(key: string, n: number): string {
  const [y, m, d] = key.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + n))
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`
}

/** UTC ISO instant for the start of local day `key`. */
export function startOfDayISO(key: string, tz: string): string {
  const [y, m, d] = key.split('-').map(Number)
  return zonedMidnight(y, m, d, tz).toISOString()
}

export type RangePreset = 'all' | 'today' | 'yesterday' | 'week' | 'month'

/** [from inclusive, to exclusive] as ISO strings, or nulls for 'all'. */
export function presetRange(preset: RangePreset, tz: string, now: Date = new Date()): { from: string | null; to: string | null } {
  if (preset === 'all') return { from: null, to: null }
  const today = todayKey(tz, now)
  if (preset === 'today') return { from: startOfDayISO(today, tz), to: startOfDayISO(addDays(today, 1), tz) }
  if (preset === 'yesterday') return { from: startOfDayISO(addDays(today, -1), tz), to: startOfDayISO(today, tz) }
  if (preset === 'week') {
    const [y, m, d] = today.split('-').map(Number)
    const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7 // Monday = 0
    const start = addDays(today, -dow)
    return { from: startOfDayISO(start, tz), to: startOfDayISO(addDays(start, 7), tz) }
  }
  const [y, m] = today.split('-').map(Number)
  const first = `${y}-${String(m).padStart(2, '0')}-01`
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`
  return { from: startOfDayISO(first, tz), to: startOfDayISO(next, tz) }
}

export function formatTime(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso))
}

/** "Sunday, 20 September" (+ year when not the current one). */
export function formatDayHeading(key: string, tz: string, now: Date = new Date()): string {
  const [y, m, d] = key.split('-').map(Number)
  const today = todayKey(tz, now)
  if (key === today) return 'Today'
  if (key === addDays(today, -1)) return 'Yesterday'
  const sameYear = y === Number(today.slice(0, 4))
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', ...(sameYear ? {} : { year: 'numeric' }),
  }).format(new Date(Date.UTC(y, m - 1, d)))
}

export function formatLongDate(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(iso))
}

export function formatDueDate(key: string, tz: string, now: Date = new Date()): string {
  const today = todayKey(tz, now)
  if (key === today) return 'Today'
  if (key === addDays(today, 1)) return 'Tomorrow'
  if (key === addDays(today, -1)) return 'Yesterday'
  const [y, m, d] = key.split('-').map(Number)
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', ...(y === Number(today.slice(0, 4)) ? {} : { year: 'numeric' }) })
    .format(new Date(Date.UTC(y, m - 1, d)))
}

/** "Sunday, 20 September" — always the calendar date (never "Today"). */
export function formatFullDate(key: string): string {
  const [y, m, d] = key.split('-').map(Number)
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(Date.UTC(y, m - 1, d)))
}
