import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { listNotes } from '@/api/notes'
import { searchNotes } from '@/api/search'
import { tagCounts } from '@/api/tags'
import { useDebounced } from '@/hooks/useDebounced'
import { applyPick, continueList, detectTrigger, indentLines, insertAt, prefixLine, safeLabel, type Edit, type Trigger } from '@/lib/editing'
import { displayTitle } from '@/lib/text'
import type { NoteListItem } from '@/types/db'

interface Props {
  value: string
  onChange: (v: string) => void
  onSaveAndClose?: () => void
  autoFocus?: boolean
  placeholder?: string
  /** id of the note being edited (excluded from link suggestions) */
  selfId?: string
  minRows?: number
  /** Tailwind min-height class for the writing area */
  minHeight?: string
  /** show the symbol bar even when no suggestion is open (default true) */
  showBar?: boolean
}

interface Suggestion { key: string; label: string; hint?: string; insert: string }

/** Symbol bar buttons: [label shown, accessible name, action] */
const BAR: { label: string; name: string; kind: 'line' | 'inline'; text: string }[] = [
  { label: '☐', name: 'Task', kind: 'line', text: '- [ ] ' },
  { label: '?', name: 'Question', kind: 'line', text: '? ' },
  { label: '!', name: 'Important', kind: 'line', text: '! ' },
  { label: '★', name: 'Key insight', kind: 'line', text: '★ ' },
  { label: '→', name: 'Leads to', kind: 'inline', text: '→ ' },
  { label: '×', name: 'Discard', kind: 'line', text: '× ' },
  { label: '[[', name: 'Link a note', kind: 'inline', text: '[[' },
  { label: '#', name: 'Tag', kind: 'inline', text: '#' },
]

function Tray({ trigger, selfId, onPick, index, setItems, setBusy }: {
  trigger: Trigger; selfId?: string; onPick: (s: Suggestion) => void; index: number; setItems: (s: Suggestion[]) => void; setBusy: (b: boolean) => void
}) {
  const q = useDebounced(trigger.query, 140)
  const links = useQuery({
    queryKey: ['suggest-links', q],
    enabled: trigger.type === 'link',
    queryFn: () => (q.trim() ? searchNotes(q, 8) : listNotes({ order: 'updated', limit: 8 })),
    staleTime: 10_000,
  })
  const tags = useQuery({ queryKey: ['tag-counts'], enabled: trigger.type === 'tag', queryFn: tagCounts, staleTime: 60_000 })

  // The list is only trustworthy once the debounced query has caught up with what was typed
  // and its results have arrived; until then Enter must not pick from a stale list.
  const busy = trigger.type === 'link' && (q !== trigger.query || links.isFetching)
  let items: Suggestion[] = []
  if (trigger.type === 'link' && !busy) {
    items = ((links.data ?? []) as NoteListItem[])
      .filter((n) => n.id !== selfId)
      .slice(0, 6)
      .map((n) => {
        const label = displayTitle(n)
        return { key: n.id, label, hint: n.public_id, insert: `[[${n.public_id}|${safeLabel(label)}]]` }
      })
  } else {
    const ql = trigger.query.toLowerCase()
    const all = (tags.data ?? []).filter((t) => t.name.startsWith(ql)).sort((a, b) => b.note_count - a.note_count).slice(0, 6)
    items = all.map((t) => ({ key: t.name, label: `#${t.name}`, hint: `${t.note_count}`, insert: `#${t.name} ` }))
    if (ql && !all.some((t) => t.name === ql)) items.push({ key: '__new', label: `Create #${ql}`, insert: `#${ql} ` })
  }
  const sig = items.map((i) => i.key).join('|')
  useEffect(() => { setItems(items) }, [sig]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setBusy(busy) }, [busy]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!items.length) return <div className="px-3 py-2 text-sm text-faint">{trigger.type === 'link' ? (busy ? 'Searching…' : 'No matching notes') : 'Keep typing to create a tag'}</div>
  return (
    <ul role="listbox" aria-label={trigger.type === 'link' ? 'Link to a note' : 'Tag suggestions'} className="max-h-56 space-y-0.5 overflow-auto p-1.5">
      {items.map((s, i) => (
        <li key={s.key} role="option" aria-selected={i === index}>
          <button
            type="button"
            // mousedown (not click) so the textarea keeps focus and its caret
            onMouseDown={(e) => { e.preventDefault(); onPick(s) }}
            className={`flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left text-sm ${i === index ? 'bg-accent-soft' : 'hover:bg-hover'}`}
          >
            <span className="truncate">{s.label}</span>
            {s.hint && <span className="shrink-0 text-xs tabular-nums text-faint">{s.hint}</span>}
          </button>
        </li>
      ))}
    </ul>
  )
}

