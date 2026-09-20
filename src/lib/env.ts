// Reads the two Supabase settings defensively. Hosting dashboards make it easy to paste them slightly wrong
// (no https://, wrapped in quotes, trailing slash, whitespace); a bad value must produce a readable message,
// never a blank page.

export interface SupabaseEnv { url: string; key: string; error: string | null }

const strip = (v: unknown) => String(v ?? '').trim().replace(/^["'`]+|["'`]+$/g, '').trim()

export function readSupabaseEnv(rawUrl: unknown, rawKey: unknown): SupabaseEnv {
  let url = strip(rawUrl)
  const key = strip(rawKey)
  if (!url) return { url: '', key, error: 'VITE_SUPABASE_URL is not set. Add it in Vercel → Settings → Environment Variables, then redeploy.' }
  if (!key) return { url, key: '', error: 'VITE_SUPABASE_ANON_KEY is not set. Add it in Vercel → Settings → Environment Variables, then redeploy.' }

  if (!/^https?:\/\//i.test(url)) url = `https://${url}` // "abcd.supabase.co" → https://abcd.supabase.co
  url = url.replace(/\/+$/, '').replace(/\/(rest|auth)\/v1$/i, '')
  try {
    const u = new URL(url)
    if (!u.hostname.includes('.') && u.hostname !== 'localhost') throw new Error('bad host')
  } catch {
    return { url: '', key, error: `VITE_SUPABASE_URL isn’t a valid address (got “${strip(rawUrl).slice(0, 48)}”). It should look like https://<project-ref>.supabase.co` }
  }
  if (/service_role/i.test(key) || (key.split('.').length === 3 && safeRole(key) === 'service_role')) {
    return { url, key: '', error: 'That looks like the service_role key. Use the public anon key — the service_role key must never be in a browser app.' }
  }
  return { url, key, error: null }
}

function safeRole(jwt: string): string | null {
  try { return (JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) as { role?: string }).role ?? null } catch { return null }
}
