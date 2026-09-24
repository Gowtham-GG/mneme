// Math for the clock-dial time picker.

/** A point on the dial (relative to its centre, y down) → an hour 0–11 (0 = 12 o'clock) or a minute 0–59. */
export function dialValue(dx: number, dy: number, mode: 'hour' | 'minute'): number {
  const deg = ((Math.atan2(dy, dx) * 180) / Math.PI + 90 + 360) % 360
  return mode === 'hour' ? Math.round(deg / 30) % 12 : Math.round(deg / 6) % 60
}

/** "HH:MM" (24h) → 12-hour parts. */
export function splitTime(hhmm: string): { h12: number; m: number; pm: boolean } {
  const [h, m] = hhmm.split(':').map(Number)
  return { h12: h % 12 === 0 ? 12 : h % 12, m, pm: h >= 12 }
}

/** 12-hour parts → "HH:MM" (24h). */
export function joinTime(h12: number, m: number, pm: boolean): string {
  const h = (h12 % 12) + (pm ? 12 : 0)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}
