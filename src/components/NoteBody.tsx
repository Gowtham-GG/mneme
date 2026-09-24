import { Fragment, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { parseBlocks, type Block, type Inline } from '@/lib/markdown'
import { IconCheck, IconX } from './icons'

interface Props {
  content: string
  /** Toggle a checkbox on the given 1-based source line. */
  onToggleTask?: (line: number, done: boolean) => void
  /** Resolve a [[Title]] link (by title) to a route target, if known. */
  resolveTitle?: (title: string) => string | undefined
}

const SYMBOL_STYLE: Record<string, string> = {
  '?': 'text-question', '!': 'text-important', '★': 'text-important', '×': 'text-faint line-through', '→': 'text-accent', '↗': 'text-accent',
}

function Inlines({ nodes, resolveTitle }: { nodes: Inline[]; resolveTitle?: Props['resolveTitle'] }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.t) {
          case 'text': return <Fragment key={i}>{n.v}</Fragment>
          case 'bold': return <strong key={i}><Inlines nodes={n.c} resolveTitle={resolveTitle} /></strong>
          case 'italic': return <em key={i}><Inlines nodes={n.c} resolveTitle={resolveTitle} /></em>
          case 'code': return <code key={i} className="rounded bg-panel px-1 py-0.5 font-mono text-[0.85em]">{n.v}</code>
          case 'url': return <a key={i} href={n.href} target="_blank" rel="noopener noreferrer nofollow" className="break-all">{n.v}</a>
          case 'tag': return <Link key={i} to={`/tags/${n.name}`} className="rounded bg-accent-soft px-1 text-[0.9em] text-accent no-underline">#{n.name}</Link>
          case 'id': return <Link key={i} to={`/n/${n.id}`} className="font-sans text-[0.85em] tabular-nums">{n.id}</Link>
          case 'noteLink': {
            const to = n.isTask ? `/tasks?task=${n.ref}` : n.isId ? `/n/${n.ref}` : resolveTitle?.(n.ref) ?? `/search?q=${encodeURIComponent(n.ref)}`
            return <Link key={i} to={to} className="rounded bg-accent-soft px-1 text-accent no-underline">↗ {n.label}</Link>
          }
        }
      })}
    </>
  )
}

function BlockView({ b, onToggleTask, resolveTitle }: { b: Block } & Pick<Props, 'onToggleTask' | 'resolveTitle'>) {
  switch (b.t) {
    case 'blank': return <div className="h-3" aria-hidden />
    case 'hr': return <hr className="my-3 border-line" />
    case 'heading': {
      const cls = b.level === 1 ? 'text-2xl font-semibold mt-2' : b.level === 2 ? 'text-xl font-semibold mt-1' : 'text-lg font-semibold'
      return <div role="heading" aria-level={b.level} className={cls}><Inlines nodes={b.c} resolveTitle={resolveTitle} /></div>
    }
    case 'quote': return <div className="border-l-2 border-line pl-3 text-muted"><Inlines nodes={b.c} resolveTitle={resolveTitle} /></div>
    case 'code': return <pre className="my-2 overflow-x-auto rounded-lg bg-panel p-3 font-mono text-[0.85em] leading-snug">{b.v}</pre>
    case 'symbol':
      return (
        <div className="flex gap-2">
          <span className={`w-4 shrink-0 text-center font-sans font-semibold ${SYMBOL_STYLE[b.sym]}`} aria-label={`symbol ${b.sym}`}>{b.sym}</span>
          <span className={b.sym === '×' ? 'text-faint line-through' : ''}><Inlines nodes={b.c} resolveTitle={resolveTitle} /></span>
        </div>
      )
    case 'item': {
      const pad = { paddingLeft: `${b.indent * 1.25}rem` }
      if (b.task) {
        const { done, state } = b.task
        const label = state === 'open' ? 'Mark task as done' : done ? 'Mark task as not done' : `${state === 'in_progress' ? 'In progress' : 'On hold'} — mark as done`
        return (
          <div className="flex items-start gap-2" style={pad}>
            <button
              type="button"
              role="checkbox"
              aria-checked={done}
              aria-label={label}
              disabled={!onToggleTask}
              onClick={() => onToggleTask?.(b.line, !done)}
              className={`mt-[0.28em] inline-flex size-[1.05em] shrink-0 items-center justify-center rounded-[4px] border ${
                state === 'done' ? 'border-task bg-task text-bg' : state === 'cancelled' ? 'border-faint text-faint'
                : state === 'in_progress' ? 'border-accent' : state === 'on_hold' ? 'border-important' : 'border-faint text-transparent hover:border-task'}`}
            >
              {state === 'done' && <IconCheck size={12} strokeWidth={3} />}
              {state === 'cancelled' && <IconX size={11} strokeWidth={2.5} />}
              {state === 'in_progress' && <span className="size-1.5 rounded-full bg-accent" />}
              {state === 'on_hold' && <span className="h-[0.5em] w-[0.35em] border-x-2 border-important" />}
            </button>
            <span className={done ? 'text-faint line-through' : state === 'on_hold' ? 'text-muted' : ''}><Inlines nodes={b.c} resolveTitle={resolveTitle} /></span>
          </div>
        )
      }
      return (
        <div className="flex gap-2" style={pad}>
          <span className="w-4 shrink-0 text-right text-faint" aria-hidden>{b.ordered ? b.marker : '•'}</span>
          <span><Inlines nodes={b.c} resolveTitle={resolveTitle} /></span>
        </div>
      )
    }
    case 'line': return <div><Inlines nodes={b.c} resolveTitle={resolveTitle} /></div>
  }
}

export function NoteBody({ content, onToggleTask, resolveTitle }: Props) {
  const blocks = useMemo(() => parseBlocks(content), [content])
  if (!content.trim()) return <p className="text-faint">Nothing written yet.</p>
  return (
    <div className="note-body break-words">
      {blocks.map((b, i) => <BlockView key={i} b={b} onToggleTask={onToggleTask} resolveTitle={resolveTitle} />)}
    </div>
  )
}
