import { createStore, del, entries, get, set } from 'idb-keyval'

// Every keystroke is mirrored here BEFORE any network call, so a crash, a
// closed tab or a dead connection can never lose text. A draft stays until the
// server has confirmed exactly that text.

export interface Draft {
  id: string
  title: string | null
  content: string
  createdAt: string
  /** null = not on the server yet */
  baseVersion: number | null
  publicId?: string
  dirty: boolean
  updatedAt: number
  conflict?: { title: string | null; content: string; version: number; updated_at: string }
  error?: string
}

let store: ReturnType<typeof createStore> | null = null
function db() {
  // Created lazily: IndexedDB may be unavailable (private mode, tests).
  return (store ??= createStore('mneme', 'drafts'))
}

export async function putDraft(d: Draft): Promise<void> {
  try { await set(d.id, d, db()) } catch { /* storage unavailable: network save still works */ }
}
export async function getDraft(id: string): Promise<Draft | undefined> {
  try { return await get<Draft>(id, db()) } catch { return undefined }
}
export async function removeDraft(id: string): Promise<void> {
  try { await del(id, db()) } catch { /* ignore */ }
}
export async function listDrafts(): Promise<Draft[]> {
  try { return (await entries<string, Draft>(db())).map(([, v]) => v) } catch { return [] }
}
