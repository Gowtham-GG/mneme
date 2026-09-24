import { createContext, useContext, useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  addSequence, addSubtask, addTaskLink, createCanvas, deleteSequence, deleteTask, deleteTaskLink, getTaskTree,
  listCanvases, moveUnder, pickableTasks, renameSequence, renameTask, reorderTask, setTaskDone, setTaskOnCanvas, setTaskState, snoozeTask,
  taskMentions, updateTask,
} from '@/api/tasks'
import { ruleMessage } from '@/api/errors'
import { ConfirmDialog, Dialog } from '@/components/Dialog'
import { DueDialog } from '@/components/DueDialog'
import { useDebounced } from '@/hooks/useDebounced'
import { useSettings } from '@/contexts/SettingsContext'
import { addDays, formatDueDate, todayKey } from '@/lib/dates'
import { useToast } from '@/contexts/ToastContext'
import { descendantIds, nudgeOrder, STATES } from '@/lib/taskTree'
import { PRIORITIES } from './pickers'
import { TaskNode, HighlightContext } from './TaskNode'
import type { TaskItem, TaskPriority, TaskSequence, TaskState, TaskTree } from '@/types/db'
import {
  IconArrowDown, IconArrowUp, IconBoard, IconCopy, IconHourglass, IconLink, IconMoveUnder, IconNotes, IconPullIn,
  IconSearch, IconSnooze, IconSteps, IconSubtask, IconTree, IconUnnest,
} from '@/components/icons'

export function useTaskTree(rootId: string | undefined, enabled = true) {
  return useQuery({ queryKey: ['tasks', 'tree', rootId], queryFn: () => getTaskTree(rootId!), enabled: !!rootId && enabled })
}

interface MenuReq {
  t: TaskItem
  tree?: TaskTree
  /** The group the task sits in (steps of its sequence, or its loose siblings), for Move up/down. */
  siblings?: TaskItem[]
  /** Sequences of its parent, for "Into sequence". */
  parentSeqs?: TaskSequence[]
  onAddSub: () => void
  onAddSeq: () => void
}
interface PickReq { title: string; exclude: Set<string>; rootsOnly?: boolean; onPick: (t: TaskItem) => void }
interface ConfirmReq { title: string; body: string; confirmLabel: string; onConfirm: () => void }

