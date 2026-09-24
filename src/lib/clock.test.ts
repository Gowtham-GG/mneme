import { describe, expect, it } from 'vitest'
import { dialValue, joinTime, splitTime } from './clock'

describe('dialValue', () => {
  it('reads hours round the dial', () => {
    expect(dialValue(0, -1, 'hour')).toBe(0) // 12 o'clock
    expect(dialValue(1, 0, 'hour')).toBe(3)
    expect(dialValue(0, 1, 'hour')).toBe(6)
    expect(dialValue(-1, 0, 'hour')).toBe(9)
    expect(dialValue(-0.5, -0.87, 'hour')).toBe(11)
  })
  it('reads minutes to the minute', () => {
    expect(dialValue(1, 0, 'minute')).toBe(15)
    expect(dialValue(0, 1, 'minute')).toBe(30)
    expect(dialValue(-0.01, -1, 'minute')).toBe(0) // just before 12 rounds to :00, not :60
  })
})

describe('splitTime / joinTime', () => {
  it('round-trips through 12-hour parts', () => {
    expect(splitTime('00:05')).toEqual({ h12: 12, m: 5, pm: false })
    expect(splitTime('12:30')).toEqual({ h12: 12, m: 30, pm: true })
    expect(splitTime('17:45')).toEqual({ h12: 5, m: 45, pm: true })
    expect(joinTime(12, 0, false)).toBe('00:00')
    expect(joinTime(12, 15, true)).toBe('12:15')
    expect(joinTime(9, 7, true)).toBe('21:07')
  })
})
