import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { boardKey, getBoard } from '@/api/board'
import { deleteCanvas, listCanvases, renameCanvas, reorderCanvases, type CanvasData } from '@/api/tasks'
import { ruleMessage } from '@/api/errors'
import { ConfirmDialog, Dialog } from '@/components/Dialog'
import { useToast } from '@/contexts/ToastContext'
import { BoardSurface } from '@/components/tasks/BoardSurface'
import { TaskUiProvider, useTaskUi } from '@/components/tasks/TaskUi'
import { ViewToggle } from '@/components/tasks/ViewToggle'
import type { Canvas } from '@/types/db'
import { IconMore, IconPlus } from '@/components/icons'

const LAST = 'mneme-board-canvas'
const remember = (v: string) => { try { localStorage.setItem(LAST, v) } catch { /* private mode */ } }
const recall = () => { try { return localStorage.getItem(LAST) } catch { return null } }

/**
 * Drag canvas tabs sideways to reorder them. A mouse or pen drags as soon as it moves;
 * a finger has to press and hold first, so an ordinary swipe still scrolls the strip.
 */
function useTabDrag(ids: string[], onDrop: (order: string[]) => void) {
  const [state, setState] = useState<{ id: string; order: string[] } | null>(null)
  const strip = useRef<HTMLDivElement>(null)
  const press = useRef<{ id: string; x: number; y: number; timer?: number; dragging: boolean } | null>(null)
  const orderRef = useRef<string[] | null>(null)

  const start = () => {
    const p = press.current
    if (!p) return
    p.dragging = true
    orderRef.current = ids
    setState({ id: p.id, order: ids })
    navigator.vibrate?.(10)
  }
  const onPointerDown = (id: string) => (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const p = { id, x: e.clientX, y: e.clientY, dragging: false, timer: undefined as number | undefined }
    press.current = p
    if (e.pointerType === 'touch') p.timer = window.setTimeout(start, 350)
    // while a finger drags, the strip must not scroll
    const block = (ev: TouchEvent) => { if (press.current?.dragging) ev.preventDefault() }
    const move = (ev: PointerEvent) => {
      const q = press.current
      if (!q) return
      const far = Math.hypot(ev.clientX - q.x, ev.clientY - q.y)
      if (!q.dragging) {
        if (ev.pointerType === 'touch') { if (far > 8) end(false) } // it's a scroll
        else if (far > 5) start()
        if (!press.current?.dragging) return
      }
      // the tab goes where the pointer is, among the others' midpoints
      const cur = orderRef.current ?? ids
      const others = cur.filter((x) => x !== q.id)
      const mids = others.map((x) => { const r = strip.current?.querySelector<HTMLElement>(`[data-chip="${x}"]`)?.getBoundingClientRect(); return r ? r.left + r.width / 2 : 0 })
      const at = mids.filter((m) => ev.clientX > m).length
      const next = [...others.slice(0, at), q.id, ...others.slice(at)]
      if (next.join() !== cur.join()) { orderRef.current = next; setState({ id: q.id, order: next }) }
    }
    const up = () => end(true)
    const end = (drop: boolean) => {
      const q = press.current
      window.clearTimeout(q?.timer)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('touchmove', block)
      press.current = null
      if (q?.dragging) {
        // the click that ends a drag must not also switch tabs
        const eat = (ev: MouseEvent) => { ev.stopPropagation(); ev.preventDefault() }
        window.addEventListener('click', eat, { capture: true, once: true })
        setTimeout(() => window.removeEventListener('click', eat, { capture: true }), 0)
        const final = orderRef.current
        if (drop && final && final.join() !== ids.join()) onDrop(final)
      }
      orderRef.current = null
      setState(null)
    }
    const cancel = () => end(false)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('touchmove', block, { passive: false })
  }
  return { strip, order: state?.order ?? null, dragging: state?.id ?? null, onPointerDown }
}

export function Board() {
  return <TaskUiProvider><BoardPage /></TaskUiProvider>
}

