import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createVaultMeta, deleteVaultRow, fetchVaultMeta, fetchVaultRows, insertVaultRows, rekeyVault, resetVaultOnServer, upsertVaultRow, type VaultMeta, type VaultRow } from '@/api/vault'
import { useAuth } from '@/hooks/useAuth'
import { KDF_ITERATIONS, deriveVaultKey, makeCheck, masterPassphraseProblem, newSalt, openItem, sealItem, verifyCheck, type VaultSecret } from '@/lib/vaultCrypto'
import { dedupeKey, type VaultItem } from '@/lib/vaultData'

export type VaultStatus = 'idle' | 'loading' | 'none' | 'locked' | 'unlocked' | 'error'

interface VaultApi {
  status: VaultStatus
  items: VaultItem[]
  /** rows that could not be decrypted (corrupted / wrong key) — surfaced, never silently dropped */
  undecryptable: number
  error: string | null
  timeoutMin: number
  setTimeoutMin: (m: number) => void
  load: () => Promise<void>
  createVault: (passphrase: string) => Promise<void>
  unlock: (passphrase: string) => Promise<boolean>
  lock: () => void
  refresh: () => Promise<void>
  saveItem: (draft: VaultSecret & { id?: string }) => Promise<VaultItem>
  removeItem: (id: string) => Promise<void>
  importItems: (secrets: VaultSecret[]) => Promise<{ added: number; duplicates: number }>
  changePassphrase: (current: string, next: string) => Promise<void>
  resetVault: () => Promise<void>
}

const noop = async () => { throw new Error('Vault not ready') }
const VaultContext = createContext<VaultApi>({
  status: 'idle', items: [], undecryptable: 0, error: null, timeoutMin: 5, setTimeoutMin: () => {}, load: noop, createVault: noop, unlock: async () => false,
  lock: () => {}, refresh: noop, saveItem: noop as never, removeItem: noop, importItems: noop as never, changePassphrase: noop, resetVault: noop,
})

const TIMEOUT_KEY = 'mneme-vault-timeout'
export const TIMEOUT_CHOICES = [1, 5, 15, 30, 60]
const initialTimeout = () => { try { const n = Number(localStorage.getItem(TIMEOUT_KEY)); return TIMEOUT_CHOICES.includes(n) ? n : 5 } catch { return 5 } }

const toItem = (r: VaultRow, s: VaultSecret): VaultItem => ({ ...s, id: r.id, createdAt: r.created_at, updatedAt: r.updated_at })

/**
 * Holds the unlocked vault IN MEMORY ONLY. The derived key is a non-extractable CryptoKey that is never persisted;
 * reloading the page, signing out, the idle timeout or pressing Lock all discard it (and the decrypted items).
 */