export function Editor({ value, onChange, onSaveAndClose, autoFocus, placeholder, selfId, minRows = 8, minHeight = 'min-h-[calc(100dvh-13rem)] lg:min-h-[55vh]', showBar = true }: Props) {
  const ta = useRef<HTMLTextAreaElement>(null)
  const pending = useRef<{ start: number; end: number } | null>(null)
  const [trigger, setTrigger] = useState<Trigger | null>(null)
  const [items, setItems] = useState<Suggestion[]>([])
  const [index, setIndex] = useState(0)
  // #tag suggestions only accept Enter after the user arrows to one; otherwise Enter is a plain newline.
  const navigated = useRef(false)
  const busy = useRef(false)

  const grow = useCallback(() => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [])

  // Restore the caret after a programmatic edit, and keep the box sized to its text.
  useLayoutEffect(() => {
    grow()
    const p = pending.current
    if (p && ta.current) { ta.current.setSelectionRange(p.start, p.end); pending.current = null }
  }, [value, grow])

  useEffect(() => { if (autoFocus) ta.current?.focus({ preventScroll: true }) }, [autoFocus])

  const refreshTrigger = useCallback((v: string, caret: number) => {
    const t = detectTrigger(v, caret)
    setTrigger((prev) => (prev && t && prev.type === t.type && prev.query === t.query && prev.start === t.start ? prev : t))
    if (!t) setItems([])
    setIndex(0)
    navigated.current = false
  }, [])

  const commit = useCallback((e: Edit) => {
    pending.current = { start: e.start, end: e.end }
    onChange(e.value)
    refreshTrigger(e.value, e.end)
  }, [onChange, refreshTrigger])

  const pick = useCallback((s: Suggestion) => {
    if (!trigger) return
    commit(applyPick(value, trigger, s.insert))
    setTrigger(null); setItems([])
  }, [trigger, value, commit])

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); onSaveAndClose?.(); return }
    if (trigger?.type === 'link' && busy.current && (e.key === 'Enter' || e.key === 'Tab')) { e.preventDefault(); return } // results still loading
    if (trigger && items.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); navigated.current = true; setIndex((i) => (i + 1) % items.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); navigated.current = true; setIndex((i) => (i - 1 + items.length) % items.length); return }
      const accept = e.key === 'Tab' || (e.key === 'Enter' && (trigger.type === 'link' || navigated.current))
      if (accept) { e.preventDefault(); pick(items[Math.min(index, items.length - 1)]); return }
    }
    if (trigger && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setTrigger(null); return }
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && el.selectionStart === el.selectionEnd) {
      const r = continueList(value, el.selectionStart)
      if (r) { e.preventDefault(); commit(r); return }
    }
    if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey) {
      const r = indentLines(value, el.selectionStart, el.selectionEnd, e.shiftKey)
      if (r) { e.preventDefault(); commit(r) }
    }
  }

  const bar = (b: (typeof BAR)[number]) => {
    const el = ta.current
    if (!el) return
    const s = el.selectionStart, en = el.selectionEnd
    commit(b.kind === 'line' ? prefixLine(value, s, b.text) : insertAt(value, s, en, b.text))
    el.focus({ preventScroll: true })
  }

  return (
    <div className={`relative flex flex-col ${minHeight}`}>
      <textarea
        ref={ta}
        value={value}
        rows={minRows}
        spellCheck
        autoCapitalize="sentences"
        aria-label="Note text"
        placeholder={placeholder ?? 'Write something…'}
        className="editor-area block grow"
        onChange={(e) => { onChange(e.target.value); refreshTrigger(e.target.value, e.target.selectionStart) }}
        onKeyDown={onKeyDown}
        onKeyUp={(e) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) refreshTrigger(value, e.currentTarget.selectionStart) }}
        onClick={(e) => refreshTrigger(value, e.currentTarget.selectionStart)}
        onBlur={() => setTimeout(() => setTrigger(null), 120)}
      />
      {/* Suggestions + symbols live in one tray pinned above the keyboard / bottom edge: no caret maths needed. */}
      {(showBar || trigger) && <div className="glass-strong sticky bottom-0 z-10 mt-auto rounded-2xl pb-safe">
        {trigger && (
          <div className="border-b border-line">
            <Tray trigger={trigger} selfId={selfId} onPick={pick} index={index} setItems={setItems} setBusy={(b) => { busy.current = b }} />
          </div>
        )}
        {showBar && <div className="flex gap-1 overflow-x-auto px-2 py-1.5" role="toolbar" aria-label="Insert symbol">
          {BAR.map((b) => (
            <button
              key={b.name}
              type="button"
              aria-label={b.name}
              title={b.name}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => bar(b)}
              className="inline-flex h-9 min-w-9 shrink-0 items-center justify-center rounded-xl px-2.5 text-base text-muted hover:bg-hover hover:text-ink"
            >{b.label}</button>
          ))}
          <span className="ml-auto hidden items-center whitespace-nowrap px-2 text-xs text-faint xl:flex">Ctrl+Enter to save &amp; close</span>
        </div>}
      </div>}
    </div>
  )
}
