// End-to-end encryption for the Passwords vault. Runs in the browser with the standard WebCrypto API only
// (no crypto dependencies). The server never sees the passphrase, the key, or any plaintext.
//
//   passphrase --PBKDF2-SHA256 (salt, N iterations)--> 256-bit AES-GCM key (non-extractable, memory only)
//   each credential  -> AES-256-GCM, random 96-bit IV, AAD = "user + record id"   -> "v1.<iv>.<ciphertext>"
//
// The AAD binds every ciphertext to its owner and row id, so a malicious database cannot swap or replay records
// between rows/users without decryption failing. GCM authenticates: any tampering is detected.

const subtle = globalThis.crypto.subtle
const te = new TextEncoder()
const td = new TextDecoder()

export const KDF_ITERATIONS = 600_000 // OWASP 2023 guidance for PBKDF2-HMAC-SHA256
export const SALT_BYTES = 16
const CHECK_TEXT = 'mneme-vault-check-v1'

// ---------------------------------------------------------------- encoding ----
export function toB64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}
export function fromB64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n)
  globalThis.crypto.getRandomValues(out)
  return out
}
export const newSalt = () => toB64(randomBytes(SALT_BYTES))

// -------------------------------------------------------------------- keys ----
/** Derive the vault key. NFKC-normalising the passphrase makes the same typed text derive the same key on every device. */
export async function deriveVaultKey(passphrase: string, saltB64: string, iterations: number): Promise<CryptoKey> {
  const material = await subtle.importKey('raw', te.encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveKey'])
  return subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: fromB64(saltB64), iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false, // non-extractable: JavaScript can use the key but never read its bytes
    ['encrypt', 'decrypt'],
  )
}

// ----------------------------------------------------------------- sealing ----
export const aadItem = (userId: string, itemId: string) => `mneme-vault:v1:item:${userId}:${itemId}`
export const aadCheck = (userId: string) => `mneme-vault:v1:check:${userId}`

async function seal(key: CryptoKey, plaintext: string, aad: string): Promise<string> {
  const iv = randomBytes(12) // fresh random IV for every encryption
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(aad) }, key, te.encode(plaintext)))
  return `v1.${toB64(iv)}.${toB64(ct)}`
}

async function open(key: CryptoKey, payload: string, aad: string): Promise<string> {
  const parts = payload.split('.')
  if (parts.length !== 3 || parts[0] !== 'v1') throw new Error('Unsupported vault record')
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: fromB64(parts[1]), additionalData: te.encode(aad) }, key, fromB64(parts[2]))
  return td.decode(pt)
}

/** A known ciphertext stored next to the KDF parameters: it decrypts only under the right passphrase. */
export const makeCheck = (key: CryptoKey, userId: string) => seal(key, CHECK_TEXT, aadCheck(userId))

export async function verifyCheck(key: CryptoKey, userId: string, payload: string): Promise<boolean> {
  try { return (await open(key, payload, aadCheck(userId))) === CHECK_TEXT } catch { return false }
}

export interface VaultSecret { site: string; username: string; password: string; notes: string }

export const sealItem = (key: CryptoKey, userId: string, itemId: string, s: VaultSecret) =>
  seal(key, JSON.stringify({ v: 1, site: s.site, username: s.username, password: s.password, notes: s.notes }), aadItem(userId, itemId))

export async function openItem(key: CryptoKey, userId: string, itemId: string, payload: string): Promise<VaultSecret> {
  const o = JSON.parse(await open(key, payload, aadItem(userId, itemId))) as Partial<VaultSecret> & { v?: number }
  if (o.v !== 1) throw new Error('Unsupported vault record version')
  return { site: String(o.site ?? ''), username: String(o.username ?? ''), password: String(o.password ?? ''), notes: String(o.notes ?? '') }
}

// --------------------------------------------------------------- generator ----
export interface GenOptions { length: number; upper: boolean; lower: boolean; digits: boolean; symbols: boolean; avoidAmbiguous: boolean }
export const DEFAULT_GEN: GenOptions = { length: 20, upper: true, lower: true, digits: true, symbols: true, avoidAmbiguous: true }

