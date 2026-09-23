import { describe, expect, it } from 'vitest'
import { addDays, addMonths, dayKey, formatMonth, formatTimeOfDay, monthGrid, presetRange, startOfDayISO, taskDueStatus, todayKey, zonedMidnight } from './dates'

describe('dates (timezone aware)', () => {
  it('dayKey uses the given timezone, not the machine', () => {
    // 20:00Z on 10 Sep is already 11 Sep in Kolkata (UTC+5:30) but still 10 Sep in London/NY
    expect(dayKey('2026-09-10T20:00:00Z', 'Asia/Kolkata')).toBe('2026-09-11')
    expect(dayKey('2026-09-10T20:00:00Z', 'America/New_York')).toBe('2026-09-10')
  })
  it('zonedMidnight is the UTC instant a local day starts', () => {
    expect(zonedMidnight(2026, 9, 11, 'Asia/Kolkata').toISOString()).toBe('2026-09-10T18:30:00.000Z')
    expect(zonedMidnight(2026, 9, 10, 'UTC').toISOString()).toBe('2026-09-10T00:00:00.000Z')
    // DST: New York is UTC-4 in September
    expect(zonedMidnight(2026, 9, 10, 'America/New_York').toISOString()).toBe('2026-09-10T04:00:00.000Z')
  })
  it('addDays crosses month/year boundaries', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
  })
  it('presets: today / week / month bounds', () => {
    const now = new Date('2026-09-16T10:00:00Z') // a Wednesday
    const t = presetRange('today', 'UTC', now)
    expect(t).toEqual({ from: '2026-09-16T00:00:00.000Z', to: '2026-09-17T00:00:00.000Z' })
    const w = presetRange('week', 'UTC', now) // Monday 14th .. Monday 21st
    expect(w).toEqual({ from: '2026-09-14T00:00:00.000Z', to: '2026-09-21T00:00:00.000Z' })
    const m = presetRange('month', 'UTC', now)
    expect(m).toEqual({ from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' })
    expect(presetRange('all', 'UTC')).toEqual({ from: null, to: null })
  })
  it('todayKey / startOfDayISO agree', () => {
    const now = new Date('2026-09-10T20:00:00Z')
    expect(todayKey('Asia/Kolkata', now)).toBe('2026-09-11')
    expect(startOfDayISO('2026-09-11', 'Asia/Kolkata')).toBe('2026-09-10T18:30:00.000Z')
  })
  it('taskDueStatus: date-only tasks', () => {
    const now = new Date('2026-09-16T10:00:00Z') // 2026-09-16 in UTC
    expect(taskDueStatus(null, null, 'UTC', now)).toBe('none')
    expect(taskDueStatus('2026-09-15', null, 'UTC', now)).toBe('overdue')
    expect(taskDueStatus('2026-09-16', null, 'UTC', now)).toBe('due-today')
    expect(taskDueStatus('2026-09-17', null, 'UTC', now)).toBe('upcoming')
  })
  it('taskDueStatus: a due time on today only flips to overdue once it has passed', () => {
    const now = new Date('2026-09-16T10:00:00Z') // 10:00 UTC
    expect(taskDueStatus('2026-09-16', '09:00', 'UTC', now)).toBe('overdue')
    expect(taskDueStatus('2026-09-16', '11:00', 'UTC', now)).toBe('due-today')
    // a past due_time on a past day is still just "overdue" (the day already governs)
    expect(taskDueStatus('2026-09-15', '23:00', 'UTC', now)).toBe('overdue')
  })
  it('formatTimeOfDay', () => {
    expect(formatTimeOfDay('09:00')).toBe('9am')
    expect(formatTimeOfDay('00:00')).toBe('12am')
    expect(formatTimeOfDay('13:30')).toBe('1:30pm')
    expect(formatTimeOfDay('23:05')).toBe('11:05pm')
  })
})

describe('month grid', () => {
  it('starts on the Monday on/before the 1st and spans 6 weeks', () => {
    const g = monthGrid('2026-09-23') // 1 Sep 2026 is a Tuesday
    expect(g).toHaveLength(42)
    expect(g[0]).toBe('2026-08-31')
    expect(g[1]).toBe('2026-09-01')
    expect(g[41]).toBe('2026-10-11')
  })
  it('handles a month starting on Monday', () => {
    expect(monthGrid('2026-06-10')[0]).toBe('2026-06-01')
  })
  it('adds months across year boundaries', () => {
    expect(addMonths('2026-12-31', 1)).toBe('2027-01-01')
    expect(addMonths('2026-01-15', -1)).toBe('2025-12-01')
  })
  it('formats a month heading', () => {
    expect(formatMonth('2026-09-01')).toBe('September 2026')
  })
})
