import { describe, expect, it } from 'vitest'
import {
  DEFAULT_GEN, charsetsFor, deriveVaultKey, estimateStrength, fromB64, generatePassword, makeCheck, masterPassphraseProblem,
  newSalt, openItem, randomInt, sealItem, toB64, verifyCheck, type VaultSecret,
} from './vaultCrypto'

const ITER = 1000 // tests use a tiny work factor; production uses 600 000
const USER = 'aaaaaaaa-0000-0000-0000-000000000001'
const secret: VaultSecret = { site: 'github.com', username: 'me@example.com', password: 'p@ss w0rd — ünïcode ✓', notes: 'recovery: 1234' }

describe('key derivation & check value', () => {
  it('the same passphrase + salt derive a working key; a wrong passphrase fails the check', async () => {
    const salt = newSalt()
    const k1 = await deriveVaultKey('correct horse battery staple', salt, ITER)
    const check = await makeCheck(k1, USER)
    expect(await verifyCheck(await deriveVaultKey('correct horse battery staple', salt, ITER), USER, check)).toBe(true)
    expect(await verifyCheck(await deriveVaultKey('correct horse battery stapl', salt, ITER), USER, check)).toBe(false)
    expect(await verifyCheck(await deriveVaultKey('correct horse battery staple', newSalt(), ITER), USER, check)).toBe(false) // other salt
    expect(await verifyCheck(await deriveVaultKey('correct horse battery staple', salt, ITER + 1), USER, check)).toBe(false) // other work factor
  })
  it('normalises unicode so the same phrase works on every device', async () => {
    const salt = newSalt()
    const a = await deriveVaultKey('café-phrase-1', salt, ITER)        // precomposed é
    const b = await deriveVaultKey('café-phrase-1', salt, ITER)  // e + combining accent
    expect(await verifyCheck(b, USER, await makeCheck(a, USER))).toBe(true)
  })
  it('the derived key is not extractable', async () => {
    const k = await deriveVaultKey('x'.repeat(12), newSalt(), ITER)
    expect(k.extractable).toBe(false)
    await expect(crypto.subtle.exportKey('raw', k)).rejects.toBeTruthy()
  })
  it('salts are random 16 bytes', () => {
    expect(fromB64(newSalt()).length).toBe(16)
    expect(newSalt()).not.toBe(newSalt())
  })
})

describe('sealing credentials', () => {
  it('round-trips every field, including unicode', async () => {
    const key = await deriveVaultKey('a long passphrase here', newSalt(), ITER)
    const payload = await sealItem(key, USER, 'item-1', secret)
    expect(await openItem(key, USER, 'item-1', payload)).toEqual(secret)
  })
  it('the stored payload contains no plaintext', async () => {
    const key = await deriveVaultKey('a long passphrase here', newSalt(), ITER)
    const payload = await sealItem(key, USER, 'item-1', secret)
    for (const needle of ['github', 'example', 'w0rd', 'recovery']) expect(payload).not.toContain(needle)
    expect(payload).toMatch(/^v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/)
  })
  it('a fresh IV every time: identical secrets never produce identical ciphertext', async () => {
    const key = await deriveVaultKey('a long passphrase here', newSalt(), ITER)
    const a = await sealItem(key, USER, 'i', secret), b = await sealItem(key, USER, 'i', secret)
    expect(a).not.toBe(b)
  })
  it('the wrong key cannot open a record', async () => {
    const k1 = await deriveVaultKey('first passphrase!!', newSalt(), ITER), k2 = await deriveVaultKey('other passphrase!!', newSalt(), ITER)
    await expect(openItem(k2, USER, 'i', await sealItem(k1, USER, 'i', secret))).rejects.toBeTruthy()
  })
  it('a record is bound to its row id and owner: swapping rows or users is detected', async () => {
    const key = await deriveVaultKey('a long passphrase here', newSalt(), ITER)
    const payload = await sealItem(key, USER, 'item-1', secret)
    await expect(openItem(key, USER, 'item-2', payload)).rejects.toBeTruthy()                                   // moved to another row
    await expect(openItem(key, 'bbbbbbbb-0000-0000-0000-000000000002', 'item-1', payload)).rejects.toBeTruthy() // another user
    expect(await verifyCheck(key, USER, payload)).toBe(false)                                                    // an item is not a check value
  })
  it('any tampering with the ciphertext is detected (GCM authentication)', async () => {
    const key = await deriveVaultKey('a long passphrase here', newSalt(), ITER)
    const [v, iv, ct] = (await sealItem(key, USER, 'i', secret)).split('.')
    const bytes = fromB64(ct); bytes[3] ^= 1
    await expect(openItem(key, USER, 'i', `${v}.${iv}.${toB64(bytes)}`)).rejects.toBeTruthy()
    await expect(openItem(key, USER, 'i', `v9.${iv}.${ct}`)).rejects.toBeTruthy()
    await expect(openItem(key, USER, 'i', 'garbage')).rejects.toBeTruthy()
  })
})