function useActions(confirm: (r: ConfirmReq) => void) {
  const qc = useQueryClient()
  const { toast } = useToast()
  const refresh = () => {
    for (const k of ['tasks', 'notes', 'note-context', 'due-task-count', 'canvases']) void qc.invalidateQueries({ queryKey: [k] })
  }
  const run = async (p: () => Promise<unknown>, fail: string, ok?: string) => {
    try { await p(); refresh(); if (ok) toast(ok); return true } catch (e) { toast(ruleMessage(e, fail), { kind: 'error' }); return false }
  }
  return {
    refresh,
    tick: async (t: TaskItem, done: boolean) => {
      if (await run(() => setTaskDone(t.id, done), 'Couldn’t update the task.') && done)
        toast(`Done: ${t.title}`, { action: { label: 'Undo', onClick: () => void run(() => setTaskDone(t.id, false), 'Couldn’t undo.') } })
    },
    state: (t: TaskItem, s: TaskState) => run(() => setTaskState(t.id, s), 'Couldn’t change the status.'),
    due: (t: TaskItem, d: string | null, time: string | null) =>
      run(() => updateTask(t.id, { due_date: d, due_time: d ? time : null }), 'Couldn’t set the date.'),
    priority: (t: TaskItem, p: TaskPriority | null) => run(() => updateTask(t.id, { priority: p }), 'Couldn’t set the priority.'),
    rename: (t: TaskItem, title: string) => run(() => renameTask(t.id, title), 'Couldn’t rename the task.'),
    del: (t: TaskItem) => {
      const go = () => run(() => deleteTask(t.id), 'Couldn’t delete the task.', t.note_public_id ? `Deleted · line removed from ${t.note_public_id}` : 'Deleted')
      if (t.child_count > 0) confirm({ title: `Delete “${t.title}”?`, body: 'Its subtasks are deleted too.', confirmLabel: 'Delete', onConfirm: () => void go() })
      else void go()
    },
    addSub: (parentId: string, title: string, sequenceId: string | null = null) => run(() => addSubtask(parentId, title, sequenceId), 'Couldn’t add it.'),
    addSeq: async (taskId: string, title: string | null, firstStep: string) => {
      try { const id = await addSequence(taskId, title, firstStep); refresh(); return id } catch (e) { toast(ruleMessage(e, 'Couldn’t add the sequence.'), { kind: 'error' }); return null }
    },
    renameSeq: (id: string, title: string | null) => run(() => renameSequence(id, title), 'Couldn’t rename the sequence.'),
    delSeq: (seq: TaskSequence, steps: number) => {
      const go = () => run(() => deleteSequence(seq.id), 'Couldn’t delete the sequence.')
      if (steps > 0) confirm({ title: `Delete “${seq.title || 'Sequence'}”?`, body: `Its ${steps} step${steps === 1 ? '' : 's'} are deleted too.`, confirmLabel: 'Delete', onConfirm: () => void go() })
      else void go()
    },
    moveUnder: (t: TaskItem, parentId: string | null, sequenceId: string | null = null, ok?: string) =>
      run(() => moveUnder(t.id, parentId, sequenceId), 'Couldn’t move the task.', ok),
    reorder: (t: TaskItem, sortOrder: number) => run(() => reorderTask(t.id, sortOrder), 'Couldn’t move the task.'),
    link: (fromId: string, toId: string, kind: 'blocks' | 'related') => run(() => addTaskLink(fromId, toId, kind), 'Couldn’t link the tasks.'),
    unlink: (linkId: string) => run(() => deleteTaskLink(linkId), 'Couldn’t remove the link.'),
    snooze: (t: TaskItem, until: string | null) =>
      run(() => snoozeTask(t.id, until), 'Couldn’t snooze the task.', until ? `Snoozed until ${until}` : 'Back in your lists'),
    copyLink: async (t: TaskItem) => {
      try { await navigator.clipboard.writeText(`[[${t.code}]]`); toast(`Copied [[${t.code}]] — paste it into a note`) } catch { toast(`Link: [[${t.code}]]`) }
    },
    canvas: (taskId: string, canvasId: string, on: boolean) => run(() => setTaskOnCanvas(taskId, canvasId, on), 'Couldn’t update the canvas.'),
    createCanvas: async (name: string) => {
      try { const c = await createCanvas(name); refresh(); return c } catch (e) { toast(ruleMessage(e, 'Couldn’t create the canvas — is the name taken?'), { kind: 'error' }); return null }
    },
  }
}

export type TaskActions = ReturnType<typeof useActions>

interface TaskUiApi {
  act: TaskActions
  openMenu: (r: MenuReq) => void
  pick: (r: PickReq) => void
  openCanvases: (t: TaskItem) => void
  openTree: (rootId: string, highlightId?: string) => void
  openSnooze: (t: TaskItem) => void
  canvasNames: (taskId: string) => string[]
}

const Ctx = createContext<TaskUiApi | null>(null)

// eslint-disable-next-line react-refresh/only-export-components
export function useTaskUi(): TaskUiApi {
  const v = useContext(Ctx)
  if (!v) throw new Error('useTaskUi outside TaskUiProvider')
  return v
}

