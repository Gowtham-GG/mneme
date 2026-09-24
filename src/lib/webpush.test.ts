// Tests the Edge Functions' Web Push sender (supabase/functions/_shared/webpush.ts) the way a
// browser would receive it: decrypt with the subscription's private key (RFC 8291) and
// verify the VAPID signature (RFC 8292).
import { describe, expect, it } from 'vitest'
import { b64url, encryptPayload, sendPush, unb64url, vapidAuth } from '../../supabase/functions/_shared/webpush'

const enc = new TextEncoder()
const concat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length } return o }
async function hmac(key: Uint8Array, data: Uint8Array) {
  const k = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data as BufferSource))
}
const hkdf = async (salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number) =>
  (await hmac(await hmac(salt, ikm), concat(info, new Uint8Array([1])))).slice(0, len)

async function browserSubscription() {
  const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey))
  const auth = crypto.getRandomValues(new Uint8Array(16))
  return { ua, pub, auth, target: { endpoint: 'https://push.example.com/send/abc123', p256dh: b64url(pub), auth: b64url(auth) } }
}

async function vapidKeys() {
  const k = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair
  const jwk = await crypto.subtle.exportKey('jwk', k.privateKey)
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', k.publicKey))
  return { keys: { publicKey: b64url(pub), privateKey: jwk.d!, subject: 'mailto:me@example.com' }, verifyKey: k.publicKey }
}

/** What the browser does with an aes128gcm push body. */
async function decrypt(body: Uint8Array, ua: CryptoKeyPair, uaPub: Uint8Array, auth: Uint8Array): Promise<string> {
  const salt = body.slice(0, 16)
  const rs = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0)
  const idlen = body[20]
  const asPub = body.slice(21, 21 + idlen)
  const cipher = body.slice(21 + idlen)
  expect(rs).toBe(4096)
  const asKey = await crypto.subtle.importKey('raw', asPub as BufferSource, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, ua.privateKey, 256))
  const ikm = await hkdf(auth, shared, concat(enc.encode('WebPush: info\0'), uaPub, asPub), 32)
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12)
  const aes = await crypto.subtle.importKey('raw', cek as BufferSource, 'AES-GCM', false, ['decrypt'])
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, aes, cipher as BufferSource))
  expect(plain[plain.length - 1]).toBe(2) // last-record delimiter
  return new TextDecoder().decode(plain.slice(0, -1))
}

describe('web push', () => {
  it('encrypts so the browser can decrypt (RFC 8291)', async () => {
    const s = await browserSubscription()
    const body = await encryptPayload(s.target, enc.encode('{"title":"Mneme","body":"Call the bank"}'))
    expect(await decrypt(body, s.ua, s.pub, s.auth)).toBe('{"title":"Mneme","body":"Call the bank"}')
  })

  it('the decryptor above matches the worked example in RFC 8291 §5', async () => {
    const uaPub = unb64url('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4')
    const ua = { privateKey: await crypto.subtle.importKey('jwk', {
      kty: 'EC', crv: 'P-256', d: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94', x: b64url(uaPub.slice(1, 33)), y: b64url(uaPub.slice(33, 65)),
    }, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']) } as CryptoKeyPair
    const body = unb64url('DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN')
    expect(await decrypt(body, ua, uaPub, unb64url('BTBZMqHH6r4Tts7J_aSIgg'))).toBe('When I grow up, I want to be a watermelon')
  })

  it('signs a VAPID JWT the push service can verify (RFC 8292)', async () => {
    const { keys, verifyKey } = await vapidKeys()
    const h = await vapidAuth('https://fcm.googleapis.com/fcm/send/xyz', keys)
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(h)!
    expect(m[4]).toBe(keys.publicKey)
    const claims = JSON.parse(new TextDecoder().decode(unb64url(m[2])))
    expect(claims.aud).toBe('https://fcm.googleapis.com')
    expect(claims.sub).toBe('mailto:me@example.com')
    expect(claims.exp).toBeGreaterThan(Date.now() / 1000)
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verifyKey, unb64url(m[3]) as BufferSource, enc.encode(`${m[1]}.${m[2]}`) as BufferSource)
    expect(ok).toBe(true)
  })

  it('posts to the endpoint with the right headers and reports the status', async () => {
    const s = await browserSubscription()
    const { keys } = await vapidKeys()
    let seen: { url: string; init: RequestInit } | null = null
    const fake = (async (url: string, init: RequestInit) => { seen = { url, init }; return new Response(null, { status: 201 }) }) as unknown as typeof fetch
    const status = await sendPush(s.target, { title: 'Due soon', body: 'Call the bank · 3pm', url: '/tasks?task=T-1', tag: 'task-T-1' }, keys, fake)
    expect(status).toBe(201)
    expect(seen!.url).toBe(s.target.endpoint)
    const h = seen!.init.headers as Record<string, string>
    expect(h['Content-Encoding']).toBe('aes128gcm')
    expect(h.TTL).toBe('86400')
    expect(h.Authorization).toMatch(/^vapid t=/)
    expect(JSON.parse(await decrypt(seen!.init.body as Uint8Array, s.ua, s.pub, s.auth))).toEqual({ title: 'Due soon', body: 'Call the bank · 3pm', url: '/tasks?task=T-1', tag: 'task-T-1' })
  })
})

describe('the inlined copies in each Edge Function', () => {
  it('match _shared/webpush.ts exactly (each function deploys as a single file)', async () => {
    const { readFileSync } = await import('node:fs')
    const root = new URL('../../supabase/functions/', import.meta.url)
    const shared = readFileSync(new URL('_shared/webpush.ts', root), 'utf8').trimEnd()
    for (const fn of ['task-reminders', 'push-test']) {
      const src = readFileSync(new URL(`${fn}/index.ts`, root), 'utf8')
      const m = /\/\/ ---- webpush: inlined copy[^\n]*\n([\s\S]*?)\n\/\/ ---- end webpush ----/.exec(src)
      expect(m, `${fn} has the inlined block`).not.toBeNull()
      expect(m![1], `${fn}'s copy`).toBe(shared)
      expect(src).not.toMatch(/from '\.\.\/_shared\//)
    }
  })
})