const SETS = {
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  lower: 'abcdefghijklmnopqrstuvwxyz',
  digits: '0123456789',
  symbols: '!@#$%^&*()-_=+[]{};:,.?',
}
const AMBIGUOUS = /[Il1O0o|`'"]/g

/** Uniform random integer in [0, n) — rejection sampling, so no modulo bias. */
export function randomInt(n: number): number {
  if (n <= 0 || n > 0x100000000) throw new RangeError('randomInt range')
  const limit = Math.floor(0x100000000 / n) * n
  const buf = new Uint32Array(1)
  do { globalThis.crypto.getRandomValues(buf) } while (buf[0] >= limit)
  return buf[0] % n
}

export function charsetsFor(o: GenOptions): string[] {
  const sets = (['upper', 'lower', 'digits', 'symbols'] as const).filter((k) => o[k]).map((k) => (o.avoidAmbiguous ? SETS[k].replace(AMBIGUOUS, '') : SETS[k]))
  return sets.length ? sets : [o.avoidAmbiguous ? SETS.lower.replace(AMBIGUOUS, '') : SETS.lower, SETS.digits]
}

export function generatePassword(o: GenOptions): string {
  const sets = charsetsFor(o)
  const length = Math.min(128, Math.max(sets.length, Math.floor(o.length) || 20))
  const all = sets.join('')
  const chars: string[] = sets.map((s) => s[randomInt(s.length)]) // at least one of every chosen class
  while (chars.length < length) chars.push(all[randomInt(all.length)])
  for (let i = chars.length - 1; i > 0; i--) { const j = randomInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]] } // Fisher–Yates
  return chars.join('')
}

// ---------------------------------------------------------------- strength ----
export interface Strength { bits: number; score: 0 | 1 | 2 | 3 | 4; label: 'Very weak' | 'Weak' | 'Fair' | 'Strong' | 'Excellent' }

const COMMON = ['password', 'passw0rd', 'qwerty', 'letmein', 'welcome', 'admin', 'iloveyou', 'monkey', 'dragon', 'football', 'login', 'master', 'secret', 'abc', 'trustno', 'sunshine', 'princess', 'starwars', 'whatever', 'mneme']

/** True when the letters can be split entirely into common words ("passwordpassword", "qwertyadmin"). */
function madeOfCommonWords(bare: string): boolean {
  const ok = new Array<boolean>(bare.length + 1).fill(false)
  ok[0] = true
  for (let i = 1; i <= bare.length; i++) ok[i] = COMMON.some((c) => i >= c.length && ok[i - c.length] && bare.endsWith(c, i))
  return ok[bare.length]
}

/** A conservative ESTIMATE (heuristic, not a guarantee): random characters count by pool size, sequences/repeats and
 *  common words are penalised, and short secrets are capped. Multi-word passphrases count ~12 bits per word. */
export function estimateStrength(pw: string): Strength {
  let bits = 0
  if (pw) {
    const pool = (/[a-z]/.test(pw) ? 26 : 0) + (/[A-Z]/.test(pw) ? 26 : 0) + (/[0-9]/.test(pw) ? 10 : 0) + (/[^A-Za-z0-9]/.test(pw) ? 33 : 0)
    let penalty = 0
    for (let i = 1; i < pw.length; i++) {
      const d = pw.charCodeAt(i) - pw.charCodeAt(i - 1)
      if (d === 0 || d === 1 || d === -1) penalty++ // aa, abc, 321
    }
    bits = Math.max(0, pw.length - penalty * 0.7) * Math.log2(Math.max(pool, 2))
    const words = pw.trim().split(/[\s\-_.]+/).filter(Boolean)
    if (words.length >= 3 && words.every((w) => /^[A-Za-z]{3,}$/.test(w))) bits = Math.min(bits, words.length * 12) // "correct horse battery staple"
    if (pw.length < 14) bits = Math.min(bits, pw.length * 5) // short secrets: be pessimistic
    const bare = pw.toLowerCase().replace(/[^a-z]/g, '')
    if (bare && (madeOfCommonWords(bare) || COMMON.some((c) => bare.startsWith(c) && bare.length <= c.length + 3))) bits = Math.min(bits, 10)
    if (/^(.{1,4})\1{2,}$/.test(pw)) bits = Math.min(bits, 12) // "abcabcabc"
    if (new Set(pw).size <= 3 && pw.length > 3) bits = Math.min(bits, 8)
  }
  const score = bits < 28 ? 0 : bits < 45 ? 1 : bits < 60 ? 2 : bits < 80 ? 3 : 4
  return { bits: Math.round(bits), score, label: (['Very weak', 'Weak', 'Fair', 'Strong', 'Excellent'] as const)[score] }
}

/** Minimum for a MASTER passphrase: 12+ characters and at least "Fair". */
export function masterPassphraseProblem(p: string): string | null {
  if (p.length < 12) return 'Use at least 12 characters — a phrase of 4–5 unrelated words works well.'
  if (estimateStrength(p).score < 2) return 'That’s too easy to guess. Try a longer phrase of several unrelated words.'
  return null
}
