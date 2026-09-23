import { Outlet, useLocation } from 'react-router-dom'
import { NotesList, type ListMode } from '@/components/NotesList'
import { useIsDesktop } from '@/hooks/useMedia'

const modeOf = (path: string): ListMode => (path.startsWith('/starred') ? 'starred' : path.startsWith('/archive') ? 'archive' : path.startsWith('/trash') ? 'trash' : 'active')

/** Desktop: list pane + note pane side by side. Mobile: one at a time (list, or the full-screen note). */
export function ListDetailLayout() {
  const { pathname } = useLocation()
  const desktop = useIsDesktop()
  const inNote = pathname.startsWith('/n/')
  const selected = inNote ? decodeURIComponent(pathname.slice(3)).toUpperCase() : undefined

  if (!desktop) return inNote ? <div className="h-full"><Outlet /></div> : <NotesList mode={modeOf(pathname)} />

  return (
    // padding (not margin) for the gap under the top bar: the card is h-full inside an overflow-hidden <main>
    <div className="h-full pt-5">
      <div className="glass flex h-full overflow-hidden rounded-2xl">
        <div className="w-[22rem] shrink-0 border-r border-line xl:w-[26rem]"><NotesList mode={modeOf(pathname)} selected={selected} /></div>
        <div className="min-w-0 flex-1">
          {inNote ? <Outlet /> : (
            <div className="flex h-full flex-col items-center justify-center gap-1 text-center text-sm text-faint">
              <p>Pick a note, or press <kbd className="rounded border border-line bg-panel px-1.5 font-mono text-xs">C</kbd> to capture.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
