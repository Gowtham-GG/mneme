import { createClient } from '@supabase/supabase-js'
import { readSupabaseEnv } from './env'

const env = readSupabaseEnv(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY)

/** null when configured; otherwise a human-readable reason (shown on the login screen instead of a blank page). */
export const supabaseConfigError = env.error
export const supabaseConfigured = env.error === null

if (env.error) console.error(`[Mneme] ${env.error}`)

// Same project (and same auth users) as Argus, but every data call goes to the dedicated `mneme` schema.
// The service-role key is never used in the browser. A misconfigured build still gets a (dummy) client so
// the app can render the explanation.
export const supabase = createClient(env.url || 'http://localhost', env.key || 'missing', {
  db: { schema: 'mneme' },
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storageKey: 'mneme-auth',
  },
})
