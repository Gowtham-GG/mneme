import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { signOut } from '@/api/auth'
import { exportJson, exportMarkdownZip, exportTasksCsv } from '@/api/export'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/hooks/useAuth'
import { useSettings } from '@/contexts/SettingsContext'
import { useToast } from '@/contexts/ToastContext'
import { browserTimezone, isValidTimezone } from '@/lib/dates'
import { THEMES, type ThemePref } from '@/lib/themes'

const zones = (): string[] => {
  try { return (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf('timeZone') } catch { return ['UTC'] }
}

function Card({ title, children, id }: { title: string; children: React.ReactNode; id?: string }) {
  return <section id={id} className="glass mb-4 rounded-2xl p-5"><h2 className="mb-3 text-sm font-semibold">{title}</h2>{children}</section>
}

export function Settings() {
  const { user } = useAuth()
  const { theme, timezone, remindersEnabled, reminderLeadMinutes, reminderMorningTime, update } = useSettings()
  const { toast } = useToast()
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState('')
  const stats = useQuery({
    queryKey: ['stats'], staleTime: 60_000,
    queryFn: async () => {
      const [n, t] = await Promise.all([
        supabase.from('notes').select('id', { count: 'exact', head: true }).is('deleted_at', null),
        supabase.from('tasks').select('id', { count: 'exact', head: true }).eq('status', 'open').is('removed_at', null),
      ])
      return { notes: n.count ?? 0, openTasks: t.count ?? 0 }
    },
  })
  useEffect(() => { if (location.hash === '#export') document.getElementById('export')?.scrollIntoView() }, [])

  const run = async (name: string, fn: (p: (m: string) => void) => Promise<number>, unit: string) => {
    setBusy(name); setMsg('')
    try { const n = await fn(setMsg); toast(`Exported ${n} ${unit}`) } catch { toast('Export failed. Check your connection and try again.', { kind: 'error' }) } finally { setBusy(null); setMsg('') }
  }
  const setTheme = (t: ThemePref) => void update({ theme: t }).catch(() => toast('Couldn’t save the theme.', { kind: 'error' }))

  return (
    <div className="h-full overflow-y-auto">
      <div className="page-top mx-auto max-w-3xl px-4 pb-32 lg:px-6 lg:pb-8">
        <h1 className="mb-5 text-[28px] font-semibold leading-tight">Settings</h1>

        <Card title="Appearance" id="appearance">
          <p className="mb-4 text-sm text-muted">Pick a colour theme. It follows you across devices.</p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Theme">
            <button role="radio" aria-checked={theme === 'system'} onClick={() => setTheme('system')}
              className={`group rounded-2xl border p-3 text-left ${theme === 'system' ? 'border-accent bg-accent-soft' : 'border-line hover:bg-hover'}`}>
              <span className="mb-2.5 flex h-14 overflow-hidden rounded-xl border border-line">
                <span className="flex-1" style={{ background: 'linear-gradient(135deg,#e3e8fb,#f5f7fd)' }} />
                <span className="flex-1" style={{ background: 'linear-gradient(135deg,#2a1745,#120c1e)' }} />
              </span>
              <span className="block text-sm font-semibold">Match my device</span>
              <span className="block text-xs text-muted">Light by day, dark by night</span>
            </button>
            {THEMES.map((t) => (
              <button key={t.id} role="radio" aria-checked={theme === t.id} onClick={() => setTheme(t.id)}
                className={`group rounded-2xl border p-3 text-left ${theme === t.id ? 'border-accent bg-accent-soft' : 'border-line hover:bg-hover'}`}>
                <span className="mb-2.5 flex h-14 items-end justify-end overflow-hidden rounded-xl border border-line p-2" style={{ background: `radial-gradient(90px 60px at 15% 0%, ${t.swatch[1]}55, transparent 70%), ${t.swatch[0]}` }}>
                  <span className="size-5 rounded-full shadow-lg" style={{ background: t.swatch[1], boxShadow: `0 4px 14px ${t.swatch[1]}88` }} />
                </span>
                <span className="block text-sm font-semibold">{t.label}</span>
                <span className="block text-xs text-muted">{t.blurb}</span>
              </button>
            ))}
          </div>
        </Card>

        <Card title="Timezone">
          <p className="mb-2 text-sm text-muted">Decides what “today” means and the date inside new note IDs (N-<b>YYMMDD</b>-NNN).</p>
          <div className="flex flex-wrap items-center gap-2">
            <select value={timezone} onChange={(e) => void update({ timezone: e.target.value }).catch(() => toast('Couldn’t save the timezone.', { kind: 'error' }))} aria-label="Timezone" className="max-w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm">
              {!zones().includes(timezone) && <option value={timezone}>{timezone}</option>}
              {zones().map((z) => <option key={z} value={z}>{z}</option>)}
            </select>
            {browserTimezone() !== timezone && isValidTimezone(browserTimezone()) && <button className="text-sm" onClick={() => void update({ timezone: browserTimezone() })}>Use {browserTimezone()}</button>}
          </div>
        </Card>

        <Card title="Reminders">
          <p className="mb-3 text-sm text-muted">
            Get an email at your login address when a task is due. A task with a specific time is emailed a bit
            beforehand; a task with only a date is emailed at a fixed time that morning. Off by default.
          </p>
          <label className="mb-3 flex items-center gap-2.5 text-sm">
            <input
              type="checkbox" checked={remindersEnabled}
              onChange={(e) => void update({ reminders_enabled: e.target.checked }).catch(() => toast('Couldn’t save that.', { kind: 'error' }))}
              className="size-4 accent-[var(--accent)]"
            />
            Email me task reminders
          </label>
          {remindersEnabled && (
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3 text-sm">
              <label className="flex items-center gap-2">
                Lead time for timed tasks
                <select
                  value={reminderLeadMinutes}
                  onChange={(e) => void update({ reminder_lead_minutes: Number(e.target.value) }).catch(() => toast('Couldn’t save that.', { kind: 'error' }))}
                  className="rounded-lg border border-line bg-bg px-2.5 py-1.5 text-sm"
                >
                  {[15, 30, 60, 120, 1440].map((m) => <option key={m} value={m}>{m < 60 ? `${m} min` : m === 1440 ? '1 day' : `${m / 60} hr`}</option>)}
                </select>
              </label>
              <label className="flex items-center gap-2">
                Morning-of time for date-only tasks
                <input
                  type="time" value={reminderMorningTime.slice(0, 5)}
                  onChange={(e) => void update({ reminder_morning_time: e.target.value }).catch(() => toast('Couldn’t save that.', { kind: 'error' }))}
                  className="rounded-lg border border-line bg-bg px-2.5 py-1.5 text-sm"
                />
              </label>
            </div>
          )}
        </Card>

        <Card title="Export your notes" id="export">
          <p className="mb-3 text-sm text-muted">Your notes are yours. Everything downloads as plain text — Markdown, JSON and CSV — with tags, links and tasks included. Nothing is uploaded anywhere.</p>
          <div className="flex flex-wrap gap-2">
            <button disabled={!!busy} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-on-accent" onClick={() => void run('zip', exportMarkdownZip, 'notes')}>{busy === 'zip' ? 'Working…' : 'Markdown files (.zip)'}</button>
            <button disabled={!!busy} className="rounded-lg border border-line px-4 py-2 text-sm hover:bg-hover" onClick={() => void run('json', exportJson, 'notes')}>{busy === 'json' ? 'Working…' : 'JSON'}</button>
            <button disabled={!!busy} className="rounded-lg border border-line px-4 py-2 text-sm hover:bg-hover" onClick={() => void run('csv', exportTasksCsv, 'tasks')}>{busy === 'csv' ? 'Working…' : 'Tasks (CSV)'}</button>
          </div>
          {msg && <p role="status" className="mt-2 text-sm text-muted">{msg}</p>}
        </Card>

        <Card title="Your library">
          <p className="text-sm text-muted">{stats.data ? `${stats.data.notes.toLocaleString()} notes · ${stats.data.openTasks.toLocaleString()} open tasks` : '…'}</p>
          <p className="mt-2 text-sm"><Link to="/trash">Trash</Link> · <Link to="/archive">Archive</Link></p>
        </Card>

        <Card title="Account">
          <p className="mb-3 text-sm text-muted">Signed in as <b className="text-ink">{user?.email}</b>. This is the same sign-in you use for Argus; your notes are private to you.</p>
          <button className="rounded-lg border border-line px-4 py-2 text-sm hover:bg-hover" onClick={() => void signOut()}>Sign out</button>
        </Card>
      </div>
    </div>
  )
}
