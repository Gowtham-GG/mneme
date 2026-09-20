import { describe, expect, it } from 'vitest'
import { readSupabaseEnv } from './env'

const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
const jwt = (role: string) => `${b64({ alg: 'HS256' })}.${b64({ role })}.sig`

describe('readSupabaseEnv', () => {
  it('accepts a correct pair unchanged', () => {
    expect(readSupabaseEnv('https://abcd.supabase.co', jwt('anon'))).toMatchObject({ url: 'https://abcd.supabase.co', error: null })
  })
  it('repairs the usual paste mistakes', () => {
    expect(readSupabaseEnv('abcd.supabase.co', 'k').url).toBe('https://abcd.supabase.co')        // no protocol
    expect(readSupabaseEnv('  "https://abcd.supabase.co/"  ', 'k').url).toBe('https://abcd.supabase.co') // quotes, spaces, slash
    expect(readSupabaseEnv('https://abcd.supabase.co/rest/v1', 'k').url).toBe('https://abcd.supabase.co') // copied API path
    expect(readSupabaseEnv('https://abcd.supabase.co', "'sb_publishable_x' ").key).toBe('sb_publishable_x')
  })
  it('explains what is missing or wrong instead of throwing', () => {
    expect(readSupabaseEnv(undefined, 'k').error).toMatch(/VITE_SUPABASE_URL is not set/)
    expect(readSupabaseEnv('https://x.supabase.co', '').error).toMatch(/VITE_SUPABASE_ANON_KEY is not set/)
    expect(readSupabaseEnv('not a url at all', 'k').error).toMatch(/isn’t a valid address/)
  })
  it('refuses a service_role key', () => {
    expect(readSupabaseEnv('https://x.supabase.co', jwt('service_role')).error).toMatch(/service_role/)
    expect(readSupabaseEnv('https://x.supabase.co', jwt('anon')).error).toBeNull()
  })
})
