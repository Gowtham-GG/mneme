import { describe, expect, it } from 'vitest'
import { habitStats, isDue } from './habits'

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
})
