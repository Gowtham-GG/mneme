import { describe, expect, it } from 'vitest'
import { habitStats, isDue, logStep, rhythmLabel, tallySteps } from './habits'
import type { HabitStep } from '@/types/db'

const EVERY = 127
const MWF = 1 | 4 | 16
const m = (o: Record<string, number>) => new Map(Object.entries(o))

describe('habits', () => {
  it('knows weekdays', () => {
    expect(isDue(MWF, '2026-09-21')).toBe(true)   // Monday
    expect(isDue(MWF, '2026-09-22')).toBe(false)  // Tuesday
    expect(isDue(EVERY, '2026-09-27')).toBe(true) // Sunday
  })
  it('counts the current streak without breaking on an unfinished today', () => {
    const s = habitStats(m({ '2026-09-21': 1, '2026-09-22': 1, '2026-09-23': 1 }), EVERY, 1, '2026-09-15', '2026-09-24')
    expect(s.current).toBe(3)
    expect(s.best).toBe(3)
  })
  it('keeps the best streak after a break', () => {
    const s = habitStats(m({ '2026-09-10': 1, '2026-09-11': 1, '2026-09-12': 1, '2026-09-13': 1, '2026-09-23': 1, '2026-09-24': 1 }), EVERY, 1, '2026-09-10', '2026-09-24')
    expect(s.current).toBe(2)
    expect(s.best).toBe(4)
  })
  it('skips days the habit is not due on', () => {
    const s = habitStats(m({ '2026-09-14': 1, '2026-09-16': 1, '2026-09-18': 1, '2026-09-21': 1, '2026-09-23': 1 }), MWF, 1, '2026-09-14', '2026-09-24')
    expect(s.current).toBe(5)
  })
  it('only counts days that reached the target', () => {
    const s = habitStats(m({ '2026-09-22': 8, '2026-09-23': 5 }), EVERY, 8, '2026-09-22', '2026-09-24')
    expect(s.current).toBe(0)
    expect(s.best).toBe(1)
    expect(s.rate30).toBeCloseTo(1 / 3)
  })
  it('passes over skipped days (a pause) instead of breaking the streak', () => {
    const vals = m({ '2026-09-20': 1, '2026-09-21': 1, '2026-09-24': 1 })
    expect(habitStats(vals, EVERY, 1, '2026-09-20', '2026-09-24').current).toBe(1)
    expect(habitStats(vals, EVERY, 1, '2026-09-20', '2026-09-24', new Set(['2026-09-22', '2026-09-23'])).current).toBe(3)
  })
  it('names rhythms', () => {
    expect(rhythmLabel(127)).toBe('Every day')
    expect(rhythmLabel(31)).toBe('Weekdays')
    expect(rhythmLabel(96)).toBe('Weekends')
    expect(rhythmLabel(MWF)).toBe('Mon, Wed, Fri')
  })

  const step = (id: string, over: Partial<HabitStep> = {}): HabitStep =>
    ({ id, title: id, done: false, value: 0, target: 1, unit: null, days: null, steps: [], ...over })
  // Upper body: bench (3 sets) + rows
  const day = () => [step('upper', { steps: [step('bench', { target: 3, unit: 'sets' }), step('rows')] })]

  it('tallies the leaf steps of a routine', () => {
    expect(tallySteps(day())).toEqual([0, 2])
    expect(tallySteps(logStep(day(), 'rows', 1))).toEqual([1, 2])
  })

  it('a counted step finishes at its target, and its group with it', () => {
    let s = logStep(day(), 'rows', 1)
    s = logStep(s, 'bench', 1)
    expect(s[0].steps[0]).toMatchObject({ value: 1, done: false })
    expect(s[0].done).toBe(false)
    s = logStep(s, 'bench', 5)
    expect(s[0].steps[0]).toMatchObject({ value: 3, done: true })
    expect(s[0].done).toBe(true)
    expect(logStep(s, 'bench', -1)[0].done).toBe(false)
  })

  it('ticking a group fills everything in it; unticking clears it', () => {
    const on = logStep(day(), 'upper', 1)
    expect(on[0]).toMatchObject({ done: true })
    expect(on[0].steps[0]).toMatchObject({ value: 3, done: true })
    expect(tallySteps(logStep(on, 'upper', -1))).toEqual([0, 2])
  })
})
