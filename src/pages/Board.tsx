import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { boardKey, getBoard } from '@/api/board'
import { deleteCanvas, listCanvases, renameCanvas, type CanvasData } from '@/api/tasks'
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
          <h1 className="text-[28px] font-semibold leading-tight">Tasks</h1>
          <ViewToggle />
        </div>
        <div role="tablist" aria-label="Canvases" className="mb-3 flex items-center gap-1 overflow-x-auto [scrollbar-width:none]">
          <button role="tab" aria-selected={!canvasId} className={tab(!canvasId)} onClick={() => go(null)}>Inbox</button>
          {list.map((c) => {
            const on = c.id === canvasId
            return (
              <span key={c.id} className={tab(on)}>
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
        <button className="text-sm text-danger hover:underline" onClick={() => { setConfirmDel(editing); setEditing(null) }}>Delete canvas</button>
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
