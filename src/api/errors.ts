// Error classification for the save engine.
export interface ApiError { message: string; code?: string; details?: string; hint?: string }

export class SaveError extends Error {
  code?: string
  constructor(message: string, code?: string) { super(message); this.code = code; this.name = 'SaveError' }
}

/** Postgres/PostgREST codes that will never succeed on retry (bad data, no permission). */
const PERMANENT = new Set(['23514', '22001', '42501', '22P02', '23502', 'PGRST116'])

export function isPermanent(err: { code?: string } | null | undefined): boolean {
  return !!err?.code && PERMANENT.has(err.code)
}

export function isNetworkish(err: { message?: string } | null | undefined): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true
  return /fetch|network|timeout|load failed|aborted/i.test(err?.message ?? '')
}

export function toError(e: ApiError): SaveError {
  return new SaveError(e.message, e.code)
}
