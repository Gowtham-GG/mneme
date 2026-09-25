import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { savePositions } from '@/api/board'
import { createTask, setTaskOnCanvas } from '@/api/tasks'
import { ruleMessage } from '@/api/errors'
import { Dialog } from '@/components/Dialog'
import { useSettings } from '@/contexts/SettingsContext'
import { useToast } from '@/contexts/ToastContext'
import {
  boardEdges, boundsOf, BOX_H, BOX_W, chainOf, drawnPositions, edgePath, fitView, portalPositions,
  PORTAL_H, PORTAL_W, progressOf, tidyLayout, type BoardData, type EdgeKind, type Portal, type Progress, type Pt,
} from '@/lib/board'
import { formatDueDate, taskDueStatus, todayKey } from '@/lib/dates'
import { childrenOf, descendantIds, isResolved, STATES, type LinkEnd } from '@/lib/taskTree'
import { TaskNode } from './TaskNode'
import { ActionGroup, LinkList, TaskMentions, useTaskUi } from './TaskUi'
import type { TaskItem } from '@/types/db'
import { IconCheck, IconHourglass, IconLink, IconLock, IconMoveUnder, IconPlus, IconTree, IconUnnest, IconWand, IconX } from '@/components/icons'

type View = { x: number; y: number; k: number }
type Gesture =
  | { mode: 'none' }
  | { mode: 'pan'; sx: number; sy: number; view0: View; moved: boolean; edge?: string }
  | { mode: 'drag'; id: string; sx: number; sy: number; start: Record<string, Pt>; moved: boolean }
  | { mode: 'connect'; from: string; sx: number; sy: number; moved: boolean }
  | { mode: 'pinch'; d0: number; mid0: Pt; view0: View }

const MIN_K = 0.3, MAX_K = 2
const clampK = (k: number) => Math.min(MAX_K, Math.max(MIN_K, k))
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)
const mid = (a: Pt, b: Pt) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
/**
 * A touch tap handled on pointerup is followed by the browser's own click — which would land on
 * whatever just opened under the finger (the Connect chooser, the card's delete button). Eat it.
 */
function swallowNextClick() {
  const h = (e: MouseEvent) => { e.stopPropagation(); e.preventDefault(); off() }
  const off = () => document.removeEventListener('click', h, true)
  document.addEventListener('click', h, true)
  setTimeout(off, 500)
}
/** Half-size of the arrow layer: arrows anywhere within it can be tapped. */
const HIT = 50_000
const short = (s: string) => (s.length > 40 ? `${s.slice(0, 39)}…` : s)

const EDGE: Record<EdgeKind, { stroke: string; dash?: string; width: number; marker?: string }> = {
  tree: { stroke: 'var(--faint)', width: 1.5 },
  step: { stroke: 'var(--accent)', width: 2, marker: 'url(#arr-step)' },
  blocks: { stroke: 'var(--important)', dash: '6 4', width: 1.75, marker: 'url(#arr-blocks)' },
  related: { stroke: 'var(--faint)', dash: '2 4', width: 1.5 },
}
/** A short sample of how an arrow kind looks on the board. */
function EdgeSample({ kind }: { kind: EdgeKind }) {
  const st = EDGE[kind]
  return (
    <svg width="40" height="10" className="overflow-visible">
      <line x1="1" y1="5" x2={st.marker ? 32 : 39} y2="5" style={{ stroke: st.stroke }} strokeWidth={st.width} strokeDasharray={st.dash} />
      {st.marker && <path d="M32 1.5 39 5 32 8.5z" style={{ fill: st.stroke }} />}
    </svg>
  )
}
const BORDER: Record<TaskItem['state'], string> = {
  open: 'border-l-line', in_progress: 'border-l-accent', on_hold: 'border-l-important', done: 'border-l-task', cancelled: 'border-l-faint',
}

const PACE: Record<string, [string, string]> = { tight: ['tight', 'text-important'], overdue: ['late', 'text-danger'] }

