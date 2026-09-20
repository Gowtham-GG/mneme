import { useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { signOut } from '@/api/auth'
import { inboxCount } from '@/api/notes'
import { useHotkeys } from '@/hooks/useHotkeys'
import { useOnline } from '@/hooks/useOnline'
import { Brand } from './Brand'
import { CommandPalette } from './CommandPalette'
import { Dialog } from './Dialog'
import { IconArchive, IconInbox, IconMore, IconNotes, IconPlus, IconSearch, IconSettings, IconStar, IconTag, IconTasks, IconToday, IconTrash } from './icons'
import { SyncManager } from './SyncManager'

function SignOutIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M15 4h3.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H15M10 8l-4 4 4 4M6 12h9" />
    </svg>
  )
}

/** One round icon in the floating dock. The active one glows. */
function DockLink({ to, label, icon, end, badge, hideOnSmall }: { to: string; label: string; icon: React.ReactNode; end?: boolean; badge?: number; hideOnSmall?: boolean }) {
  return (
    <NavLink
      to={to} end={end} aria-label={label} title={label}
      className={({ isActive }) =>
        `relative flex size-11 items-center justify-center rounded-full no-underline hover:no-underline ${hideOnSmall ? 'hidden sm:flex' : ''} ${
          isActive ? 'bg-accent-soft text-accent shadow-[0_0_24px_-2px_var(--accent-glow),inset_0_1px_0_var(--glass-hi)]' : 'text-muted hover:bg-hover hover:text-ink'}`}
    >
      {icon}
      {!!badge && <span className="absolute right-1 top-1 min-w-4 rounded-full bg-accent px-1 text-center text-[10px] font-semibold leading-4 text-on-accent">{badge > 99 ? '99+' : badge}</span>}
    </NavLink>
  )
}