/** Task actions + the dialogs every task row can open (menu, picker, canvases, whole tree). */
export function TaskUiProvider({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState<MenuReq | null>(null)
  const [picker, setPicker] = useState<PickReq | null>(null)
  const [canvasFor, setCanvasFor] = useState<TaskItem | null>(null)
  const [treeReq, setTreeReq] = useState<{ rootId: string; highlightId?: string } | null>(null)
  const [confirmReq, setConfirmReq] = useState<ConfirmReq | null>(null)
  const [snoozeFor, setSnoozeFor] = useState<TaskItem | null>(null)
  const act = useActions(setConfirmReq)
  const canvases = useQuery({ queryKey: ['canvases'], queryFn: listCanvases, staleTime: 30_000 })

  const api = useMemo<TaskUiApi>(() => {
    const byId = new Map((canvases.data?.canvases ?? []).map((c) => [c.id, c.name]))
    return {
      act,
      openMenu: setMenu,
      pick: setPicker,
      openCanvases: setCanvasFor,
      openTree: (rootId, highlightId) => setTreeReq({ rootId, highlightId }),
      openSnooze: setSnoozeFor,
      canvasNames: (taskId) => (canvases.data?.membership ?? []).filter((m) => m.task_id === taskId).map((m) => byId.get(m.canvas_id) ?? '').filter(Boolean),
    }
  }, [act, canvases.data])

  return (
    <Ctx.Provider value={api}>
      {children}
      <TreeDialog req={treeReq} onClose={() => setTreeReq(null)} />
      <MenuDialog req={menu} onClose={() => setMenu(null)} />
      <PickerDialog req={picker} onClose={() => setPicker(null)} />
      <CanvasDialog task={canvasFor} onClose={() => setCanvasFor(null)} />
      <SnoozeDialog task={snoozeFor} onClose={() => setSnoozeFor(null)} />
      <ConfirmDialog open={!!confirmReq} title={confirmReq?.title ?? ''} body={confirmReq?.body ?? ''} danger
        confirmLabel={confirmReq?.confirmLabel ?? 'OK'} onClose={() => setConfirmReq(null)} onConfirm={() => confirmReq?.onConfirm()} />
    </Ctx.Provider>
  )
}

// ------------------------------------------------------------------ menu --

const chip = (on: boolean) => `rounded-full px-3 py-1.5 text-sm ${on ? 'bg-accent font-medium text-on-accent' : 'bg-panel hover:bg-hover'}`
/** One row of an action menu: tinted icon, label, one-line hint (and an optional preview on the right). */
export type Act = { icon: ComponentType<{ size?: number }>; label: string; hint: string; onClick: () => void; disabled?: boolean; aside?: ReactNode }

export function ActionGroup({ title, acts, cols = 2 }: { title: string; acts: (Act | false | null | undefined)[]; cols?: 1 | 2 }) {
  const shown = acts.filter(Boolean) as Act[]
  if (!shown.length) return null
  return (
    <section className="rounded-2xl bg-panel/60 p-1.5">
      <h3 className="px-2.5 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint">{title}</h3>
      <div className={`grid gap-0.5 ${cols === 2 ? 'sm:grid-cols-2' : ''}`}>
        {shown.map((a) => (
          <button key={a.label} disabled={a.disabled} onClick={a.onClick}
            className="flex items-start gap-3 rounded-xl px-2.5 py-2 text-left hover:bg-hover disabled:opacity-40 disabled:hover:bg-transparent">
            <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent"><a.icon size={18} /></span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{a.label}</span>
              <span className="block text-xs leading-snug text-muted">{a.hint}</span>
            </span>
            {a.aside && <span className="shrink-0 self-center" aria-hidden>{a.aside}</span>}
          </button>
        ))}
      </div>
    </section>
  )
}

function MenuDialog({ req, onClose }: { req: MenuReq | null; onClose: () => void }) {
  const ui = useTaskUi()
  const navigate = useNavigate()
  if (!req) return <Dialog open={false} onClose={onClose} title="Task"><span /></Dialog>
  const { t, tree, siblings, parentSeqs } = req
  const then = (f: () => void) => () => { onClose(); f() }
  // a note arranges its own tasks' order; moves (which rewrite the note) work for every task
  const reorderable = t.source === 'standalone'
  const below = descendantIds(tree, t.id)
  const up = siblings && reorderable ? nudgeOrder(siblings, t.id, -1) : null
  const down = siblings && reorderable ? nudgeOrder(siblings, t.id, 1) : null
  const noteHint = t.source === 'note' ? ' (rewrites the note)' : ''
  const canReorder = up !== null || down !== null

  return (
    <Dialog open onClose={onClose} title={t.title} wide>
      <h2 className="mb-4 line-clamp-2 text-lg font-semibold">{t.title}</h2>
      <div className="mb-4 grid gap-3 sm:grid-cols-[auto_1fr]">
        <span className="pt-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint">Status</span>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Status">
          {STATES.map((s) => (
            <button key={s.id} aria-pressed={t.state === s.id} className={chip(t.state === s.id)}
              onClick={then(() => { if (s.id !== t.state) void ui.act.state(t, s.id) })}>{s.label}</button>
          ))}
        </div>
        <span className="pt-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint">Priority</span>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Priority">
          {PRIORITIES.map((p) => (
            <button key={p.label} aria-pressed={t.priority === p.id} className={chip(t.priority === p.id)}
              onClick={then(() => { if (p.id !== t.priority) void ui.act.priority(t, p.id) })}>{p.id ? p.label : 'None'}</button>
          ))}
        </div>
      </div>
      <div className="grid gap-2">
        <ActionGroup title="Break it down" acts={[
          { icon: IconSubtask, label: 'Subtask', hint: 'Add a smaller piece of this task', onClick: then(req.onAddSub) },
          { icon: IconSteps, label: 'Sequence', hint: 'Ordered steps — each waits for the one before', onClick: then(req.onAddSeq) },
          canReorder && { icon: IconArrowUp, label: 'Move up', hint: 'Earlier among its siblings', disabled: up === null, onClick: then(() => void ui.act.reorder(t, up!)) },
          canReorder && { icon: IconArrowDown, label: 'Move down', hint: 'Later among its siblings', disabled: down === null, onClick: then(() => void ui.act.reorder(t, down!)) },
          ...(!t.sequence_id && t.parent_id && parentSeqs ? parentSeqs.map((s) => ({
            icon: IconSteps, label: `Into “${s.title || 'Sequence'}”`, hint: 'Make this a step of that sequence',
            onClick: then(() => void ui.act.moveUnder(t, t.parent_id, s.id)),
          })) : []),
          !!t.sequence_id && !!t.parent_id && { icon: IconUnnest, label: 'Out of sequence', hint: 'Keep it as a loose subtask, no order', onClick: then(() => void ui.act.moveUnder(t, t.parent_id, null)) },
        ]} />
        <ActionGroup title="Connect & move" acts={[
          { icon: IconHourglass, label: 'Waits for…', hint: 'Pick a task that must finish first — this stays Blocked until then', onClick: then(() => ui.pick({
            title: `“${t.title}” waits for…`, exclude: new Set([t.id]),
            onPick: (p) => void ui.act.link(p.id, t.id, 'blocks'),
          })) },
          { icon: IconLink, label: 'Related…', hint: 'Link a task for reference — doesn’t change either status', onClick: then(() => ui.pick({
            title: `Relate “${t.title}” to…`, exclude: new Set([t.id]),
            onPick: (p) => void ui.act.link(t.id, p.id, 'related'),
          })) },
          { icon: IconMoveUnder, label: 'Move under…', hint: `Make this a subtask of another task${noteHint}`, onClick: then(() => ui.pick({
            title: `Move “${t.title}” under…${noteHint}`, exclude: new Set([t.id, ...below]),
            onPick: (p) => void ui.act.moveUnder(t, p.id, null, `Moved under ${p.title}`),
          })) },
          { icon: IconPullIn, label: 'Add existing…', hint: 'Pull another task in as a subtask of this one', onClick: then(() => ui.pick({
            title: `Add under “${t.title}”`, exclude: new Set([t.id, ...below]),
            onPick: (c) => void ui.act.moveUnder(c, t.id, null, `${c.title} is now a subtask`),
          })) },
          !!t.parent_id && { icon: IconUnnest, label: 'Make main task', hint: 'Detach it from its parent', onClick: then(() => void ui.act.moveUnder(t, null, null, 'Now a main task')) },
          !t.parent_id && { icon: IconBoard, label: 'Canvases…', hint: 'Choose which boards show this task', onClick: then(() => ui.openCanvases(t)) },
        ]} />
        <div className="grid gap-2 sm:grid-cols-3">
          <ActionGroup title="Later" cols={1} acts={[t.snoozed
            ? { icon: IconSnooze, label: 'Wake up', hint: 'Show it again now', onClick: then(() => void ui.act.snooze(t, null)) }
            : { icon: IconSnooze, label: 'Snooze…', hint: 'Hide it until a later day', onClick: then(() => ui.openSnooze(t)) }]} />
          <ActionGroup title="Share" cols={1} acts={[
            { icon: IconCopy, label: 'Copy link', hint: `Paste [[${t.code}]] into a note`, onClick: then(() => void ui.act.copyLink(t)) },
          ]} />
          <ActionGroup title="View" cols={1} acts={[
            { icon: IconTree, label: 'Whole task', hint: 'See the full tree it belongs to', onClick: then(() => ui.openTree(t.root_id, t.id)) },
            !!t.note_public_id && { icon: IconNotes, label: 'Open note', hint: 'Go to the note it lives in', onClick: then(() => navigate(`/n/${t.note_public_id}`)) },
          ]} />
        </div>
      </div>
    </Dialog>
  )
}

// ---------------------------------------------------------------- picker --

function PickerDialog({ req, onClose }: { req: PickReq | null; onClose: () => void }) {
  const [q, setQ] = useState('')
  const dq = useDebounced(q.trim(), 200)
  useEffect(() => { if (!req) setQ('') }, [req])
  const res = useQuery({ queryKey: ['tasks', 'pick', dq], queryFn: () => pickableTasks(dq), enabled: !!req })
  const rows = (res.data ?? []).filter((t) => !req?.exclude.has(t.id) && (!req?.rootsOnly || !t.parent_id))
  return (
    <Dialog open={!!req} onClose={onClose} title={req?.title ?? 'Pick a task'}>
      <h2 className="mb-3 line-clamp-2 text-base font-semibold">{req?.title}</h2>
      <label className="mb-3 flex items-center gap-2 rounded-xl border border-line px-3 py-2">
        <IconSearch size={16} className="shrink-0 text-faint" />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tasks" aria-label="Search tasks" className="min-w-0 flex-1 bg-transparent text-sm outline-none" />
      </label>
      <ul className="-mx-2 max-h-[50vh] overflow-y-auto">
        {rows.map((t) => (
          <li key={t.id}>
            <button className="w-full rounded-lg px-2 py-2 text-left hover:bg-hover" onClick={() => { onClose(); req?.onPick(t) }}>
              <div className="text-sm">{t.title}</div>
              {(t.parent_title || t.note_title) && <div className="text-xs text-faint">{t.parent_title ? `↳ ${t.parent_title}` : t.note_title}</div>}
            </button>
          </li>
        ))}
        {res.isSuccess && !rows.length && <li className="px-2 py-3 text-sm text-faint">No tasks.</li>}
      </ul>
    </Dialog>
  )
}

// -------------------------------------------------------------- canvases --

function CanvasDialog({ task, onClose }: { task: TaskItem | null; onClose: () => void }) {
  const ui = useTaskUi()
  const [name, setName] = useState('')
  const data = useQuery({ queryKey: ['canvases'], queryFn: listCanvases, staleTime: 30_000 })
  const on = new Set((data.data?.membership ?? []).filter((m) => m.task_id === task?.id).map((m) => m.canvas_id))
  const add = async () => {
    const n = name.trim()
    if (!n || !task) return
    const c = await ui.act.createCanvas(n)
    if (c) { setName(''); void ui.act.canvas(task.id, c.id, true) }
  }
  return (
    <Dialog open={!!task} onClose={onClose} title="Canvases">
      <h2 className="mb-1 text-base font-semibold">Canvases</h2>
      <p className="mb-3 line-clamp-1 text-sm text-faint">{task?.title}</p>
      <ul className="-mx-2 mb-3 max-h-[40vh] overflow-y-auto">
        {(data.data?.canvases ?? []).map((c) => (
          <li key={c.id}>
            <label className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 hover:bg-hover">
              <input type="checkbox" checked={on.has(c.id)} onChange={(e) => task && void ui.act.canvas(task.id, c.id, e.target.checked)} className="size-4 accent-[var(--accent)]" />
              <span className="text-sm">{c.name}</span>
            </label>
          </li>
        ))}
        {data.isSuccess && !data.data.canvases.length && <li className="px-2 py-1 text-sm text-faint">None yet — it stays in Inbox.</li>}
      </ul>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void add() }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New canvas" aria-label="New canvas" maxLength={80}
          className="min-w-0 flex-1 rounded-xl border border-line bg-bg px-3 py-2 text-sm outline-none focus:border-accent" />
        <button disabled={!name.trim()} className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-on-accent disabled:opacity-50">Add</button>
      </form>
    </Dialog>
  )
}

