import { IconX } from './icons'

export interface BulkAction {
  label: string
  onClick: () => void
  danger?: boolean
}

/** Floating action bar shown while ≥1 row is selected (Notes/Archive/Trash/Search results). */
export function BulkBar({ count, onClear, actions }: { count: number; onClear: () => void; actions: BulkAction[] }) {
  if (count === 0) return null
  return (
    <div className="glass-strong pop sticky bottom-2 z-20 mx-2 my-2 flex flex-wrap items-center gap-2 rounded-2xl px-3 py-2 shadow-xl">
      <button aria-label="Clear selection" className="rounded-full p-1 hover:bg-hover" onClick={onClear}><IconX size={16} /></button>
      <span className="text-sm font-medium">{count} selected</span>
      <div className="ml-auto flex flex-wrap gap-1">
        {actions.map((a) => (
          <button key={a.label} className={`rounded-full px-3 py-1.5 text-sm ${a.danger ? 'text-danger hover:bg-danger-soft' : 'hover:bg-hover'}`} onClick={a.onClick}>
            {a.label}
          </button>
        ))}
      </div>
    </div>
  )
}
