import { supabase } from '@/lib/supabase'
import { toError } from './errors'

// Transport for the encrypted vault. Everything that crosses this file is already ciphertext (or public KDF
// parameters): encryption/decryption happens in the browser (src/lib/vaultCrypto.ts).

export interface VaultMeta { iterations: number; salt: string; check_payload: string; version: number }
export interface VaultRow { id: string; payload: string; created_at: string; updated_at: string }

export async function fetchVaultMeta(): Promise<VaultMeta | null> {
  const { data, error } = await supabase.from('vault_meta').select('iterations,salt,check_payload,version').maybeSingle()
  if (error) throw toError(error)
  return data as VaultMeta | null
}

export async function createVaultMeta(m: Omit<VaultMeta, 'version'>): Promise<void> {
  const { error } = await supabase.from('vault_meta').insert({ iterations: m.iterations, salt: m.salt, check_payload: m.check_payload })
  if (error) throw toError(error)
}

/** All rows, paged (PostgREST returns at most 1000 per request). */
export async function fetchVaultRows(): Promise<VaultRow[]> {
  const out: VaultRow[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('vault_items').select('id,payload,created_at,updated_at').order('created_at', { ascending: true }).order('id').range(from, from + 999)
    if (error) throw toError(error)
    const rows = (data as VaultRow[]) ?? []
    out.push(...rows)
    if (rows.length < 1000) return out
  }
}

export async function upsertVaultRow(id: string, payload: string): Promise<VaultRow> {
  const { data, error } = await supabase.from('vault_items').upsert({ id, payload }, { onConflict: 'id' }).select('id,payload,created_at,updated_at').single()
  if (error) throw toError(error)
  return data as VaultRow
}

export async function insertVaultRows(rows: { id: string; payload: string }[]): Promise<VaultRow[]> {
  const out: VaultRow[] = []
  for (let i = 0; i < rows.length; i += 200) {
    const { data, error } = await supabase.from('vault_items').insert(rows.slice(i, i + 200)).select('id,payload,created_at,updated_at')
    if (error) throw toError(error)
    out.push(...((data as VaultRow[]) ?? []))
  }
  return out
}

export async function deleteVaultRow(id: string): Promise<void> {
  const { error } = await supabase.from('vault_items').delete().eq('id', id)
  if (error) throw toError(error)
}

/** Atomically swap every ciphertext and the KDF parameters (used when the master passphrase changes). */
export async function rekeyVault(iterations: number, salt: string, check: string, items: { id: string; payload: string }[]): Promise<void> {
  const { error } = await supabase.rpc('vault_rekey', { p_iterations: iterations, p_salt: salt, p_check: check, p_items: items })
  if (error) throw toError(error)
}

export async function resetVaultOnServer(): Promise<void> {
  const { error } = await supabase.rpc('vault_reset')
  if (error) throw toError(error)
}