// ------------------------------------------------------------ whole tree --

function TreeDialog({ req, onClose }: { req: { rootId: string; highlightId?: string } | null; onClose: () => void }) {
  const tree = useTaskTree(req?.rootId, !!req)
  const root = tree.data?.tasks.find((t) => t.id === req?.rootId)
  return (
    <Dialog open={!!req} onClose={onClose} title={root?.title ?? 'Task'} wide>
      <div className="-mx-3 max-h-[75vh] overflow-y-auto">
        {root ? (
          <>
            <HighlightContext.Provider value={req?.highlightId ?? null}>
              <ul><TaskNode t={root} tree={tree.data} /></ul>
            </HighlightContext.Provider>
            <div className="px-3"><TaskMentions taskId={req?.highlightId ?? root.id} /></div>
          </>
        ) : tree.isSuccess ? <p className="px-3 text-sm text-faint">This task is gone.</p> : <div className="skeleton mx-3 h-10" />}
      </div>
    </Dialog>
  )
}

// ------------------------------------------------------------ snooze ------

function SnoozeDialog({ task, onClose }: { task: TaskItem | null; onClose: () => void }) {
  const ui = useTaskUi()
  const { timezone: tz } = useSettings()
  const [pick, setPick] = useState(false)
  const today = todayKey(tz)
  const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7 // Monday = 0
  const options: [string, string][] = [
    ['Tomorrow', addDays(today, 1)],
    ['This weekend', addDays(today, dow >= 5 ? 7 - dow + 5 : 5 - dow)],
    ['Next week', addDays(today, 7 - dow)],
  ]
  const go = (d: string | null) => { if (task && d) void ui.act.snooze(task, d); onClose() }
  return (
    <>
      <Dialog open={!!task && !pick} onClose={onClose} title="Snooze">
        <h2 className="mb-1 text-base font-semibold">Snooze</h2>
        <p className="mb-4 line-clamp-1 text-sm text-faint">{task?.title} — out of your lists until then.</p>
        <div className="grid gap-1">
          {options.map(([label, d]) => (
            <button key={label} className="flex justify-between rounded-xl px-3 py-2.5 text-left text-sm hover:bg-hover" onClick={() => go(d)}>
              <span>{label}</span><span className="text-faint">{formatDueDate(d, tz)}</span>
            </button>
          ))}
          <button className="rounded-xl px-3 py-2.5 text-left text-sm hover:bg-hover" onClick={() => setPick(true)}>Pick a day…</button>
        </div>
      </Dialog>
      <DueDialog open={!!task && pick} dateOnly title="Snooze until" date={addDays(today, 1)} time={null} tz={tz}
        onClose={() => { setPick(false); onClose() }} onOk={(d) => { setPick(false); go(d) }} />
    </>
  )
}

// ------------------------------------------------------------ mentions -----

/** Notes that link to the task with [[T-…]]. */
export function TaskMentions({ taskId }: { taskId: string }) {
  const q = useQuery({ queryKey: ['tasks', 'mentions', taskId], queryFn: () => taskMentions(taskId) })
  if (!q.data?.length) return null
  return (
    <div className="mt-2 border-t border-line pt-2 text-xs">
      <span className="text-faint">Mentioned in </span>
      {q.data.map((n, i) => (
        <span key={n.id}>{i > 0 && <span className="text-faint"> · </span>}
          <Link to={`/n/${n.public_id}`} className="text-accent no-underline hover:underline">{n.title || n.public_id}</Link>
        </span>
      ))}
    </div>
  )
}
