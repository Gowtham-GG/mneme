import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { tagCounts } from '@/api/tags'
import { Card } from '@/components/Card'
import { IconChevron } from '@/components/icons'
import { buildTagTree, type TagNode as Node } from '@/lib/tagTree'

function sortNodes(nodes: Node[], by: 'name' | 'count'): Node[] {
  return [...nodes].sort((a, b) => (by === 'count' ? b.count - a.count || a.seg.localeCompare(b.seg) : a.seg.localeCompare(b.seg)))
}

function TreeNode({ node, by, depth }: { node: Node; by: 'name' | 'count'; depth: number }) {
  const [open, setOpen] = useState(false)
  const kids = sortNodes(node.children, by)
  return (
    <li>
      <div className="flex items-center rounded-lg hover:bg-hover" style={{ paddingLeft: `${depth * 1.25}rem` }}>
        {kids.length
          ? <button aria-label={`${open ? 'Collapse' : 'Expand'} ${node.seg}`} aria-expanded={open} className="rounded p-2 text-faint" onClick={() => setOpen((v) => !v)}><IconChevron size={14} className={`transition-transform ${open ? 'rotate-90' : ''}`} /></button>
          : <span className="w-[30px]" />}
        <Link to={`/tags/${node.path}`} className="flex min-w-0 flex-1 items-center justify-between gap-3 py-2 pr-3 text-ink no-underline">
          <span className="truncate">{node.seg}</span>
          <span className="shrink-0 text-xs tabular-nums text-faint">{node.count} note{node.count === 1 ? '' : 's'}</span>
        </Link>
      </div>
      {open && !!kids.length && <ul>{kids.map((k) => <TreeNode key={k.path} node={k} by={by} depth={depth + 1} />)}</ul>}
    </li>
  )
}

export function TagIndex() {
  const q = useQuery({ queryKey: ['tag-counts'], queryFn: tagCounts })
  const [by, setBy] = useState<'name' | 'count'>('name')
  const tree = useMemo(() => sortNodes(buildTagTree(q.data ?? []), by), [q.data, by])
  return (
    <div className="h-full overflow-y-auto">
      <div className="page-top mx-auto max-w-3xl px-4 pb-32 lg:px-6 lg:pb-8">
        <div className="mb-1 flex items-end justify-between">
          <h1 className="text-[28px] font-semibold leading-tight">Index</h1>
          <div className="flex gap-1 text-xs" role="group" aria-label="Sort">
            {(['name', 'count'] as const).map((s) => <button key={s} aria-pressed={by === s} className={`rounded-full px-3 py-1 ${by === s ? 'bg-accent text-on-accent' : 'border border-line text-muted'}`} onClick={() => setBy(s)}>{s === 'name' ? 'A–Z' : 'Most used'}</button>)}
          </div>
        </div>
        <p className="mb-5 text-sm text-muted">Built from your tags — nothing to maintain. Use <code className="rounded bg-panel px-1">#jvm/memory</code> to nest.</p>
        {q.isLoading && <p className="text-sm text-faint">Loading…</p>}
        {q.isError && <p className="text-sm text-danger">Couldn’t load the index.</p>}
        {q.data && !q.data.length && <p className="text-sm text-faint">No tags yet. Type <code className="rounded bg-panel px-1">#something</code> in any note.</p>}
        <Card><ul className="-mx-2">{tree.map((n) => <TreeNode key={n.path} node={n} by={by} depth={0} />)}</ul></Card>
      </div>
    </div>
  )
}
