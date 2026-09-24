import { NavLink } from 'react-router-dom'

/** List ⇄ Board switch in the Tasks header (the board is reached here, not from the dock). */
export function ViewToggle() {
  const cls = ({ isActive }: { isActive: boolean }) =>
    `rounded-full px-3 py-1 text-sm no-underline hover:no-underline ${isActive ? 'bg-accent font-medium text-on-accent' : 'text-muted hover:text-ink'}`
  return (
    <nav aria-label="Tasks view" className="glass flex shrink-0 gap-0.5 rounded-full p-0.5">
      <NavLink to="/tasks" end className={cls}>List</NavLink>
      <NavLink to="/tasks/board" className={cls}>Board</NavLink>
    </nav>
  )
}