function BoardBox({ t, at, dim, selected, connecting, progress }: { t: TaskItem; at: Pt; dim: boolean; selected: boolean; connecting: boolean; progress: Progress | null }) {
  const ui = useTaskUi()
  const { timezone: tz } = useSettings()
  const resolved = isResolved(t.state)
  const waiting = !resolved && t.child_count > t.child_resolved
  const due = t.due_date ? taskDueStatus(t.due_date, t.due_time, tz) : null
  return (
    <div
      data-box={t.id} role="button" tabIndex={0} aria-label={t.title} aria-pressed={selected}
      className={`absolute flex cursor-grab flex-col justify-between rounded-xl border border-l-4 border-line bg-raised px-2.5 py-1.5 shadow-sm transition-opacity active:cursor-grabbing ${BORDER[t.state]} ${selected || connecting ? 'ring-2 ring-accent' : ''} ${dim ? 'opacity-25' : ''}`}
      style={{ left: at.x, top: at.y, width: BOX_W, height: BOX_H }}
    >
      <div className="flex min-w-0 items-start gap-1.5">
        {t.blocked && !resolved ? (
          <span className="mt-0.5 shrink-0 text-faint" title="Blocked — waiting on what comes first" aria-label="Blocked"><IconLock size={13} /></span>
        ) : (
          <button type="button" role="checkbox" aria-checked={resolved} aria-label={`${resolved ? 'Reopen' : 'Complete'}: ${t.title}`}
            disabled={waiting} title={waiting ? 'Finishes when its subtasks do' : undefined} onClick={() => void ui.act.tick(t, !resolved)}
            className={`mt-0.5 inline-flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border disabled:opacity-40 ${t.state === 'done' ? 'border-task bg-task text-bg' : 'border-faint'}`}>
            {t.state === 'done' && <IconCheck size={10} strokeWidth={3} />}
            {t.state === 'cancelled' && <IconX size={9} strokeWidth={3} />}
          </button>
        )}
        <span className={`line-clamp-2 text-[13px] leading-snug ${resolved ? 'text-faint line-through' : t.blocked ? 'text-muted' : ''}`}>{t.title}</span>
      </div>
      <div className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap text-[10.5px] text-faint">
        {t.state !== 'open' && !resolved && <span className={t.state === 'in_progress' ? 'text-accent' : 'text-important'}>{STATES.find((s) => s.id === t.state)?.label}</span>}
        {progress ? <span className="tabular-nums text-task">{progress.left ? `${progress.left} left` : 'all done'}</span>
          : t.child_count > 0 && <span className="tabular-nums text-task">{t.child_resolved}/{t.child_count}</span>}
        {progress?.pace && PACE[progress.pace] && <span className={`font-medium ${PACE[progress.pace][1]}`}>{PACE[progress.pace][0]}</span>}
        {t.due_date && <span className={due === 'overdue' ? 'text-danger' : ''}>{formatDueDate(t.due_date, tz)}</span>}
        {t.note_public_id && <span className="tabular-nums">{t.note_public_id}</span>}
      </div>
      {progress && (
        <span className="absolute inset-x-2.5 bottom-0.5 h-[3px] overflow-hidden rounded-full bg-panel" aria-hidden>
          <span className={`block h-full rounded-full ${progress.pace === 'overdue' ? 'bg-danger' : progress.pace === 'tight' ? 'bg-important' : 'bg-task'}`}
            style={{ width: `${(progress.done / progress.total) * 100}%` }} />
        </span>
      )}
      <button type="button" data-handle={t.id} aria-label={`Connect “${t.title}” to…`} title="Drag to another task (or tap, then tap it)"
        className="absolute -right-2.5 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-full">
        <span className="size-2.5 rounded-full border-2 border-accent bg-bg" />
      </button>
    </div>
  )
}

function PortalBox({ p, at, dim, onGo }: { p: Portal; at: Pt; dim: boolean; onGo: (canvasId: string | null, taskId: string) => void }) {
  const o = p.link.other
  const c = o.canvases?.[0]
  return (
    <button type="button" data-portal
      className={`absolute flex items-center gap-1 rounded-full border border-dashed border-line bg-panel px-2.5 text-[11px] hover:border-accent ${dim ? 'opacity-25' : ''}`}
      style={{ left: at.x, top: at.y, width: PORTAL_W, height: PORTAL_H }}
      title={`Open on ${c?.name ?? 'Inbox'}`} onClick={() => onGo(c?.id ?? null, o.id)}>
      <span aria-hidden>{p.kind === 'related' ? '↔' : p.outgoing ? '→' : '←'}</span>
      <span className={`min-w-0 flex-1 truncate text-left ${isResolved(o.state) ? 'line-through' : ''}`}>{o.title}</span>
      <span className="shrink-0 text-faint">{c?.name ?? 'Inbox'}</span>
    </button>
  )
}

