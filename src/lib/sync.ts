import type { Note } from '@/types/db'
import { isPermanent } from '@/api/errors'
import { getDraft, listDrafts, putDraft, removeDraft, type Draft } from './drafts'
import * as realApi from '@/api/notes'

export type PushResult =
  | { kind: 'ok'; note: Note }
  | { kind: 'skip' }
  | { kind: 'conflict'; server: Note }
  | { kind: 'retry'; error: Error }
  | { kind: 'failed'; error: Error }

export interface NotesApi {
  insertNote: typeof realApi.insertNote
  updateNoteText: typeof realApi.updateNoteText
  fetchNote: typeof realApi.fetchNote
}

const normTitle = (t: string | null | undefined) => (t?.trim() ? t.trim() : null)
const same = (server: Note, d: Draft) => server.content === d.content && normTitle(server.title) === normTitle(d.title)

/**
 * Send one draft to the server. Idempotent and safe to repeat:
 *  - a create whose response was lost (PK conflict) is recognised and treated as an update;
 *  - a stale base version is reported as a conflict, never silently overwritten.
 */
export async function pushDraft(d: Draft, api: NotesApi = realApi): Promise<PushResult> {
  const patch = { title: normTitle(d.title), content: d.content }
  const blank = !patch.title && !patch.content.trim()

  const update = async (version: number): Promise<PushResult> => {
    const n = await api.updateNoteText(d.id, patch, version)
    if (n) return { kind: 'ok', note: n }
    const server = await api.fetchNote(d.id)
    if (!server) return create() // permanently deleted elsewhere: re-create rather than lose the text
    if (same(server, d)) return { kind: 'ok', note: server }
    return { kind: 'conflict', server }
  }
  const create = async (): Promise<PushResult> => {
    if (blank) return { kind: 'skip' }
    try {
      return { kind: 'ok', note: await api.insertNote({ id: d.id, ...patch, created_at: d.createdAt }) }
    } catch (e) {
      if ((e as { code?: string }).code !== '23505') throw e
      const server = await api.fetchNote(d.id) // an earlier attempt already landed
      if (!server) throw e
      return same(server, d) ? { kind: 'ok', note: server } : update(server.version)
    }
  }

  try {
    return d.baseVersion === null ? await create() : await update(d.baseVersion)
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e))
    return isPermanent(e as { code?: string }) ? { kind: 'failed', error: err } : { kind: 'retry', error: err }
  }
}

/** Ids currently owned by an open editor (the background flusher leaves them alone). */
const active = new Set<string>()
const inFlight = new Set<string>()
export const claimDraft = (id: string) => { active.add(id) }
export const releaseDraft = (id: string) => { active.delete(id) }

/** Retry every unsent draft (crash recovery, offline capture, tab reopened). */
export async function flushDrafts(
  onNote?: (n: Note) => void,
  api: NotesApi = realApi,
): Promise<{ sent: number; pending: number; conflicts: number }> {
  let sent = 0, pending = 0, conflicts = 0
  for (const d of await listDrafts()) {
    if (active.has(d.id) || inFlight.has(d.id)) continue
    if (!d.dirty && !d.conflict) { await removeDraft(d.id); continue }
    if (d.conflict) { conflicts++; continue }
    inFlight.add(d.id)
    try {
      const fresh = (await getDraft(d.id)) ?? d
      const r = await pushDraft(fresh, api)
      if (r.kind === 'ok') {
        const latest = await getDraft(d.id)
        // still the same text? then the draft is fully synced and can go
        if (!latest || (latest.content === fresh.content && latest.title === fresh.title)) await removeDraft(d.id)
        else await putDraft({ ...latest, baseVersion: r.note.version, publicId: r.note.public_id })
        sent++; onNote?.(r.note)
      } else if (r.kind === 'skip') await removeDraft(d.id)
      else if (r.kind === 'conflict') {
        conflicts++
        await putDraft({ ...fresh, conflict: { title: r.server.title, content: r.server.content, version: r.server.version, updated_at: r.server.updated_at } })
      } else { pending++; if (r.kind === 'failed') await putDraft({ ...fresh, error: r.error.message }) }
    } finally { inFlight.delete(d.id) }
  }
  return { sent, pending, conflicts }
}
