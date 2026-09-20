import { Link } from 'react-router-dom'

/** The wordmark: "Mneme" followed by an accent-coloured full stop (same idea as "Argus."). */
export function Brand({ to = '/', className = '' }: { to?: string; className?: string }) {
  return (
    <Link to={to} aria-label="Mneme — home" className={`text-[21px] font-bold tracking-tight text-ink no-underline hover:no-underline ${className}`}>
      Mneme<span className="text-accent">.</span>
    </Link>
  )
}
