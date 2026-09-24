// Make the key pair for device notifications (Web Push / VAPID):  node scripts/vapid-keys.mjs
// Public key  → Vercel env VITE_VAPID_PUBLIC_KEY  and  Supabase secret MNEME_VAPID_PUBLIC_KEY
// Private key → Supabase secret MNEME_VAPID_PRIVATE_KEY (keep it secret; never commit it)
const b64url = (b) => Buffer.from(b).toString('base64url')
const k = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
const pub = new Uint8Array(await crypto.subtle.exportKey('raw', k.publicKey))
const { d } = await crypto.subtle.exportKey('jwk', k.privateKey)
console.log(`VAPID public key : ${b64url(pub)}`)
console.log(`VAPID private key: ${d}`)
