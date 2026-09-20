import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { searchNotes } from '@/api/search'
import { useDebounced } from '@/hooks/useDebounced'
import { useSettings } from '@/contexts/SettingsContext'
import { THEMES } from '@/lib/themes'
import { displayTitle, isNoteId } from '@/lib/text'
import { Dialog } from './Dialog'

interface Item { key: string; label: string; hint?: string; run: () => void }

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNavigate()
  const { activeTheme, update } = useSettings()
  const [q, setQ] = useState('')
  const [i, setI] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const dq = useDebounced(q.trim(), 160)

  useEffect(() => { if (open) { setQ(''); setI(0); setTimeout(() => input.current?.focus(), 30) } }, [open])

  const notes = useQuery({ queryKey: ['palette', dq], queryFn: () => searchNotes(dq, 6), enabled: open && dq.length > 0, staleTime: 10_000 })

  const go = (to: string) => () => { onClose(); nav(to) }
  const actions = useMemo<Item[]>(() => [
    { key: 'new', label: 'New note', hint: 'Ctrl+N', run: go('/n/new') },
    { key: 'today', label: 'Open today', run: go('/') },
    { key: 'notes', label: 'All notes (timeline)', run: go('/notes') },
    { key: 'tasks', label: 'Tasks', run: go('/tasks') },
    { key: 'inbox', label: 'Inbox — captures to process', run: go('/inbox') },
    { key: 'search', label: 'Search', hint: '/', run: go('/search') },
    { key: 'index', label: 'Index (tags)', run: go('/tags') },
    { key: 'starred', label: 'Starred', run: go('/starred') },
    { key: 'archive', label: 'Archive', run: go('/archive') },
    { key: 'trash', label: 'Trash', run: go('/trash') },
    { key: 'theme', label: `Theme: ${activeTheme} → switch to next`, hint: 'appearance', run: () => { onClose(); const i = THEMES.findIndex((t) => t.id === activeTheme); void update({ theme: THEMES[(i + 1) % THEMES.length].id }) } },
    { key: 'themes', label: 'Choose a theme…', run: go('/settings#appearance') },
    { key: 'export', label: 'Export my notes…', run: go('/settings#export') },
    { key: 'settings', label: 'Settings', run: go('/settings') },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [activeTheme])

  const items: Item[] = useMemo(() => {
    const ql = q.trim().toLowerCase()
    const out: Item[] = []
    if (ql && isNoteId(ql)) out.push({ key: 'id', label: `Go to ${ql.toUpperCase()}`, hint: 'note ID', run: go(`/n/${ql.toUpperCase()}`) })
    if (ql) out.push(...actions.filter((a) => a.label.toLowerCase().includes(ql)).slice(0, 4))
    else out.push(...actions)
    for (const n of notes.data ?? []) out.push({ key: n.id, label: displayTitle(n), hint: n.public_id, run: go(`/n/${n.public_id}`) })
    if (ql) out.push({ key: 'search', label: `Search all notes for “${q.trim()}”`, run: go(`/search?q=${encodeURIComponent(q.trim())}`) })
    return out
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, actions, notes.data])

  useEffect(() => setI(0), [q])

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setI((v) => Math.min(v + 1, items.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setI((v) => Math.max(v - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); items[i]?.run() }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Command palette" wide>
      <input
        ref={input} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey}
        role="combobox" aria-expanded="true" aria-controls="palette-list" aria-label="Type a command, note title or ID"
        placeholder="Type a command, a note title, or N-260920-042…"
        className="mb-2 w-full rounded-lg border border-line bg-bg px-3 py-2.5 text-base outline-none focus:border-accent"
      />
      <ul id="palette-list" role="listbox" className="max-h-80 overflow-y-auto">
        {items.map((it, idx) => (
          <li key={it.key + idx} role="option" aria-selected={idx === i}>
            <button className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm ${idx === i ? 'bg-accent-soft' : 'hover:bg-hover'}`} onMouseMove={() => setI(idx)} onClick={it.run}>
              <span className="truncate">{it.label}</span>
              {it.hint && <span className="shrink-0 text-xs text-faint">{it.hint}</span>}
            </button>
          </li>
        ))}
        {!items.length && <li className="px-3 py-6 text-center text-sm text-faint">Nothing found</li>}
      </ul>
    </Dialog>
  )
}
