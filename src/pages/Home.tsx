import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { inboxCount, listNotes, recentViewed } from '@/api/notes'
import { listTasks, setTaskDone } from '@/api/tasks'
import { Card } from '@/components/Card'
import { IconSearch } from '@/components/icons'
import { NoteRow } from '@/components/NoteRow'
import { QuickCapture } from '@/components/QuickCapture'
import { useSettings } from '@/contexts/SettingsContext'
import { useToast } from '@/contexts/ToastContext'
import { formatFullDate, presetRange, todayKey } from '@/lib/dates'
import { displayTitle } from '@/lib/text'

export function Home() {
  const { timezone: tz } = useSettings()
  const { toast } = useToast()
  const qc = useQueryClient()
  const day = todayKey(tz)
  const range = presetRange('today', tz)

  const today = useQuery({ queryKey: ['notes', 'home-today', day, tz], queryFn: () => listNotes({ from: range.from, to: range.to, state: 'all', limit: 50 }) })
  const tasks = useQuery({ queryKey: ['tasks', 'home'], queryFn: () => listTasks('today', 5) })
  const starred = useQuery({ queryKey: ['notes', 'home-starred'], queryFn: () => listNotes({ starred: true, state: 'all', order: 'updated', limit: 6 }) })
  const recent = useQuery({ queryKey: ['recent-viewed'], queryFn: () => recentViewed(6) })
  const inbox = useQuery({ queryKey: ['inbox-count'], queryFn: inboxCount, staleTime: 30_000 })

  // a page in a notebook reads top → bottom, oldest first
  const stream = [...(today.data ?? [])].reverse()

  const tick = async (id: string, title: string) => {
    try {
      await setTaskDone(id, true)
      void qc.invalidateQueries({ queryKey: ['tasks'] }); void qc.invalidateQueries({ queryKey: ['notes'] })
      toast(`Done: ${title}`, { action: { label: 'Undo', onClick: () => void setTaskDone(id, false).then(() => { void qc.invalidateQueries({ queryKey: ['tasks'] }); void qc.invalidateQueries({ queryKey: ['notes'] }) }) } })
    } catch { toast('Couldn’t update the task.', { kind: 'error' }) }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="page-top mx-auto max-w-5xl px-4 pb-32 lg:px-6 lg:pb-8">
        <Link to="/search" className="glass mb-5 flex items-center gap-2.5 rounded-xl px-4 py-3 text-sm text-faint no-underline hover:no-underline md:hidden"><IconSearch size={17} /> Search your notes</Link>

        <header className="rise mb-5">
          <p className="label-caps">{formatFullDate(day)}</p>
          <h1 className="mt-1 text-[34px] font-bold leading-tight">Today</h1>
        </header>

        <QuickCapture />
        <p className="mb-6 mt-3 text-center text-xs text-faint">Just write. <code>#tag</code> · <code>[[link]]</code> · <code>- [ ] task</code></p>

        <div className="grid gap-4 lg:grid-cols-3">
          <Card title="Written today" aside={stream.length ? `${stream.length} note${stream.length === 1 ? '' : 's'}` : undefined} className="rise min-w-0 lg:col-span-2" pad={false}>
            <div className="px-2 pb-3">
              {today.isLoading && <div className="space-y-2 p-3"><div className="skeleton h-14" /><div className="skeleton h-14 opacity-60" /></div>}
              {!today.isLoading && stream.length === 0 && <p className="px-3 py-4 text-sm text-faint">Nothing written today yet.</p>}
              {stream.map((n) => <NoteRow key={n.id} note={n} tz={tz} />)}
            </div>
          </Card>

          <div className="min-w-0 space-y-4">
            {!!tasks.data?.length && (
              <Card title="Tasks due" aside={<Link to="/tasks">All →</Link>} className="rise">
                <ul className="-mx-2">
                  {tasks.data.map((t) => (
                    <li key={t.id} className="flex items-start gap-3 rounded-lg px-2 py-2 hover:bg-hover">
                      <input type="checkbox" aria-label={`Complete: ${t.title}`} className="mt-1 size-4 accent-[var(--accent)]" onChange={() => void tick(t.id, t.title)} />
                      <span className="min-w-0 flex-1 text-sm">{t.title}{t.note_public_id && <Link to={`/n/${t.note_public_id}`} className="ml-2 text-xs tabular-nums text-faint">{t.note_public_id}</Link>}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
            {!!starred.data?.length && (
              <Card title="Starred" className="rise">
                <div className="flex flex-wrap gap-2">
                  {starred.data.map((n) => <Link key={n.id} to={`/n/${n.public_id}`} className="max-w-full truncate rounded-full border border-line px-3.5 py-1.5 text-sm text-ink no-underline hover:bg-hover hover:no-underline">★ {displayTitle(n)}</Link>)}
                </div>
              </Card>
            )}
            {!!recent.data?.length && (
              <Card title="Recently opened" className="rise">
                <div className="flex flex-wrap gap-2">
                  {recent.data.map((n) => <Link key={n.id} to={`/n/${n.public_id}`} className="max-w-full truncate rounded-full bg-panel px-3.5 py-1.5 text-sm text-ink no-underline hover:bg-hover hover:no-underline">{displayTitle(n)}</Link>)}
                </div>
              </Card>
            )}
            {!!inbox.data && <Link to="/inbox" className="glass block rounded-2xl px-5 py-4 text-sm text-muted no-underline hover:no-underline hover:text-ink"><span className="label-caps block">Inbox</span><span className="mt-1 block text-base font-medium text-ink">{inbox.data} to process →</span></Link>}
          </div>
        </div>
      </div>
    </div>
  )
}