export function Shell() {
  const nav = useNavigate()
  const loc = useLocation()
  const online = useOnline()
  const [palette, setPalette] = useState(false)
  const [help, setHelp] = useState(false)
  const [more, setMore] = useState(false)
  const inbox = useQuery({ queryKey: ['inbox-count'], queryFn: inboxCount, staleTime: 30_000 })
  const inEditor = loc.pathname.startsWith('/n/')
  // On phones the editor is full-screen (its own header, no dock); on desktop chrome stays.
  const chrome = inEditor ? 'hidden lg:flex' : 'flex'

  useHotkeys([
    { combo: 'mod+n', handler: (e) => { e.preventDefault(); nav('/n/new') }, inInputs: true },
    { combo: 'c', handler: (e) => { e.preventDefault(); nav('/n/new') } },
    { combo: 'mod+k', handler: (e) => { e.preventDefault(); setPalette((v) => !v) }, inInputs: true },
    { combo: 'mod+p', handler: (e) => { e.preventDefault(); setPalette(true) }, inInputs: true },
    { combo: '/', handler: (e) => { e.preventDefault(); nav('/search') } },
    { combo: '?', handler: (e) => { e.preventDefault(); setHelp(true) } },
  ])

  const moreItems: [string, string, React.ReactNode, boolean][] = [
    ['/search', 'Search', <IconSearch key="s" size={18} />, true],
    ['/inbox', inbox.data ? `Inbox · ${inbox.data}` : 'Inbox', <IconInbox key="i" size={18} />, true],
    ['/tags', 'Index', <IconTag key="t" size={18} />, false],
    ['/starred', 'Starred', <IconStar key="st" size={18} />, false],
    ['/archive', 'Archive', <IconArchive key="a" size={18} />, false],
    ['/trash', 'Trash', <IconTrash key="tr" size={18} />, false],
    ['/settings', 'Settings & themes', <IconSettings key="se" size={18} />, false],
  ]

  return (
    <div className="flex h-full flex-col">
      <a href="#main" className="skip-link">Skip to content</a>

      {/* top bar: wordmark left, actions right */}
      <header className={`${chrome} pt-[env(safe-area-inset-top)] shrink-0 items-center justify-between gap-3 border-b border-line bg-[var(--sticky)] px-4 backdrop-blur-md lg:px-8`}>
        <div className="flex h-14 flex-1 items-center justify-between">
          <Brand />
          <div className="flex items-center gap-2">
            <button onClick={() => setPalette(true)} className="hidden items-center gap-2.5 rounded-lg border border-line px-3.5 py-2 text-sm text-faint hover:bg-hover hover:text-ink md:flex" aria-label="Open command palette (Ctrl+K)">
              <IconSearch size={16} /> Search or jump to… <kbd className="rounded-md bg-hover px-1.5 py-0.5 text-[10px] font-medium tracking-wide">Ctrl K</kbd>
            </button>
            <button onClick={() => void signOut()} className="flex items-center gap-2 rounded-lg border border-line px-3.5 py-2 text-sm font-medium text-ink hover:bg-hover" aria-label="Sign out">
              <SignOutIcon /> <span className="hidden sm:inline">Sign Out</span>
            </button>
          </div>
        </div>
      </header>

      <main id="main" className={`min-h-0 min-w-0 flex-1 overflow-hidden ${inEditor ? 'lg:px-6 lg:pb-[5.5rem]' : 'lg:pb-[5.5rem]'}`}>
        {!online && (
          <div role="status" className="bg-important-soft px-4 py-1.5 text-center text-xs font-medium text-important">
            You’re offline — notes are saved on this device and will sync when you’re back.
          </div>
        )}
        <div className="h-full min-h-0"><Outlet /></div>
      </main>

      {/* floating dock — icons only, like Argus */}
      <nav aria-label="Primary" className={`${chrome} pointer-events-none fixed inset-x-0 bottom-[max(1rem,env(safe-area-inset-bottom))] z-30 justify-center`}>
        <div className="glass-strong pointer-events-auto relative flex items-center gap-1 rounded-full p-1.5">
          <DockLink to="/" end label="Today" icon={<IconToday />} />
          <DockLink to="/notes" label="Notes" icon={<IconNotes />} />
          <DockLink to="/inbox" label="Inbox" icon={<IconInbox />} badge={inbox.data || undefined} hideOnSmall />
          <button aria-label="Capture a new note (C)" title="Capture (C)" className="bg-accent mx-1 flex size-12 items-center justify-center rounded-full text-on-accent active:scale-95" onClick={() => nav('/n/new')}>
            <IconPlus size={24} />
          </button>
          <DockLink to="/tasks" label="Tasks" icon={<IconTasks />} />
          <DockLink to="/search" label="Search" icon={<IconSearch />} hideOnSmall />
          <button aria-label="More" aria-haspopup="menu" aria-expanded={more} title="More" onClick={() => setMore((v) => !v)}
            className={`flex size-11 items-center justify-center rounded-full ${more ? 'bg-hover text-ink' : 'text-muted hover:bg-hover hover:text-ink'}`}><IconMore /></button>

          {more && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setMore(false)} />
              <div role="menu" className="glass-strong pop absolute bottom-[calc(100%+0.75rem)] right-0 z-50 w-60 rounded-2xl p-1.5" onClick={() => setMore(false)}>
                {moreItems.map(([to, label, icon, smallOnly]) => (
                  <NavLink key={to} to={to} role="menuitem" className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-ink no-underline hover:bg-hover hover:no-underline ${smallOnly ? 'sm:hidden' : ''}`}>
                    <span className="text-muted">{icon}</span>{label}
                  </NavLink>
                ))}
                <button role="menuitem" className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm text-ink hover:bg-hover" onClick={() => setHelp(true)}>
                  <span className="w-[18px] text-center text-muted">?</span>Keyboard shortcuts
                </button>
              </div>
            </>
          )}
        </div>
      </nav>

      <Dialog open={help} onClose={() => setHelp(false)} title="Keyboard shortcuts">
        <h2 className="mb-4 text-lg font-semibold">Keyboard shortcuts</h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2.5 text-sm">
          {[['Ctrl/Cmd + N  ·  C', 'New note'], ['Ctrl/Cmd + K', 'Command palette'], ['Ctrl/Cmd + P', 'Jump to a note'], ['/', 'Search'], ['Ctrl/Cmd + Enter', 'Save & close (in the editor)'],
            ['E', 'Edit the open note'], ['Esc', 'Close / stop editing'], ['?', 'This help']].map(([k, d]) => (
            <div key={k} className="contents"><dt><kbd className="rounded-md border border-line bg-panel px-1.5 py-0.5 font-mono text-xs">{k}</kbd></dt><dd className="text-muted">{d}</dd></div>
          ))}
        </dl>
      </Dialog>

      <CommandPalette open={palette} onClose={() => setPalette(false)} />
      <SyncManager />
    </div>
  )
}