function BoardPage() {
  const ui = useTaskUi()
  const qc = useQueryClient()
  const { toast } = useToast()
  const [sp, setSp] = useSearchParams()
  const param = sp.get('canvas')
  const focus = sp.get('focus')
  const canvases = useQuery({ queryKey: ['canvases'], queryFn: listCanvases, staleTime: 30_000 })
  const list = canvases.data?.canvases ?? []
  const canvasId = param && param !== 'inbox' ? param : null
  const [showDone, setShowDone] = useState(false)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [editing, setEditing] = useState<Canvas | null>(null)
  const [confirmDel, setConfirmDel] = useState<Canvas | null>(null)

  // open the board used last on this device
  useEffect(() => {
    if (param) return
    const last = recall()
    if (last && last !== 'inbox') setSp({ canvas: last }, { replace: true })
  }, [param]) // eslint-disable-line react-hooks/exhaustive-deps
  // a canvas that no longer exists falls back to the Inbox
  useEffect(() => {
    if (canvasId && canvases.isSuccess && !canvases.isFetching && !list.some((c) => c.id === canvasId)) { remember('inbox'); setSp({}, { replace: true }) }
  }, [canvasId, canvases.isSuccess, canvases.isFetching, list]) // eslint-disable-line react-hooks/exhaustive-deps

  const saveOrder = async (ids: string[]) => {
    // show the new order at once; the list refetch confirms it
    qc.setQueryData<CanvasData>(['canvases'], (d) => d && ({ ...d, canvases: ids.map((id) => d.canvases.find((c) => c.id === id)!).filter(Boolean) }))
    try { await reorderCanvases(ids) } catch { toast('Couldn’t save the order.', { kind: 'error' }) }
    void qc.invalidateQueries({ queryKey: ['canvases'] })
  }
  const { strip, ...drag } = useTabDrag(list.map((c) => c.id), (ids) => void saveOrder(ids))
  const shown = drag.order ? drag.order.map((id) => list.find((c) => c.id === id)!).filter(Boolean) : list
  const moveBy = (c: Canvas, d: -1 | 1) => {
    const ids = list.map((x) => x.id), i = ids.indexOf(c.id), j = i + d
    if (i < 0 || j < 0 || j >= ids.length) return
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
    void saveOrder(ids)
  }

  const board = useQuery({ queryKey: ['tasks', 'board', canvasId, showDone], queryFn: () => getBoard(canvasId, showDone) })
  const go = (id: string | null) => { remember(id ?? 'inbox'); setSp(id ? { canvas: id } : {}) }
  const create = async () => {
    const n = name.trim()
    if (!n) return
    const c = await ui.act.createCanvas(n)
    if (!c) return
    // known right away, so switching to it never races the list refetch
    qc.setQueryData<CanvasData>(['canvases'], (d) => d && ({ ...d, canvases: [...d.canvases.filter((x) => x.id !== c.id), c] }))
    setName(''); setNaming(false); go(c.id)
  }
  const tab = (on: boolean) => `flex shrink-0 items-center gap-1 rounded-full px-3.5 py-1.5 text-sm ${on ? 'bg-accent font-medium text-on-accent' : 'text-muted hover:bg-hover hover:text-ink'}`

  return (
    <div className="flex h-full flex-col">
      <div className="page-top mx-auto w-full max-w-6xl px-4 lg:px-6">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h1 className="text-[28px] font-semibold leading-tight">Tasks<span className="text-accent">.</span></h1>
          <ViewToggle />
        </div>
        <div ref={strip} role="tablist" aria-label="Canvases" className="mb-3 flex select-none items-center gap-1 overflow-x-auto [scrollbar-width:none]">
          <button role="tab" aria-selected={!canvasId} className={tab(!canvasId)} onClick={() => go(null)}>Inbox</button>
          {shown.map((c) => {
            const on = c.id === canvasId
            return (
              <span key={c.id} data-chip={c.id} title="Drag to reorder" onPointerDown={drag.onPointerDown(c.id)} onContextMenu={(e) => e.preventDefault()}
                className={`${tab(on)} ${drag.dragging === c.id ? 'cursor-grabbing ring-2 ring-accent' : ''}`}>
                <button role="tab" aria-selected={on} onClick={() => go(c.id)}>{c.name}</button>
                {on && <button aria-label={`Canvas “${c.name}” options`} className="-mr-1.5 rounded-full p-0.5 hover:bg-on-accent/20" onClick={() => { setEditing(c); setName(c.name) }}><IconMore size={14} /></button>}
              </span>
            )
          })}
          {naming ? (
            <form className="flex shrink-0 items-center gap-1" onSubmit={(e) => { e.preventDefault(); void create() }}>
              <input autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Canvas name" aria-label="Canvas name"
                onKeyDown={(e) => { if (e.key === 'Escape') setNaming(false) }} onBlur={() => { if (!name.trim()) setNaming(false) }}
                className="w-36 rounded-full border border-line bg-bg px-3 py-1 text-sm outline-none focus:border-accent" />
            </form>
          ) : (
            <button aria-label="New canvas" className="shrink-0 rounded-full p-1.5 text-faint hover:bg-hover hover:text-ink" onClick={() => { setName(''); setNaming(true) }}><IconPlus size={16} /></button>
          )}
        </div>
      </div>
      <div className="glass relative mx-2 mb-24 min-h-0 flex-1 overflow-hidden rounded-2xl sm:mx-4 lg:mx-6 lg:mb-2">
        {board.data
          ? <BoardSurface data={board.data} board={boardKey(canvasId)} canvasId={canvasId} focus={focus}
              onFocusDone={() => { const n = new URLSearchParams(sp); n.delete('focus'); setSp(n, { replace: true }) }}
              showDone={showDone} setShowDone={setShowDone} />
          : board.isError ? <p className="p-6 text-sm text-danger">Couldn’t load the board.</p> : <div className="skeleton m-4 h-24" />}
      </div>

      <Dialog open={!!editing} onClose={() => setEditing(null)} title="Canvas">
        <h2 className="mb-3 text-base font-semibold">Canvas</h2>
        <form className="mb-4 flex gap-2" onSubmit={async (e) => {
          e.preventDefault()
          if (!editing || !name.trim()) return
          try { await renameCanvas(editing.id, name); ui.act.refresh(); setEditing(null) } catch (err) { toast(ruleMessage(err, 'Couldn’t rename — is the name taken?'), { kind: 'error' }) }
        }}>
          <input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} aria-label="Canvas name"
            className="min-w-0 flex-1 rounded-xl border border-line bg-bg px-3 py-2 text-sm outline-none focus:border-accent" />
          <button disabled={!name.trim()} className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-on-accent disabled:opacity-50">Rename</button>
        </form>
        <div className="flex items-center justify-between gap-2">
          <div className="flex gap-1.5">
            {editing && (() => { const i = list.findIndex((c) => c.id === editing.id); return (<>
              <button className="rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-hover disabled:opacity-40" disabled={i <= 0} onClick={() => moveBy(editing, -1)}>← Move left</button>
              <button className="rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-hover disabled:opacity-40" disabled={i < 0 || i >= list.length - 1} onClick={() => moveBy(editing, 1)}>Move right →</button>
            </>) })()}
          </div>
          <button className="text-sm text-danger hover:underline" onClick={() => { setConfirmDel(editing); setEditing(null) }}>Delete canvas</button>
        </div>
      </Dialog>
      <ConfirmDialog open={!!confirmDel} title={`Delete “${confirmDel?.name ?? ''}”?`} danger confirmLabel="Delete" onClose={() => setConfirmDel(null)}
        body="Its tasks stay. Ones on no other canvas go back to the Inbox."
        onConfirm={async () => {
          if (!confirmDel) return
          try { await deleteCanvas(confirmDel.id); go(null); ui.act.refresh() } catch { toast('Couldn’t delete the canvas.', { kind: 'error' }) }
        }} />
    </div>
  )
}