describe('password generator', () => {
  it('honours length and always includes every selected class', () => {
    for (let i = 0; i < 200; i++) {
      const p = generatePassword({ ...DEFAULT_GEN, length: 12 })
      expect(p).toHaveLength(12)
      expect(p).toMatch(/[A-Z]/); expect(p).toMatch(/[a-z]/); expect(p).toMatch(/[0-9]/); expect(p).toMatch(/[^A-Za-z0-9]/)
    }
  })
  it('respects class toggles and excludes ambiguous characters when asked', () => {
    for (let i = 0; i < 100; i++) {
      expect(generatePassword({ ...DEFAULT_GEN, symbols: false, digits: false, upper: false })).toMatch(/^[a-z]+$/)
      expect(generatePassword({ ...DEFAULT_GEN, length: 60 })).not.toMatch(/[Il1O0o|`'"]/)
    }
    expect(charsetsFor({ ...DEFAULT_GEN, upper: false, lower: false, digits: false, symbols: false }).length).toBeGreaterThan(0) // never empty
  })
  it('clamps the length and never repeats between calls', () => {
    expect(generatePassword({ ...DEFAULT_GEN, length: 500 })).toHaveLength(128)
    expect(generatePassword({ ...DEFAULT_GEN, length: 1 }).length).toBeGreaterThanOrEqual(4)
    expect(new Set(Array.from({ length: 50 }, () => generatePassword(DEFAULT_GEN))).size).toBe(50)
  })
  it('randomInt is uniform (no modulo bias) over a range that does not divide 2^32', () => {
    const n = 7, counts = new Array(n).fill(0), N = 70_000
    for (let i = 0; i < N; i++) counts[randomInt(n)]++
    const expected = N / n
    const chi = counts.reduce((s, c) => s + (c - expected) ** 2 / expected, 0)
    expect(chi).toBeLessThan(22.5) // 6 dof, p ≈ 0.001
    expect(() => randomInt(0)).toThrow()
  })
})

describe('strength estimate & master passphrase rules', () => {
  it('orders obviously weak → strong', () => {
    const s = (p: string) => estimateStrength(p).bits
    expect(estimateStrength('').score).toBe(0)
    expect(estimateStrength('password123').label).toBe('Very weak')
    expect(estimateStrength('abcdefgh').score).toBeLessThanOrEqual(1)
    expect(s('hunter2')).toBeLessThan(s('correct horse battery staple'))
    expect(estimateStrength(generatePassword({ ...DEFAULT_GEN, length: 20 })).score).toBeGreaterThanOrEqual(3)
    expect(estimateStrength('aaaaaaaaaaaaaaaaaaaa').score).toBeLessThanOrEqual(2)
  })
  it('a master passphrase needs 12+ characters and Fair or better', () => {
    expect(masterPassphraseProblem('short')).toMatch(/12 characters/)
    expect(masterPassphraseProblem('passwordpassword')).toMatch(/too easy/)
    expect(masterPassphraseProblem('111111111111')).toMatch(/too easy/)
    expect(masterPassphraseProblem('correct horse battery staple')).toBeNull()
    expect(masterPassphraseProblem(generatePassword(DEFAULT_GEN))).toBeNull()
  })
})
