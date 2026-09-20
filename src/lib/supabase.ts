import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string

export const supabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey)

if (!supabaseConfigured) {
  console.error(
    'Missing Supabase env vars. Copy .env.example to .env.local and set ' +
      'VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.',
  )
}

// Same project (and same auth users) as Argus, but every data call goes to the
// dedicated `mneme` schema. The service-role key is never used in the browser.
export const supabase = createClient(supabaseUrl ?? 'http://localhost', supabaseAnonKey ?? 'missing', {
  db: { schema: 'mneme' },
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storageKey: 'mneme-auth',
  },
})
