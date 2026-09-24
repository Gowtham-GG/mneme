import { strFromU8, unzipSync } from 'fflate'
import { supabase } from '@/lib/supabase'
import { toError } from './errors'

/** Everything in the account except the password vault — restorable with importBackup(). */
export async function exportBackup(): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.rpc('export_backup')
  if (error) throw toError(error)
  return data as Record<string, unknown>
}

/** A backup file (the .json, or the emailed .zip that holds it) → its contents. */
export async function readBackupFile(file: File): Promise<Record<string, unknown>> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let text: string
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) { // "PK": a zip
    const files = unzipSync(bytes)
    const name = Object.keys(files).find((n) => n.endsWith('mneme-backup.json'))
    if (!name) throw new Error('That zip has no mneme-backup.json in it.')
    text = strFromU8(files[name])
  } else text = strFromU8(bytes)
  const json = JSON.parse(text) as Record<string, unknown>
  if (json.format !== 'mneme-backup') throw new Error('That file isn’t a Mneme backup.')
  return json
}

/** Rebuild a backup into this (empty) account. */
export async function importBackup(backup: Record<string, unknown>): Promise<{ notes: number; tasks: number }> {
  const { data, error } = await supabase.rpc('import_backup', { p: backup })
  if (error) throw toError(error)
  return data as { notes: number; tasks: number }
}
