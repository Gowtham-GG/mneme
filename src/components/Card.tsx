import type { ReactNode } from 'react'

/** A translucent content card with an optional small-caps heading — the app's basic building block. */
export function Card({ title, aside, children, className = '', pad = true }: { title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string; pad?: boolean }) {
  return (
    <section className={`glass rounded-2xl ${pad ? 'p-5' : ''} ${className}`}>
      {(title || aside) && (
        <div className={`mb-3 flex items-baseline justify-between gap-3 ${pad ? '' : 'px-5 pt-5'}`}>
          {title && <h2 className="label-caps">{title}</h2>}
          {aside && <div className="text-xs text-muted">{aside}</div>}
        </div>
      )}
      {children}
    </section>
  )
}
