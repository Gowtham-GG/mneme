import { addDays } from './dates'
import type { HabitStep, TaskItem } from '@/types/db'

/** Is 'YYYY-MM-DD' one of the weekdays in `mask` (Monday = 1 … Sunday = 64)? */
export function isDue(mask: number, day: string): boolean {
  const [y, m, d] = day.split('-').map(Number)
  const iso = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7 // Monday = 0
  return (mask & (1 << iso)) !== 0
}

/** Not on today: a habit's step on other days, or a routine whose steps all are (its rest day). */
export function offToday(t: TaskItem, today: string): boolean {
  return t.due_days !== null && !isDue(t.due_days, today) && (t.rhythm_days === null || t.child_count > 0)
}

const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/** "Every day" · "Weekdays" · "Weekends" · "Mon, Wed, Fri". */
export function rhythmLabel(mask: number): string {
  if (mask === 127) return 'Every day'
  if (mask === 31) return 'Weekdays'
  if (mask === 96) return 'Weekends'
  return DAY_SHORT.filter((_, i) => mask & (1 << i)).join(', ')
}

export interface HabitStats { current: number; best: number; /** share of due days met in the last 30 days, 0–1, null if none were due */ rate30: number | null }

/**
 * Streaks over due days only, walking from `start` to `today` — the same rules
 * as mneme.rhythm_streak(): an unmet today doesn't break the current streak, and
 * `skipped` days (the habit was set aside) are passed over like days off.
 */
export function habitStats(values: Map<string, number>, mask: number, target: number, start: string, today: string, skipped: Set<string> = new Set()): HabitStats {
  let run = 0, best = 0, current = 0, due30 = 0, met30 = 0
  const from30 = addDays(today, -29)
  for (let d = start; d <= today; d = addDays(d, 1)) {
    if (!isDue(mask, d) || skipped.has(d)) continue
    const met = (values.get(d) ?? 0) >= target
    if (d >= from30) { due30++; if (met) met30++ }
    if (met) { run++; best = Math.max(best, run) } else if (d !== today) run = 0
  }
  current = run
  return { current, best, rate30: due30 ? met30 / due30 : null }
}

/** A routine's leaf steps that are on for the day: [done, total]. */
export function tallySteps(steps: HabitStep[]): [number, number] {
  let done = 0, total = 0
  for (const s of steps) {
    if (s.steps.length) { const [d, t] = tallySteps(s.steps); done += d; total += t }
    else { total++; if (s.done) done++ }
  }
  return [done, total]
}

/** A step with everything in it ticked (counts filled) or cleared — what ticking the whole routine does. */
export function fillStep(s: HabitStep, on: boolean): HabitStep {
  return s.steps.length ? { ...s, done: on, steps: s.steps.map((c) => fillStep(c, on)) } : { ...s, done: on, value: on ? s.target : 0 }
}

/**
 * The day's steps after logging `delta` on step `id` — what check_in() will store, applied
 * up front so the strip reacts instantly. A group ticks (+) or unticks (−) everything in it,
 * a counted step moves within 0…target, a plain one ticks or unticks; groups above re-settle.
 */
export function logStep(steps: HabitStep[], id: string, delta: number): HabitStep[] {
  return steps.map((s) => {
    if (s.id === id) {
      if (s.steps.length) return fillStep(s, delta > 0)
      const value = Math.max(0, Math.min(s.target, s.value + delta))
      return { ...s, value, done: value >= s.target }
    }
    if (!s.steps.length) return s
    const kids = logStep(s.steps, id, delta)
    return kids.every((c, i) => c === s.steps[i]) ? s : { ...s, steps: kids, done: kids.every((c) => c.done) }
  })
}
