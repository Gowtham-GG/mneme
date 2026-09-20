import { useCallback, useEffect, useRef, useState } from 'react'
import type { Note } from '@/types/db'
import { getDraft, putDraft, removeDraft, type Draft } from '@/lib/drafts'
import { claimDraft, pushDraft, releaseDraft } from '@/lib/sync'
import { insertNote, updateNoteText } from '@/api/notes'
import { deriveTitle } from '@/lib/text'

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'offline' | 'error' | 'conflict'

export interface ConflictInfo { title: string | null; content: string; version: number; updated_at: string }

interface Options {
  /** Stable client-side id (= notes.id). */
  id: string
  /** The note as loaded from the server; null for a brand-new capture. */
  initial: Note | null
  createdAt: string
  onSaved?: (n: Note) => void
  debounceMs?: number
}

const newerConflict = (a: ConflictInfo | null, b: ConflictInfo) => (a && a.version >= b.version ? a : b)

export function useNoteEditor({ id, initial, createdAt, onSaved, debounceMs = 800 }: Options) {
  const [title, setTitleState] = useState(initial?.title ?? '')
  const [content, setContentState] = useState(initial?.content ?? '')
  const [status, setStatus] = useState<SaveStatus>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [publicId, setPublicId] = useState<string | null>(initial?.public_id ?? null)
  const [conflict, setConflict] = useState<ConflictInfo | null>(null)

  // Mutable mirror: the save loop must always read the latest text, not a stale closure.
  const cur = useRef({
    title: initial?.title ?? '',
    content: initial?.content ?? '',
    baseVersion: initial ? initial.version : (null as number | null),
    publicId: initial?.public_id ?? null,
    dirty: false,
    everHadText: !!(initial?.content || initial?.title),
  })
  const timers = useRef<{ save?: ReturnType<typeof setTimeout>; retry?: ReturnType<typeof setTimeout>; idle?: ReturnType<typeof setTimeout>; draft?: ReturnType<typeof setTimeout> }>({})
  const saving = useRef(false)
  const queued = useRef(false)
  const attempts = useRef(0)
  const alive = useRef(true)
  const onSavedRef = useRef(onSaved)
  onSavedRef.current = onSaved

  const snapshotDraft = useCallback((): Draft => ({
    id, title: cur.current.title.trim() ? cur.current.title : null, content: cur.current.content, createdAt,
    baseVersion: cur.current.baseVersion, publicId: cur.current.publicId ?? undefined,
    dirty: cur.current.dirty, updatedAt: Date.now(),
  }), [id, createdAt])

  const mirror = useCallback(() => {
    clearTimeout(timers.current.draft)
    timers.current.draft = setTimeout(() => {
      const d = snapshotDraft()
      if (d.dirty) void putDraft(d)
    }, 120)
  }, [snapshotDraft])

  const save = useCallback(async (): Promise<void> => {
    clearTimeout(timers.current.save)
    clearTimeout(timers.current.retry)
    if (!cur.current.dirty) return
    if (saving.current) { queued.current = true; return }
    saving.current = true
    if (alive.current) setStatus('saving')
    const sent = snapshotDraft()
    void putDraft(sent) // durable before the network call
    const r = await pushDraft(sent)
    saving.current = false

    if (r.kind === 'ok' || r.kind === 'skip') {
      attempts.current = 0
      if (r.kind === 'ok') {
        cur.current.baseVersion = r.note.version
        cur.current.publicId = r.note.public_id
        if (alive.current) setPublicId(r.note.public_id)
        onSavedRef.current?.(r.note)
      }
      const unchanged = cur.current.content === sent.content && (cur.current.title.trim() || null) === (sent.title?.trim() || null)
      if (unchanged || r.kind === 'skip') {
        cur.current.dirty = false
        if (r.kind === 'ok' || !cur.current.everHadText) void removeDraft(id)
        if (alive.current) {
          setErrorMsg(null)
          if (r.kind === 'ok') {
            setStatus('saved')
            clearTimeout(timers.current.idle)
            timers.current.idle = setTimeout(() => alive.current && setStatus((s) => (s === 'saved' ? 'idle' : s)), 2500)
          } else setStatus('idle')
        }
      } else if (queued.current || cur.current.dirty) { queued.current = false; void save() }
      return
    }
    if (r.kind === 'conflict') {
      const c: ConflictInfo = { title: r.server.title, content: r.server.content, version: r.server.version, updated_at: r.server.updated_at }
      setConflict((p) => newerConflict(p, c))
      if (alive.current) setStatus('conflict')
      void putDraft({ ...snapshotDraft(), conflict: c })
      return
    }
    if (r.kind === 'failed') {
      if (alive.current) { setStatus('error'); setErrorMsg(r.error.message) }
      return
    }
    // retryable (offline / server hiccup): text stays on screen and in IndexedDB
    attempts.current += 1
    if (alive.current) {
      setStatus(typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'error')
      setErrorMsg(r.error.message)
    }
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempts.current, 5))
    timers.current.retry = setTimeout(() => void save(), delay)
  }, [id, snapshotDraft])

  const touch = useCallback(() => {
    cur.current.dirty = true
    cur.current.everHadText = cur.current.everHadText || !!(cur.current.content.trim() || cur.current.title.trim())
    mirror()
    clearTimeout(timers.current.save)
    timers.current.save = setTimeout(() => void save(), debounceMs)
    setStatus((s) => (s === 'conflict' || s === 'error' || s === 'offline' ? s : 'idle'))
  }, [mirror, save, debounceMs])

  const setTitle = useCallback((v: string) => { cur.current.title = v; setTitleState(v); touch() }, [touch])
  const setContent = useCallback((v: string) => { cur.current.content = v; setContentState(v); touch() }, [touch])

  /** Save now and wait (Ctrl/Cmd+Enter, leaving the page). Resolves once nothing is pending or the save failed. */
  const flush = useCallback(async () => {
    clearTimeout(timers.current.save)
    for (let i = 0; i < 4 && cur.current.dirty && !saving.current; i++) await save()
    while (saving.current) await new Promise((r) => setTimeout(r, 50))
  }, [save])

  // Adopt an unsent draft left behind by a crash / closed tab.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const d = await getDraft(id)
      if (cancelled || !d || !d.dirty) return
      if (initial && d.content === initial.content && (d.title ?? '') === (initial.title ?? '')) return
      cur.current.title = d.title ?? ''
      cur.current.content = d.content
      cur.current.baseVersion = d.baseVersion ?? cur.current.baseVersion
      cur.current.everHadText = true
      setTitleState(cur.current.title); setContentState(cur.current.content)
      touch()
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  useEffect(() => {
    alive.current = true
    claimDraft(id)
    const onOnline = () => { if (cur.current.dirty && !saving.current) void save() }
    const onLeave = (e: BeforeUnloadEvent) => {
      if (cur.current.dirty && cur.current.everHadText) { void putDraft(snapshotDraft()); e.preventDefault(); e.returnValue = '' }
    }
    window.addEventListener('online', onOnline)
    window.addEventListener('beforeunload', onLeave)
    return () => {
      alive.current = false
      window.removeEventListener('online', onOnline)
      window.removeEventListener('beforeunload', onLeave)
      // NOTE: `cur.current` is plain mutable data, not a DOM node — reading it here is deliberate (we need the LATEST text at unmount).
      const t = timers.current
      clearTimeout(t.save); clearTimeout(t.retry); clearTimeout(t.idle); clearTimeout(t.draft)
      // Leaving with unsent text: keep it durable and hand it to the background flusher.
      if (cur.current.dirty && cur.current.everHadText) { void putDraft(snapshotDraft()); void save().finally(() => releaseDraft(id)) }
      else { releaseDraft(id); if (!cur.current.everHadText) void removeDraft(id) }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  /** Keep both versions: nothing is ever overwritten silently. */
  const resolveConflict = useCallback(async (choice: 'mine' | 'theirs'): Promise<Note | null> => {
    if (!conflict) return null
    const mine = { title: cur.current.title.trim() || null, content: cur.current.content }
    const theirs = { title: conflict.title, content: conflict.content }
    const label = (t: { title: string | null; content: string }, tag: string) =>
      `${t.title || deriveTitle(t.content) || 'Untitled'} (${tag})`
    const loser = choice === 'mine' ? theirs : mine
    const copy = await insertNote({ id: crypto.randomUUID(), title: label(loser, choice === 'mine' ? 'other device' : 'my edit'), content: loser.content, created_at: new Date().toISOString() })
    if (choice === 'mine') {
      const n = await updateNoteText(id, mine, conflict.version)
      if (!n) throw new Error('The note changed again — try once more.')
      cur.current.baseVersion = n.version
      cur.current.dirty = false
    } else {
      cur.current.title = theirs.title ?? ''; cur.current.content = theirs.content
      cur.current.baseVersion = conflict.version; cur.current.dirty = false
      setTitleState(cur.current.title); setContentState(cur.current.content)
    }
    void removeDraft(id)
    setConflict(null); setStatus('saved'); setErrorMsg(null)
    return copy
  }, [conflict, id])

  const retryNow = useCallback(() => { attempts.current = 0; void save() }, [save])

  return {
    title, content, setTitle, setContent, status, errorMsg, publicId, conflict,
    flush, retryNow, resolveConflict,
    hasText: () => !!(cur.current.content.trim() || cur.current.title.trim()),
    /** Latest server id, read from the ref (state values captured in closures go stale across an await). */
    getPublicId: () => cur.current.publicId,
    isDirty: () => cur.current.dirty,
    version: () => cur.current.baseVersion,
  }
}
