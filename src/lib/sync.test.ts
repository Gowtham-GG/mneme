import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Note } from '@/types/db'
import type { Draft } from './drafts'
import { pushDraft, type NotesApi } from './sync'

const note = (o: Partial<Note> = {}): Note => ({
  id: 'n1', user_id: 'u', public_id: 'N-260920-001', title: null, content: 'hello', note_type: 'capture',
  is_starred: false, paper_ref: null, version: 1, created_at: '2026-09-20T10:00:00Z', updated_at: '2026-09-20T10:00:00Z',
  archived_at: null, deleted_at: null, journal_date: null, ...o,
})
const draft = (o: Partial<Draft> = {}): Draft => ({
  id: 'n1', title: null, content: 'hello', createdAt: '2026-09-20T10:00:00Z', baseVersion: null, dirty: true, updatedAt: 0, ...o,
})
const pgErr = (code: string, message = 'boom') => Object.assign(new Error(message), { code })

let api: { [K in keyof NotesApi]: ReturnType<typeof vi.fn> } & NotesApi
beforeEach(() => {
  api = { insertNote: vi.fn(), updateNoteText: vi.fn(), fetchNote: vi.fn() } as unknown as typeof api
})

describe('pushDraft', () => {
  it('creates a new note with the client id and capture time', async () => {
    api.insertNote.mockResolvedValue(note())
    const r = await pushDraft(draft(), api)
    expect(r.kind).toBe('ok')
    expect(api.insertNote).toHaveBeenCalledWith({ id: 'n1', title: null, content: 'hello', created_at: '2026-09-20T10:00:00Z' })
  })

  it('never creates a blank note', async () => {
    const r = await pushDraft(draft({ content: '  \n ', title: '  ' }), api)
    expect(r.kind).toBe('skip')
    expect(api.insertNote).not.toHaveBeenCalled()
  })

  it('a replayed create (lost response) is idempotent: same text = ok, no duplicate', async () => {
    api.insertNote.mockRejectedValue(pgErr('23505'))
    api.fetchNote.mockResolvedValue(note({ version: 3 }))
    const r = await pushDraft(draft(), api)
    expect(r).toMatchObject({ kind: 'ok' })
    expect(api.updateNoteText).not.toHaveBeenCalled()
  })

  it('a replayed create with newer text updates the row it already made', async () => {
    api.insertNote.mockRejectedValue(pgErr('23505'))
    api.fetchNote.mockResolvedValue(note({ content: 'old', version: 2 }))
    api.updateNoteText.mockResolvedValue(note({ content: 'hello', version: 3 }))
    const r = await pushDraft(draft(), api)
    expect(r.kind).toBe('ok')
    expect(api.updateNoteText).toHaveBeenCalledWith('n1', { title: null, content: 'hello' }, 2)
  })

  it('updates with the base version', async () => {
    api.updateNoteText.mockResolvedValue(note({ version: 5 }))
    const r = await pushDraft(draft({ baseVersion: 4 }), api)
    expect(r).toMatchObject({ kind: 'ok', note: { version: 5 } })
    expect(api.updateNoteText).toHaveBeenCalledWith('n1', { title: null, content: 'hello' }, 4)
  })

  it('reports a conflict instead of overwriting when the version moved', async () => {
    api.updateNoteText.mockResolvedValue(null)
    api.fetchNote.mockResolvedValue(note({ content: 'edited on phone', version: 9 }))
    const r = await pushDraft(draft({ baseVersion: 4 }), api)
    expect(r).toMatchObject({ kind: 'conflict', server: { content: 'edited on phone' } })
  })

  it('a "conflict" where the server already holds our text is just ok', async () => {
    api.updateNoteText.mockResolvedValue(null)
    api.fetchNote.mockResolvedValue(note({ content: 'hello', version: 9 }))
    expect((await pushDraft(draft({ baseVersion: 4 }), api)).kind).toBe('ok')
  })

  it('re-creates a note that was permanently deleted elsewhere instead of losing the text', async () => {
    api.updateNoteText.mockResolvedValue(null)
    api.fetchNote.mockResolvedValue(null)
    api.insertNote.mockResolvedValue(note({ version: 1 }))
    const r = await pushDraft(draft({ baseVersion: 4 }), api)
    expect(r.kind).toBe('ok')
    expect(api.insertNote).toHaveBeenCalled()
  })

  it('network failures are retryable, data errors are not', async () => {
    api.insertNote.mockRejectedValue(new Error('TypeError: Failed to fetch'))
    expect((await pushDraft(draft(), api)).kind).toBe('retry')
    api.insertNote.mockRejectedValue(pgErr('23514', 'content too long'))
    expect((await pushDraft(draft(), api)).kind).toBe('failed')
  })
})