export function VaultProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const uid = user?.id ?? null
  const [status, setStatus] = useState<VaultStatus>('idle')
  const [items, setItems] = useState<VaultItem[]>([])
  const [undecryptable, setUndecryptable] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [timeoutMin, setTimeoutState] = useState(initialTimeout)
  const key = useRef<CryptoKey | null>(null)
  const meta = useRef<VaultMeta | null>(null)

  const lock = useCallback(() => {
    key.current = null
    setItems([])
    setUndecryptable(0)
    setStatus((s) => (s === 'unlocked' ? 'locked' : s))
  }, [])

  // signing out / switching account: forget everything
  useEffect(() => {
    if (uid) return
    key.current = null; meta.current = null
    setItems([]); setUndecryptable(0); setError(null); setStatus('idle')
  }, [uid])

  const setTimeoutMin = useCallback((m: number) => {
    setTimeoutState(m)
    try { localStorage.setItem(TIMEOUT_KEY, String(m)) } catch { /* ignore */ }
  }, [])

  // idle auto-lock
  useEffect(() => {
    if (status !== 'unlocked') return
    let t: ReturnType<typeof setTimeout>
    const reset = () => { clearTimeout(t); t = setTimeout(lock, timeoutMin * 60_000) }
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const
    reset()
    for (const e of events) window.addEventListener(e, reset, { passive: true })
    return () => { clearTimeout(t); for (const e of events) window.removeEventListener(e, reset) }
  }, [status, timeoutMin, lock])

  const decryptRows = useCallback(async (rows: VaultRow[], k: CryptoKey): Promise<{ items: VaultItem[]; bad: number }> => {
    const out: VaultItem[] = []
    let bad = 0
    for (const r of rows) {
      try { out.push(toItem(r, await openItem(k, uid!, r.id, r.payload))) } catch { bad++ }
    }
    return { items: out, bad }
  }, [uid])

  const load = useCallback(async () => {
    if (!uid) return
    setStatus((s) => (s === 'unlocked' ? s : 'loading'))
    setError(null)
    try {
      const m = await fetchVaultMeta()
      meta.current = m
      setStatus((s) => (s === 'unlocked' ? s : m ? 'locked' : 'none'))
    } catch (e) {
      setError((e as Error).message || 'Couldn’t reach the vault.')
      setStatus('error')
    }
  }, [uid])

  const refresh = useCallback(async () => {
    if (!key.current) return
    const { items: fresh, bad } = await decryptRows(await fetchVaultRows(), key.current)
    setItems(fresh); setUndecryptable(bad)
  }, [decryptRows])

  // pick up changes made on another device when the tab comes back into view
  useEffect(() => {
    if (status !== 'unlocked') return
    const on = () => { if (document.visibilityState === 'visible') void refresh().catch(() => {}) }
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [status, refresh])

  const createVault = useCallback(async (passphrase: string) => {
    if (!uid) throw new Error('Not signed in')
    const problem = masterPassphraseProblem(passphrase)
    if (problem) throw new Error(problem)
    const salt = newSalt()
    const k = await deriveVaultKey(passphrase, salt, KDF_ITERATIONS)
    const check_payload = await makeCheck(k, uid)
    await createVaultMeta({ iterations: KDF_ITERATIONS, salt, check_payload })
    meta.current = { iterations: KDF_ITERATIONS, salt, check_payload, version: 1 }
    key.current = k
    setItems([]); setUndecryptable(0); setError(null); setStatus('unlocked')
  }, [uid])

  const unlock = useCallback(async (passphrase: string): Promise<boolean> => {
    if (!uid || !meta.current) throw new Error('Vault not loaded')
    const k = await deriveVaultKey(passphrase, meta.current.salt, meta.current.iterations)
    if (!(await verifyCheck(k, uid, meta.current.check_payload))) return false
    const { items: list, bad } = await decryptRows(await fetchVaultRows(), k)
    key.current = k
    setItems(list); setUndecryptable(bad); setError(null); setStatus('unlocked')
    return true
  }, [uid, decryptRows])

  const saveItem = useCallback(async (draft: VaultSecret & { id?: string }): Promise<VaultItem> => {
    if (!uid || !key.current) throw new Error('The vault is locked')
    const id = draft.id ?? crypto.randomUUID()
    const secret: VaultSecret = { site: draft.site.trim(), username: draft.username.trim(), password: draft.password, notes: draft.notes }
    const row = await upsertVaultRow(id, await sealItem(key.current, uid, id, secret))
    const item = toItem(row, secret)
    setItems((l) => (l.some((x) => x.id === id) ? l.map((x) => (x.id === id ? item : x)) : [...l, item]))
    return item
  }, [uid])

  const removeItem = useCallback(async (id: string) => {
    await deleteVaultRow(id)
    setItems((l) => l.filter((x) => x.id !== id))
  }, [])

  const importItems = useCallback(async (secrets: VaultSecret[]) => {
    if (!uid || !key.current) throw new Error('The vault is locked')
    const have = new Set(items.map(dedupeKey))
    const fresh: VaultSecret[] = []
    let duplicates = 0
    for (const s of secrets) {
      const k = dedupeKey(s)
      if (have.has(k)) { duplicates++; continue }
      have.add(k); fresh.push({ ...s, site: s.site.trim(), username: s.username.trim() })
    }
    const rows = await Promise.all(fresh.map(async (s) => { const id = crypto.randomUUID(); return { id, payload: await sealItem(key.current!, uid, id, s), secret: s } }))
    const saved = await insertVaultRows(rows.map(({ id, payload }) => ({ id, payload })))
    const secretOf = new Map<string, VaultSecret>(rows.map((r) => [r.id as string, r.secret]))
    setItems((l) => [...l, ...saved.map((r) => toItem(r, secretOf.get(r.id)!))])
    return { added: saved.length, duplicates }
  }, [uid, items])

  const changePassphrase = useCallback(async (current: string, next: string) => {
    if (!uid || !meta.current || !key.current) throw new Error('The vault is locked')
    const problem = masterPassphraseProblem(next)
    if (problem) throw new Error(problem)
    const oldKey = await deriveVaultKey(current, meta.current.salt, meta.current.iterations)
    if (!(await verifyCheck(oldKey, uid, meta.current.check_payload))) throw new Error('The current passphrase is wrong.')

    const rows = await fetchVaultRows() // fresh copy: what the server really holds right now
    const salt = newSalt()
    const newKey = await deriveVaultKey(next, salt, KDF_ITERATIONS)
    const reencrypted: { id: string; payload: string }[] = []
    for (const r of rows) {
      let secret: VaultSecret
      try { secret = await openItem(oldKey, uid, r.id, r.payload) } catch { throw new Error('Some records could not be read, so the passphrase was NOT changed (nothing was modified).') }
      reencrypted.push({ id: r.id, payload: await sealItem(newKey, uid, r.id, secret) })
    }
    const check = await makeCheck(newKey, uid)
    try { await rekeyVault(KDF_ITERATIONS, salt, check, reencrypted) } catch (e) {
      if ((e as { code?: string }).code === '40001') throw new Error('Your vault changed on another device while this ran. Nothing was changed — please try again.')
      throw e
    }
    meta.current = { iterations: KDF_ITERATIONS, salt, check_payload: check, version: 1 }
    key.current = newKey
    await refresh()
  }, [uid, refresh])

  const resetVault = useCallback(async () => {
    await resetVaultOnServer()
    key.current = null; meta.current = null
    setItems([]); setUndecryptable(0); setStatus('none')
  }, [])

  const value = useMemo<VaultApi>(() => ({
    status, items, undecryptable, error, timeoutMin, setTimeoutMin, load, createVault, unlock, lock, refresh, saveItem, removeItem, importItems, changePassphrase, resetVault,
  }), [status, items, undecryptable, error, timeoutMin, setTimeoutMin, load, createVault, unlock, lock, refresh, saveItem, removeItem, importItems, changePassphrase, resetVault])

  return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useVault() { return useContext(VaultContext) }