export function BoardSurface({ data, board, canvasId, focus, onFocusDone, showDone, setShowDone }: {
  data: BoardData; board: string; canvasId: string | null
  focus: string | null; onFocusDone: () => void
  showDone: boolean; setShowDone: (v: boolean) => void
}) {
  const ui = useTaskUi()
  const navigate = useNavigate()
  const { toast } = useToast()
  const ref = useRef<HTMLDivElement>(null)
  const [view, setViewNow] = useState<View>({ x: 32, y: 32, k: 1 })
  const viewRef = useRef(view)
  useLayoutEffect(() => { viewRef.current = view }, [view])
  // smooth zoom: glide toward a target scale, keeping the world point under the pointer still
  const glide = useRef<{ k: number; mx: number; my: number; wx: number; wy: number; raf: number } | null>(null)
  const stopGlide = () => { if (glide.current) cancelAnimationFrame(glide.current.raf); glide.current = null }
  useEffect(() => stopGlide, [])
  /** Any direct move (pan, fit, pinch) cancels a zoom that's still gliding. */
  const setView: typeof setViewNow = (v) => { stopGlide(); setViewNow(v) }
  const zoomTo = (k: number, mx: number, my: number) => {
    const v = viewRef.current, tk = clampK(k)
    if (glide.current) cancelAnimationFrame(glide.current.raf)
    const wx = (mx - v.x) / v.k, wy = (my - v.y) / v.k
    const g = { k: tk, mx, my, wx, wy, raf: 0 }
    glide.current = g
    const step = () => {
      const cur = viewRef.current
      const nk = Math.abs(g.k - cur.k) < 0.002 ? g.k : cur.k + (g.k - cur.k) * 0.28
      const next = { k: nk, x: g.mx - g.wx * nk, y: g.my - g.wy * nk }
      viewRef.current = next
      setViewNow(next)
      if (nk !== g.k) g.raf = requestAnimationFrame(step)
      else glide.current = null
    }
    g.raf = requestAnimationFrame(step)
  }
  /** Where the zoom is heading, so quick wheel notches add up instead of restarting. */
  const targetK = () => glide.current?.k ?? viewRef.current.k
  const [over, setOver] = useState<Record<string, Pt>>({})
  const [sel, setSel] = useState<string | null>(null)
  // at = the rubber band's end while dragging; null = waiting for a tap on the other task
  const [connect, setConnect] = useState<{ from: string; at: Pt | null } | null>(null)
  const [ask, setAsk] = useState<{ a: TaskItem; b: TaskItem } | null>(null)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const g = useRef<Gesture>({ mode: 'none' })
  const pts = useRef(new Map<number, Pt>())
  const fitted = useRef<string | null>(null)

  useEffect(() => setOver({}), [data])
  const byId = useMemo(() => new Map(data.tasks.map((t) => [t.id, t])), [data])
  const drawn = useMemo(() => drawnPositions(data, over), [data, over])
  const { edges, portals } = useMemo(() => boardEdges(data), [data])
  const portalAt = useMemo(() => portalPositions(portals, drawn), [portals, drawn])
  const chain = useMemo(() => (sel && byId.has(sel) ? chainOf(data, sel) : null), [data, sel, byId])
  const selTask = sel ? byId.get(sel) : undefined
  const { timezone: tz } = useSettings()
  const today = todayKey(tz)
  const progress = useMemo(() => new Map(data.tasks.filter((t) => t.child_count > 0).map((t) => [t.id, progressOf(data, t.id, today)])), [data, today])
  const selProgress = sel ? progress.get(sel) ?? null : null

  const rect = () => ref.current!.getBoundingClientRect()
  const fit = () => {
    const r = rect()
    // phones keep text readable and pan instead
    setView(fitView(boundsOf([...drawn.values(), ...portalAt.values()]), r.width, r.height, r.width < 640 ? 0.6 : 0.3))
  }
  // fit once per board
  useEffect(() => {
    if (fitted.current === board || !ref.current) return
    fitted.current = board
    fit()
  }) // eslint-disable-line react-hooks/exhaustive-deps
  // arriving from a link box on another board: select and centre the task
  useEffect(() => {
    if (!focus || !ref.current) return
    const p = drawn.get(focus)
    if (!p) return
    const r = rect()
    setSel(focus)
    setView((v) => ({ ...v, x: r.width / 2 - (p.x + BOX_W / 2) * v.k, y: r.height / 3 - (p.y + BOX_H / 2) * v.k }))
    onFocusDone()
  }, [focus, drawn]) // eslint-disable-line react-hooks/exhaustive-deps

  // wheel: pan; ctrl/⌘ + wheel (and trackpad pinch): zoom at the pointer
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const h = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest('[data-card]')) return
      e.preventDefault()
      const r = el.getBoundingClientRect()
      if (!e.ctrlKey && !e.metaKey) { setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY })); return }
      // a mouse notch is ~100px (or 3 lines): cap it so one notch is a gentle step; trackpad pinches stay 1:1
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY
      const d = Math.max(-40, Math.min(40, dy))
      zoomTo(targetK() * Math.exp(-d * 0.006), e.clientX - r.left, e.clientY - r.top)
    }
    el.addEventListener('wheel', h, { passive: false })
    return () => el.removeEventListener('wheel', h)
  }, [])

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('dialog[open]')) { setConnect(null); setSel(null) } }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  const toWorld = (cx: number, cy: number): Pt => { const r = rect(); return { x: (cx - r.left - view.x) / view.k, y: (cy - r.top - view.y) / view.k } }
  const zoomBy = (f: number) => {
    const r = rect()
    zoomTo(targetK() * f, r.width / 2, r.height / 2)
  }

  const tapBox = (id: string) => {
    if (connect && connect.at === null) {
      if (connect.from !== id) setAsk({ a: byId.get(connect.from)!, b: byId.get(id)! })
      setConnect(null)
    } else setSel(id)
  }

  const onPointerDown = (e: React.PointerEvent) => {
    const el = e.target as HTMLElement
    const handle = el.closest<HTMLElement>('[data-handle]')
    if (!handle && el.closest('button, input, a, select, textarea, [data-card], [data-ui]')) return
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    ref.current!.setPointerCapture(e.pointerId)
    if (pts.current.size === 2) {
      const [p1, p2] = [...pts.current.values()]
      g.current = { mode: 'pinch', d0: dist(p1, p2), mid0: mid(p1, p2), view0: view }
      setOver({})
      return
    }
    if (pts.current.size > 2) return
    const box = el.closest<HTMLElement>('[data-box]')
    if (handle) { g.current = { mode: 'connect', from: handle.dataset.handle!, sx: e.clientX, sy: e.clientY, moved: false }; return }
    if (box) {
      const id = box.dataset.box!
      // the box and any of its subtasks that were placed by hand move together (the rest follow anyway)
      const ids = [id, ...[...descendantIds(data, id)].filter((d) => data.positions[d])]
      g.current = { mode: 'drag', id, sx: e.clientX, sy: e.clientY, start: Object.fromEntries(ids.map((i) => [i, drawn.get(i)!])), moved: false }
      return
    }
    g.current = { mode: 'pan', sx: e.clientX, sy: e.clientY, view0: view, moved: false, edge: el.closest<SVGElement>('[data-edge]')?.dataset.edge }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pts.current.has(e.pointerId)) return
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const s = g.current
    if (s.mode === 'pinch') {
      if (pts.current.size < 2) return
      const [p1, p2] = [...pts.current.values()]
      const r = rect()
      const k = clampK((s.view0.k * dist(p1, p2)) / s.d0)
      const m0 = { x: s.mid0.x - r.left, y: s.mid0.y - r.top }, m = mid(p1, p2)
      const wx = (m0.x - s.view0.x) / s.view0.k, wy = (m0.y - s.view0.y) / s.view0.k
      setView({ k, x: m.x - r.left - wx * k, y: m.y - r.top - wy * k })
      return
    }
    if (s.mode === 'none') return
    const dx = e.clientX - s.sx, dy = e.clientY - s.sy
    if (Math.hypot(dx, dy) > 4) s.moved = true
    if (!s.moved) return
    if (s.mode === 'pan') setView({ ...s.view0, x: s.view0.x + dx, y: s.view0.y + dy })
    else if (s.mode === 'drag') setOver(Object.fromEntries(Object.entries(s.start).map(([i, p]) => [i, { x: p.x + dx / view.k, y: p.y + dy / view.k }])))
    else if (s.mode === 'connect') setConnect({ from: s.from, at: toWorld(e.clientX, e.clientY) })
  }

  const onPointerUp = (e: React.PointerEvent) => {
    if (!pts.current.delete(e.pointerId)) return
    const s = g.current
    if (s.mode === 'pinch') { if (pts.current.size === 0) g.current = { mode: 'none' }; return }
    g.current = { mode: 'none' }
    if (s.mode !== 'none') swallowNextClick()
    if (s.mode === 'drag') {
      if (!s.moved) return tapBox(s.id)
      const dx = (e.clientX - s.sx) / view.k, dy = (e.clientY - s.sy) / view.k
      const spots = Object.entries(s.start).map(([task_id, p]) => ({ task_id, x: p.x + dx, y: p.y + dy }))
      savePositions(board, spots).then(ui.act.refresh, () => { setOver({}); toast('Couldn’t save the layout.', { kind: 'error' }) })
    } else if (s.mode === 'pan') {
      if (s.moved) return
      if (connect) setConnect(null)
      else if (s.edge) tapEdge(s.edge)
      else setSel(null)
    } else if (s.mode === 'connect') {
      if (!s.moved) { setSel(null); setConnect({ from: s.from, at: null }); return }
      setConnect(null)
      const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-box]')
      if (hit && hit.dataset.box !== s.from) setAsk({ a: byId.get(s.from)!, b: byId.get(hit.dataset.box!)! })
    }
  }
  // tapping an arrow opens the Connect dialog for its two tasks, showing how they're linked now
  const tapEdge = (id: string) => {
    const e = edges.find((x) => x.id === id)
    const a = e && byId.get(e.from), b = e && byId.get(e.to)
    if (a && b) { setSel(null); setAsk({ a, b }) }
  }
  const onPointerCancel = (e: React.PointerEvent) => {
    pts.current.delete(e.pointerId)
    g.current = { mode: 'none' }
    setOver({})
    setConnect((c) => (c?.at ? null : c))
  }

  const addTask = async () => {
    const title = draft.trim()
    if (!title) return
    try {
      const id = await createTask(title)
      if (canvasId) await setTaskOnCanvas(id, canvasId, true)
      const r = rect()
      const c = toWorld(r.left + r.width / 2, r.top + r.height / 3)
      await savePositions(board, [{ task_id: id, x: c.x - BOX_W / 2, y: c.y - BOX_H / 2 }])
      setDraft('')
      setAdding(false)
      ui.act.refresh()
      setSel(id)
    } catch (err) { toast(ruleMessage(err, 'Couldn’t add the task.'), { kind: 'error' }) }
  }

  const tidy = async () => {
    const r = rect()
    const next = tidyLayout(data, r.width / Math.max(r.height, 1), new Set(portals.map((p) => p.taskId)))
    const prev = [...drawn].map(([task_id, p]) => ({ task_id, ...p }))
    const spots = [...next].map(([task_id, p]) => ({ task_id, ...p }))
    setOver(Object.fromEntries(next))
    setView(fitView(boundsOf(next.values()), r.width, r.height, r.width < 640 ? 0.6 : 0.3))
    try {
      await savePositions(board, spots)
      ui.act.refresh()
      toast('Board tidied.', { action: { label: 'Undo', onClick: () => void savePositions(board, prev).then(ui.act.refresh) } })
    } catch { setOver({}); toast('Couldn’t save the layout.', { kind: 'error' }) }
  }

  const goTo = (cid: string | null, taskId: string) => navigate(`/tasks/board?canvas=${cid ?? 'inbox'}&focus=${taskId}`)
  const siblingsOf = (t: TaskItem) => {
    if (!t.parent_id) return {}
    const k = childrenOf(data, t.parent_id)
    return { siblings: t.sequence_id ? k.sequences.find((s) => s.seq.id === t.sequence_id)?.steps : k.loose, parentSeqs: k.sequences.map((s) => s.seq) }
  }
  const lit = (a: string, b: string) => !chain || (chain.has(a) && chain.has(b))
  const btn = 'glass-strong rounded-full px-3 py-1.5 text-sm hover:bg-hover'

  return (
    <div ref={ref} className="relative h-full w-full touch-none select-none overflow-hidden"
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel}>
      <div className="absolute left-0 top-0 origin-top-left" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
        <svg className="pointer-events-none absolute overflow-visible" style={{ left: -HIT, top: -HIT }} width={HIT * 2} height={HIT * 2} aria-hidden>
          <g transform={`translate(${HIT} ${HIT})`}>
          <defs>
            <marker id="arr-step" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 0L10 5L0 10z" style={{ fill: 'var(--accent)' }} />
            </marker>
            <marker id="arr-blocks" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 0L10 5L0 10z" style={{ fill: 'var(--important)' }} />
            </marker>
          </defs>
          {edges.map((e) => {
            const a = drawn.get(e.from), b = drawn.get(e.to)
            if (!a || !b) return null
            const st = EDGE[e.kind]
            const d = edgePath(a, BOX_W, BOX_H, b, BOX_W, BOX_H)
            return (
              <g key={e.id} className="group/edge">
                <path d={d} fill="none" style={{ stroke: st.stroke }} strokeWidth={st.width} strokeDasharray={st.dash} markerEnd={st.marker} opacity={lit(e.from, e.to) ? 1 : 0.12}
                  className="group-hover/edge:[stroke-width:3]" />
                {/* wide invisible stroke: easy to tap */}
                <path d={d} data-edge={e.id} fill="none" stroke="transparent" strokeWidth={16} className="cursor-pointer" style={{ pointerEvents: 'stroke' }} />
              </g>
            )
          })}
          {portals.map((p) => {
            const a = drawn.get(p.taskId), b = portalAt.get(p.id)
            if (!a || !b) return null
            const st = EDGE[p.kind]
            return <path key={p.id} d={p.outgoing ? edgePath(a, BOX_W, BOX_H, b, PORTAL_W, PORTAL_H) : edgePath(b, PORTAL_W, PORTAL_H, a, BOX_W, BOX_H)} fill="none"
              style={{ stroke: st.stroke }} strokeWidth={st.width} strokeDasharray={st.dash} markerEnd={st.marker} opacity={!chain || chain.has(p.taskId) ? 1 : 0.12} />
          })}
          {connect?.at && drawn.get(connect.from) && (
            <path d={`M ${drawn.get(connect.from)!.x + BOX_W} ${drawn.get(connect.from)!.y + BOX_H / 2} L ${connect.at.x} ${connect.at.y}`}
              style={{ stroke: 'var(--accent)' }} strokeWidth={2} strokeDasharray="4 4" />
          )}
          </g>
        </svg>
        {data.tasks.map((t) => (
          <BoardBox key={t.id} t={t} at={drawn.get(t.id)!} dim={!!chain && !chain.has(t.id)} selected={sel === t.id} connecting={connect?.from === t.id}
            progress={progress.get(t.id) ?? null} />
        ))}
        {portals.map((p) => portalAt.get(p.id) && <PortalBox key={p.id} p={p} at={portalAt.get(p.id)!} dim={!!chain && !chain.has(p.taskId)} onGo={goTo} />)}
      </div>

      {/* tools */}
      <div data-ui className="absolute left-2 top-2 flex flex-wrap items-center gap-1.5">
        {adding ? (
          <form className="glass-strong flex items-center gap-1 rounded-full py-1 pl-3 pr-1" onSubmit={(e) => { e.preventDefault(); void addTask() }}>
            <input autoFocus value={draft} maxLength={500} onChange={(e) => setDraft(e.target.value)} placeholder="New task" aria-label="New task"
              onKeyDown={(e) => { if (e.key === 'Escape') setAdding(false) }} onBlur={() => { if (!draft.trim()) setAdding(false) }}
              className="w-40 bg-transparent text-sm outline-none sm:w-56" />
            <button disabled={!draft.trim()} className="rounded-full bg-accent px-3 py-1 text-sm font-medium text-on-accent disabled:opacity-50">Add</button>
          </form>
        ) : (
          <button className={`${btn} flex items-center gap-1`} onClick={() => setAdding(true)}><IconPlus size={14} /> Task</button>
        )}
        {canvasId && (
          <button className={btn} onClick={() => ui.pick({
            title: 'Add to this canvas', exclude: new Set(data.tasks.map((t) => t.id)), rootsOnly: true,
            onPick: (t) => void ui.act.canvas(t.id, canvasId, true),
          })}>+ Existing</button>
        )}
        <label className={`${btn} flex cursor-pointer items-center gap-1.5`}>
          <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} className="size-3.5 accent-[var(--accent)]" /> Done
        </label>
      </div>
      <div data-ui className="absolute right-2 top-2 flex items-center gap-1">
        {data.tasks.length > 1 && (
          <button className={`${btn} flex items-center gap-1`} title="Arrange everything neatly" onClick={() => void tidy()}><IconWand size={14} /> Tidy</button>
        )}
        <button className={btn} aria-label="Zoom out" onClick={() => zoomBy(1 / 1.25)}>−</button>
        <label className="glass-strong hidden items-center gap-2 rounded-full px-3 py-1.5 sm:flex" title="Zoom">
          <input type="range" aria-label="Zoom" min={Math.log(MIN_K)} max={Math.log(MAX_K)} step={0.01} value={Math.log(view.k)}
            onChange={(e) => {
              // instant (no glide), so the handle stays under the finger
              const r = rect(), k = clampK(Math.exp(Number(e.target.value))), mx = r.width / 2, my = r.height / 2
              setView((v) => ({ k, x: mx - ((mx - v.x) * k) / v.k, y: my - ((my - v.y) * k) / v.k }))
            }}
            className="w-28 accent-[var(--accent)]" />
          <span className="w-9 text-right text-xs tabular-nums text-muted">{Math.round(view.k * 100)}%</span>
        </label>
        <button className={btn} aria-label="Fit everything" onClick={fit}>Fit</button>
        <button className={btn} aria-label="Zoom in" onClick={() => zoomBy(1.25)}>+</button>
      </div>

      {connect && connect.at === null && (
        <div data-ui className="glass-strong absolute left-1/2 top-14 flex -translate-x-1/2 items-center gap-2 rounded-full px-3 py-1.5 text-sm">
          <IconLink size={15} className="text-accent" />Now tap the task to connect “{short(byId.get(connect.from)?.title ?? '')}” with
          <button className="text-faint hover:text-ink" onClick={() => setConnect(null)}>Cancel</button>
        </div>
      )}

      {!data.tasks.length && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-faint">No tasks here.</div>
      )}

      {selTask && (
        <div data-card className="glass-strong absolute inset-x-2 bottom-2 z-10 rounded-2xl p-1.5 lg:inset-x-auto lg:bottom-auto lg:right-2 lg:top-14 lg:w-[380px]">
          <ul><TaskNode t={selTask} tree={data} leafOnly {...siblingsOf(selTask)} /></ul>
          {selProgress && (
            <p className="px-2 text-xs text-muted">
              {selProgress.done} of {selProgress.total} steps done
              {selProgress.daysLeft !== null && selProgress.left > 0 && <> · {selProgress.daysLeft < 0 ? `${-selProgress.daysLeft} day${selProgress.daysLeft === -1 ? '' : 's'} late` : selProgress.daysLeft === 0 ? 'due today' : `${selProgress.daysLeft} day${selProgress.daysLeft === 1 ? '' : 's'} to go`}</>}
              {selProgress.pace === 'tight' && <span className="text-important"> — tight</span>}
            </p>
          )}
          <div className="px-2"><TaskMentions taskId={selTask.id} /></div>
          <div className="flex justify-end gap-3 px-2 pb-1 pt-0.5 text-xs text-muted">
            <button className="flex items-center gap-1 hover:text-accent" title="Link it to another task on this board" onClick={() => setConnect({ from: selTask.id, at: null })}><IconLink size={14} />Connect…</button>
            <button className="flex items-center gap-1 hover:text-accent" title="See the full tree it belongs to" onClick={() => ui.openTree(selTask.root_id, selTask.id)}><IconTree size={14} />Whole task</button>
            <button className="flex items-center gap-1 hover:text-ink" onClick={() => setSel(null)}><IconX size={14} />Close</button>
          </div>
        </div>
      )}

      <Dialog open={!!ask} onClose={() => setAsk(null)} title="Connect two tasks" wide>
        {ask && (() => {
          const { a, b } = ask
          const A = `“${short(a.title)}”`, B = `“${short(b.title)}”`
          const go = (f: () => Promise<unknown>) => () => { setAsk(null); void f() }
          // a task can't go under its own subtask
          // what already joins them: choosing a new kind of link replaces it rather than adding a second
          const existing = data.links.filter((l) => (l.from_task_id === a.id && l.to_task_id === b.id) || (l.from_task_id === b.id && l.to_task_id === a.id))
          const setLink = (from: TaskItem, to: TaskItem, kind: 'blocks' | 'related') => {
            const same = existing.find((l) => l.from_task_id === from.id && l.to_task_id === to.id && l.kind === kind)
            if (same) return Promise.resolve()
            return existing[0] ? ui.act.relink(existing[0].id, from.id, to.id, kind) : ui.act.link(from.id, to.id, kind)
          }
          const isLink = (from: TaskItem, kind: 'blocks' | 'related') => existing.some((l) => l.kind === kind && (kind === 'related' || l.from_task_id === from.id))
          const child = b.parent_id === a.id ? b : a.parent_id === b.id ? a : null
          const stepPair = a.sequence_id && a.sequence_id === b.sequence_id ? (a.sort_order > b.sort_order ? a : b) : null
          const ends: LinkEnd[] = existing.map((l) => ({ link: l, id: b.id, title: b.title, state: b.state, rootId: b.root_id }))
          const bUnderA = b.parent_id === a.id ? 'It’s already there' : descendantIds(data, b.id).has(a.id) ? `Not possible — ${A} is inside ${B}` : null
          const aUnderB = a.parent_id === b.id ? 'It’s already there' : descendantIds(data, a.id).has(b.id) ? `Not possible — ${B} is inside ${A}` : null
          return (
            <>
              <h2 className="mb-3 text-lg font-semibold">{existing.length || child || stepPair ? 'Connection' : 'Connect two tasks'}</h2>
              <div className="mb-4 grid grid-cols-[1fr_auto_1fr] items-center gap-2 text-sm">
                <span className="truncate rounded-xl bg-panel px-3 py-2 font-medium" title={a.title}>{a.title}</span>
                <IconLink size={16} className="text-faint" />
                <span className="truncate rounded-xl bg-panel px-3 py-2 font-medium" title={b.title}>{b.title}</span>
              </div>
              <div className="grid gap-2">
                <LinkList t={a} ends={ends} onDone={() => setAsk(null)} />
                <ActionGroup title="Joined now" cols={1} acts={[
                  !!child && { icon: IconUnnest, label: `Detach ${short(child.title)}`, hint: 'Make it a main task again', aside: <EdgeSample kind="tree" />,
                    onClick: go(() => ui.act.moveUnder(child, null, null, 'Now a main task')) },
                  !!stepPair && !!stepPair.parent_id && { icon: IconUnnest, label: `Take ${short(stepPair.title)} out of the sequence`, hint: 'It stays a subtask, with no order', aside: <EdgeSample kind="step" />,
                    onClick: go(() => ui.act.moveUnder(stepPair, stepPair.parent_id, null)) },
                ]} />
                <ActionGroup title="Put one inside the other" acts={[
                  { icon: IconMoveUnder, label: `${short(b.title)} goes under`, hint: bUnderA ?? `${B} becomes a subtask of ${A}`, disabled: !!bUnderA, aside: <EdgeSample kind="tree" />,
                    onClick: go(() => ui.act.moveUnder(b, a.id, null, `${short(b.title)} is now a subtask`)) },
                  { icon: IconMoveUnder, label: `${short(a.title)} goes under`, hint: aUnderB ?? `${A} becomes a subtask of ${B}`, disabled: !!aUnderB, aside: <EdgeSample kind="tree" />,
                    onClick: go(() => ui.act.moveUnder(a, b.id, null, `${short(a.title)} is now a subtask`)) },
                ]} />
                <ActionGroup title="One must finish first" acts={[
                  { icon: IconHourglass, label: `${short(a.title)} first`, hint: `${B} stays Blocked until ${A} is done`, aside: <EdgeSample kind="blocks" />,
                    disabled: isLink(a, 'blocks'), onClick: go(() => setLink(a, b, 'blocks')) },
                  { icon: IconHourglass, label: `${short(b.title)} first`, hint: `${A} stays Blocked until ${B} is done`, aside: <EdgeSample kind="blocks" />,
                    disabled: isLink(b, 'blocks'), onClick: go(() => setLink(b, a, 'blocks')) },
                ]} />
                <ActionGroup title="Just a reference" cols={1} acts={[
                  { icon: IconLink, label: 'Related', hint: 'A dotted line between them — doesn’t block or change either task', aside: <EdgeSample kind="related" />,
                    disabled: isLink(a, 'related'), onClick: go(() => setLink(a, b, 'related')) },
                ]} />
              </div>
            </>
          )
        })()}
      </Dialog>
    </div>
  )
}
