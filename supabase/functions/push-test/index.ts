// Settings → Notifications → "Send a test": pushes a test notification to every
// device of the signed-in user. Deployed with JWT verification on (the default):
//   supabase functions deploy push-test
// Secrets: MNEME_VAPID_PUBLIC_KEY / MNEME_VAPID_PRIVATE_KEY / MNEME_VAPID_SUBJECT
// (the same ones task-reminders uses).

import { createClient } from 'npm:@supabase/supabase-js@2'

// ---- webpush: inlined copy of ../_shared/webpush.ts (a function deploys as one file; src/lib/webpush.test.ts keeps the copies identical) ----
// Web Push with nothing but WebCrypto + fetch (runs in Supabase Edge Functions
// and in Node 18+): VAPID (RFC 8292) + aes128gcm payload encryption (RFC 8291).

export interface PushTarget { endpoint: string; p256dh: string; auth: string }
export interface VapidKeys { publicKey: string; privateKey: string; subject: string }

const enc = new TextEncoder()
/** bytes backed by a plain ArrayBuffer (what WebCrypto and fetch accept) */
type Bytes = Uint8Array<ArrayBuffer>

export function b64url(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function unb64url(s: string): Bytes {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4))
  const out = new Uint8Array(b.length)
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i)
  return out
}

const concat = (...parts: Uint8Array[]): Bytes => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

async function hmac(key: Bytes, data: Bytes): Promise<Bytes> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data))
}

/** HKDF (RFC 5869) with a single expand block (≤ 32 bytes out). */
async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, len: number): Promise<Bytes> {
  const prk = await hmac(salt, ikm)
  return (await hmac(prk, concat(info, new Uint8Array([1])))).slice(0, len)
}

/** The VAPID "Authorization" header value for this endpoint (ES256 JWT, 12 h). */
export async function vapidAuth(endpoint: string, keys: VapidKeys): Promise<string> {
  const pub = unb64url(keys.publicKey)
  const jwk = { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: b64url(pub.slice(1, 33)), y: b64url(pub.slice(33, 65)), ext: true }
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  const head = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const body = b64url(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: keys.subject })))
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${body}`)))
  return `vapid t=${head}.${body}.${b64url(sig)}, k=${keys.publicKey}`
}

/** Encrypt `payload` for one subscription (RFC 8291, a single aes128gcm record). */
export async function encryptPayload(target: PushTarget, payload: Uint8Array): Promise<Bytes> {
  const uaPublic = unb64url(target.p256dh)
  const authSecret = unb64url(target.auth)
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey))
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, eph.privateKey, 256))

  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32)
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12)
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt'])
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(payload, new Uint8Array([2]))))

  const rs = new Uint8Array(4)
  new DataView(rs.buffer).setUint32(0, 4096)
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher)
}

export interface PushMessage { title: string; body: string; url?: string; tag?: string }

/**
 * Send one notification. Resolves to the push service's status:
 * 201/200 delivered · 404/410 the subscription is gone (drop it) · others = try again later.
 */
export async function sendPush(target: PushTarget, msg: PushMessage, keys: VapidKeys, fetcher: typeof fetch = fetch): Promise<number> {
  const body = await encryptPayload(target, enc.encode(JSON.stringify(msg)))
  const res = await fetcher(target.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidAuth(target.endpoint, keys),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400',
      Urgency: 'high',
      ...(msg.tag ? { Topic: msg.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) } : {}),
    },
    body,
  })
  await res.body?.cancel()
  return res.status
}
// ---- end webpush ----


const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { db: { schema: 'mneme' } })
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  const { data: who, error: authErr } = await supabase.auth.getUser(token)
  if (authErr || !who.user) return json({ error: 'not signed in' }, 401)

  const pub = Deno.env.get('MNEME_VAPID_PUBLIC_KEY'), priv = Deno.env.get('MNEME_VAPID_PRIVATE_KEY')
  if (!pub || !priv) return json({ error: 'notifications are not set up on the server' }, 503)
  const keys = { publicKey: pub, privateKey: priv, subject: Deno.env.get('MNEME_VAPID_SUBJECT') ?? 'mailto:mneme@example.com' }

  const { data, error } = await supabase.rpc('push_targets', { p_user_ids: [who.user.id] })
  if (error) return json({ error: error.message }, 500)
  let sent = 0
  for (const d of (data ?? []) as PushTarget[]) {
    try {
      const status = await sendPush(d, { title: 'Mneme', body: 'Notifications work on this device ✓', url: '/settings', tag: 'test' }, keys)
      if (status === 404 || status === 410) await supabase.rpc('push_result', { p_endpoint: d.endpoint, p_ok: false })
      else if (status >= 200 && status < 300) { sent++; await supabase.rpc('push_result', { p_endpoint: d.endpoint, p_ok: true }) }
    } catch { /* one bad device shouldn't stop the rest */ }
  }
  return json({ sent })
})
