// Runs the app's real data layer against real migrations through PostgREST.
// Start with:  npm run test:int
import { createHmac, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { beforeAll, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({ jwt: '' }))

vi.mock('@/lib/supabase', async () => {
  const { createClient } = await import('@supabase/supabase-js')
  return {
    supabaseConfigured: true,
    // accessToken lets the test act as different users without a GoTrue server.
    supabase: createClient(process.env.MNEME_INT_URL!, 'anon-key-unused', { db: { schema: 'mneme' }, accessToken: async () => env.jwt }),
  }
})

import * as notes from '@/api/notes'
import * as search from '@/api/search'
import * as tags from '@/api/tags'
import * as tasks from '@/api/tasks'
import * as settings from '@/api/settings'
import * as revisions from '@/api/revisions'
import { collectExport } from '@/api/export'
import { pushDraft } from '@/lib/sync'
import type { Draft } from '@/lib/drafts'

const A = 'aaaaaaaa-0000-0000-0000-00000000000a'
const B = 'bbbbbbbb-0000-0000-0000-00000000000b'

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
function jwtFor(sub: string, role = 'authenticated') {
  const head = b64({ alg: 'HS256', typ: 'JWT' })
  const body = b64({ sub, role, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })
  const sig = createHmac('sha256', process.env.MNEME_INT_JWT_SECRET!).update(`${head}.${body}`).digest('base64url')
  return `${head}.${body}.${sig}`
}
const as = (u: string) => { env.jwt = jwtFor(u) }
const psql = (sql: string) => {
  const [host, port] = process.env.MNEME_INT_PG!.split(':')
  return execFileSync('psql', ['-h', host, '-p', port, '-U', 'postgres', '-d', 'postgres', '-Atc', sql]).toString().trim()
}
const draft = (o: Partial<Draft> = {}): Draft => ({ id: randomUUID(), title: null, content: 'hello', createdAt: new Date().toISOString(), baseVersion: null, dirty: true, updatedAt: 0, ...o })

beforeAll(() => {
  psql(`insert into auth.users(id,email) values ('${A}','a@int'),('${B}','b@int') on conflict do nothing`)
})

describe('notes through PostgREST', () => {
  it('creates a note with a client id, assigns N-YYMMDD-NNN and returns the row', async () => {
    as(A)
    const id = randomUUID()
    const n = await notes.insertNote({ id, title: null, content: 'first #java note', created_at: new Date().toISOString() })
    expect(n.id).toBe(id)
    expect(n.public_id).toMatch(/^N-\d{6}-\d{3,}$/)
    expect(n.version).toBe(1)
    expect((await notes.fetchNoteByPublicId(n.public_id.toLowerCase()))?.id).toBe(id) // case-insensitive lookup
  })

  it('a replayed insert reports a primary-key conflict (23505), never a duplicate row', async () => {
    as(A)
    const id = randomUUID()
    await notes.insertNote({ id, title: null, content: 'once', created_at: new Date().toISOString() })
    await expect(notes.insertNote({ id, title: null, content: 'once', created_at: new Date().toISOString() })).rejects.toMatchObject({ code: '23505' })
  })

  it('optimistic concurrency: stale version → null, current version → updated + version bump', async () => {
    as(A)
    const n = await notes.insertNote({ id: randomUUID(), title: null, content: 'v1', created_at: new Date().toISOString() })
    const u = await notes.updateNoteText(n.id, { title: 'T', content: 'v2' }, 1)
    expect(u).toMatchObject({ version: 2, content: 'v2', title: 'T' })
    expect(await notes.updateNoteText(n.id, { title: 'T', content: 'stale' }, 1)).toBeNull()
    expect((await notes.fetchNote(n.id))?.content).toBe('v2')
  })

  it('star / type / archive / trash / restore do not bump the text version', async () => {
    as(A)
    const n = await notes.insertNote({ id: randomUUID(), title: null, content: 'meta', created_at: new Date().toISOString() })
    await notes.setStarred(n.id, true); await notes.setNoteType(n.id, 'idea')
    await notes.archiveNote(n.id); await notes.unarchiveNote(n.id)
    await notes.trashNote(n.id)
    expect((await notes.fetchNote(n.id))).toMatchObject({ version: 1, is_starred: true, note_type: 'idea' })
    expect((await notes.listNotes({ state: 'trash' })).some((x) => x.id === n.id)).toBe(true)
    await notes.restoreNote(n.id)
    expect((await notes.listNotes({ state: 'active' })).some((x) => x.id === n.id)).toBe(true)
  })
})

describe('pushDraft (the save engine) against the real server', () => {
  it('create → replayed create → update → conflict, all without duplicates or overwrites', async () => {
    as(A)
    const d = draft({ content: 'draft v1' })
    const r1 = await pushDraft(d)
    expect(r1.kind).toBe('ok')
    // response "lost": the same draft is sent again
    const r2 = await pushDraft(d)
    expect(r2.kind).toBe('ok')
    expect(psql(`select count(*) from mneme.notes where id='${d.id}'`)).toBe('1')
    const v = r1.kind === 'ok' ? r1.note.version : 0
    const r3 = await pushDraft({ ...d, content: 'draft v2', baseVersion: v })
    expect(r3).toMatchObject({ kind: 'ok', note: { content: 'draft v2', version: v + 1 } })
    // another device edited in between → our stale save must NOT overwrite
    await notes.updateNoteText(d.id, { title: null, content: 'edited elsewhere' }, v + 1)
    const r4 = await pushDraft({ ...d, content: 'my late edit', baseVersion: v + 1 })
    expect(r4).toMatchObject({ kind: 'conflict', server: { content: 'edited elsewhere' } })
    expect((await notes.fetchNote(d.id))?.content).toBe('edited elsewhere')
  })

  it('a blank capture is never stored', async () => {
    as(A)
    expect((await pushDraft(draft({ content: '   ' }))).kind).toBe('skip')
  })
})

describe('derived data through the API', () => {
  it('tags, links, backlinks, tasks and their toggling', async () => {
    as(A)
    const target = await notes.insertNote({ id: randomUUID(), title: 'JVM Memory', content: 'heap', created_at: new Date().toISOString() })
    const src = await notes.insertNote({ id: randomUUID(), title: 'JVM Class Loading', created_at: new Date().toISOString(),
      content: `#java #jvm/classloading see [[${target.public_id}|JVM Memory]]\n- [ ] Read ClassLoader docs\n- [x] Already done` })

    const ctx = await tags.noteContext(src.id)
    expect(ctx.tags.map((t) => t.name).sort()).toEqual(['java', 'jvm/classloading'])
    expect(ctx.links_to.map((l) => l.public_id)).toEqual([target.public_id])
    expect(ctx.tasks.map((t) => `${t.title}:${t.status}`)).toEqual(['Read ClassLoader docs:open', 'Already done:done'])
    expect((await tags.noteContext(target.id)).linked_from.map((l) => l.public_id)).toEqual([src.public_id])

    // manual tag + removal
    await tags.addManualTag(src.id, '#Interview')
    expect((await tags.noteContext(src.id)).tags.find((t) => t.name === 'interview')?.source).toBe('manual')
    await tags.addManualTag(src.id, 'interview') // idempotent
    const manual = (await tags.noteContext(src.id)).tags.find((t) => t.name === 'interview')!
    await tags.removeManualTag(src.id, manual.id)
    expect((await tags.noteContext(src.id)).tags.some((t) => t.name === 'interview')).toBe(false)
    await expect(tags.addManualTag(src.id, 'not valid!')).rejects.toBeTruthy() // invalid names are rejected by the DB

    // task view + tick rewrites the note text
    const open = (await tasks.listTasks('no_date')).find((t) => t.title === 'Read ClassLoader docs')!
    expect(open.note_public_id).toBe(src.public_id)
    await tasks.setTaskDone(open.id, true)
    expect((await notes.fetchNote(src.id))!.content).toContain('- [x] Read ClassLoader docs')
    expect((await tasks.listTasks('completed')).some((t) => t.id === open.id)).toBe(true)

    // counts roll up
    const counts = await tags.tagCounts()
    const jvm = counts.find((c) => c.name === 'jvm'), cl = counts.find((c) => c.name === 'jvm/classloading')
    expect(cl).toMatchObject({ note_count: 1, direct_count: 1 })
    expect(jvm).toMatchObject({ note_count: 1, direct_count: 0 })
  })

  it('standalone tasks: add, date, tick, delete', async () => {
    as(A)
    await tasks.addStandaloneTask('Buy milk')
    const t = (await tasks.listTasks('no_date')).find((x) => x.title === 'Buy milk')!
    expect(t.source).toBe('standalone')
    await tasks.updateTask(t.id, { due_date: '2020-01-01' })
    expect((await tasks.listTasks('today')).some((x) => x.id === t.id)).toBe(true) // overdue lands in "today"
    await tasks.setTaskDone(t.id, true)
    await tasks.deleteStandaloneTask(t.id)
    expect((await tasks.listTasks('completed')).some((x) => x.id === t.id)).toBe(false)
  })
})

describe('search, lists, views, settings', () => {
  it('search operators and highlighted snippets', async () => {
    as(A)
    await notes.insertNote({ id: randomUUID(), title: 'Spring beans', content: 'Dependency injection resolves beans by type #spring', created_at: new Date().toISOString() })
    const r = await search.searchNotes('resolves beans')
    expect(r[0].title).toBe('Spring beans')
    expect(r[0].snippet).toContain('«')
    expect(r[0].preview).not.toContain('«') // plain body start, safe for deriving a title
    expect((await search.searchNotes('#spring')).length).toBe(1)
    expect((await search.searchNotes('Beans')).length).toBeGreaterThan(0) // title substring / stem
    expect((await search.searchNotes('type:capture is:inbox #spring')).length).toBe(1)
  })

  it('list_notes paginates by keyset with no gaps or repeats', async () => {
    as(B)
    for (let i = 0; i < 7; i++) await notes.insertNote({ id: randomUUID(), title: `B note ${i}`, content: `body ${i}`, created_at: new Date(Date.now() - i * 60_000).toISOString() })
    const seen: string[] = []
    let cursor: { ts: string; id: string } | null = null
    for (let page = 0; page < 5; page++) {
      const rows = await notes.listNotes({ state: 'all', cursor, limit: 3 })
      if (!rows.length) break
      seen.push(...rows.map((r) => r.id))
      cursor = { ts: rows[rows.length - 1].created_at, id: rows[rows.length - 1].id }
    }
    expect(new Set(seen).size).toBe(seen.length)
    expect(seen.length).toBe(7)
  })

  it('markViewed feeds recent_viewed; inbox_count counts captures', async () => {
    as(A)
    const n = await notes.insertNote({ id: randomUUID(), title: 'Viewed', content: 'x', created_at: new Date().toISOString() })
    await notes.markViewed(n.id); await notes.markViewed(n.id) // upsert twice
    expect((await notes.recentViewed(5))[0].id).toBe(n.id)
    expect(await notes.inboxCount()).toBeGreaterThan(0)
  })

  it('settings upsert round-trips and rejects a bad timezone', async () => {
    as(A)
    const s = await settings.saveSettings({ timezone: 'Asia/Kolkata', theme: 'dark' })
    expect(s).toMatchObject({ timezone: 'Asia/Kolkata', theme: 'dark' })
    expect(await settings.fetchSettings()).toMatchObject({ timezone: 'Asia/Kolkata' })
    await expect(settings.saveSettings({ timezone: 'Nowhere/Land' })).rejects.toBeTruthy()
    expect(await settings.saveSettings({ theme: 'amethyst' })).toMatchObject({ theme: 'amethyst' })
    await expect(settings.saveSettings({ theme: 'NOT A THEME' as never })).rejects.toBeTruthy()
  })

  it('empty_trash removes only trashed notes', async () => {
    as(A)
    const keep = await notes.insertNote({ id: randomUUID(), title: 'keep', content: 'k', created_at: new Date().toISOString() })
    const gone = await notes.insertNote({ id: randomUUID(), title: 'gone', content: 'g', created_at: new Date().toISOString() })
    await notes.trashNote(gone.id)
    expect(await notes.emptyTrash()).toBeGreaterThanOrEqual(1)
    expect(await notes.fetchNote(gone.id)).toBeNull()
    expect(await notes.fetchNote(keep.id)).not.toBeNull()
  })
})

describe('version history', () => {
  it('edits create revisions, a restore keeps the current text, and other users cannot see them', async () => {
    as(A)
    const n = await notes.insertNote({ id: randomUUID(), title: null, content: 'version one', created_at: new Date().toISOString() })
    await notes.updateNoteText(n.id, { title: null, content: 'version two' }, 1)
    let revs = await revisions.listRevisions(n.id)
    expect(revs.map((r) => r.content)).toEqual(['version one'])
    await revisions.snapshotCurrent(n.id, null, 'version two') // what "Restore" does first
    revs = await revisions.listRevisions(n.id)
    expect(revs.map((r) => r.content).sort()).toEqual(['version one', 'version two'])
    as(B)
    expect(await revisions.listRevisions(n.id)).toEqual([])
    await expect(revisions.snapshotCurrent(n.id, null, 'planted')).rejects.toBeTruthy() // composite FK: cannot write into A's history
  })
})

describe('tenant isolation over the wire', () => {
  it('B cannot read, update, delete or link to A’s notes; anonymous cannot reach the schema', async () => {
    as(A)
    const secret = await notes.insertNote({ id: randomUUID(), title: 'A secret', content: 'launch codes #private', created_at: new Date().toISOString() })
    as(B)
    expect(await notes.fetchNote(secret.id)).toBeNull()
    expect(await notes.fetchNoteByPublicId(secret.public_id)).toBeNull()
    expect((await search.searchNotes('launch codes')).length).toBe(0)
    expect((await notes.listNotes({ state: 'all', limit: 100 })).some((n) => n.id === secret.id)).toBe(false)
    expect(await notes.updateNoteText(secret.id, { title: null, content: 'pwned' }, secret.version)).toBeNull()
    await notes.deleteNoteForever(secret.id) // silently affects 0 rows
    expect(JSON.stringify(await tags.noteContext(secret.id))).toBe('{"tags":[],"tasks":[],"links_to":[],"linked_from":[]}')
    await expect(tasks.setTaskDone(randomUUID(), true)).rejects.toBeTruthy()
    await expect(tags.addManualTag(secret.id, 'stolen')).rejects.toBeTruthy() // composite FK: B's tag cannot attach to A's note
    as(A)
    expect((await notes.fetchNote(secret.id))?.content).toBe('launch codes #private')

    env.jwt = jwtFor(A, 'anon')
    await expect(notes.listNotes()).rejects.toBeTruthy()
  })

  it('export only ever contains the caller’s data', async () => {
    as(B)
    const d = await collectExport()
    expect(d.notes.length).toBeGreaterThan(0)
    expect(d.notes.every((n) => !n.content.includes('launch codes'))).toBe(true)
    const md = d.notes.map((n) => n.public_id)
    expect(new Set(md).size).toBe(md.length)
  })
})
