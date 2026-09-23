import { addDays } from './dates'

/** Is 'YYYY-MM-DD' one of the weekdays in `mask` (Monday = 1 … Sunday = 64)? */
export function isDue(mask: number, day: string): boolean {
  const [y, m, d] = day.split('-').map(Number)
  const iso = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7 // Monday = 0
  return (mask & (1 << iso)) !== 0
}

export interface HabitStats { current: number; best: number; /** share of due days met in the last 30 days, 0–1, null if none were due */ rate30: number | null }

/**
 * Streaks over due days only, walking from `start` to `today` — the same rules
 * as mneme.habits_for_day(): an unmet today doesn't break the current streak.
 */
export function habitStats(values: Map<string, number>, mask: number, target: number, start: string, today: string): HabitStats {
  let run = 0, best = 0, current = 0, due30 = 0, met30 = 0
  const from30 = addDays(today, -29)
  for (let d = start; d <= today; d = addDays(d, 1)) {
    if (!isDue(mask, d)) continue
    const met = (values.get(d) ?? 0) >= target
    if (d >= from30) { due30++; if (met) met30++ }
    if (met) { run++; best = Math.max(best, run) } else if (d !== today) run = 0
  }
  current = run
  return { current, best, rate30: due30 ? met30 / due30 : null }
}
