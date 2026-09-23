// Two kinds of reminder email, both opt-in per user (settings.reminders_enabled):
//   * Daily digest -- once a day at reminder_morning_time (user's timezone):
//     every unfinished task that is overdue or due today, repeated every day
//     until it is done, plus upcoming tasks for the next UPCOMING_DAYS days
//     (see supabase/migrations/20260923100000_mneme_16_daily_digest.sql).
//   * "Due soon" -- a one-off email reminder_lead_minutes before a task that
//     has a due_time (20260922100500_mneme_14_reminders.sql).
// Invoked by pg_cron every 10 minutes (20260922100600_mneme_15_reminders_cron.sql)
// with a shared-secret bearer token, the same pattern Argus's own
// export-financial-data function uses.
//
// Uses the service-role key, but never queries mneme.tasks/settings/notes
// directly -- the reminder RPCs (tasks_due_for_reminder, mark_reminder_sent,
// digests_due, mark_digest_sent) are granted ONLY to service_role (not even
// authenticated), since they read auth.users.email for arbitrary users. This
// function is the only caller they were written for.
//
// Required secrets (supabase secrets set ...):
//   MNEME_REMINDER_FUNCTION_SECRET   shared secret; caller must send it as
//                                    `Authorization: Bearer <secret>`
//   RESEND_API_KEY                   almost certainly already set for Argus's
//                                    functions -- Supabase secrets are shared
//                                    project-wide across every Edge Function,
//                                    so this one does not need its own
//   MNEME_RESEND_FROM                optional; default below keeps Mneme's
//                                    emails branded separately from Argus's
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically by
// the Edge Functions runtime.

import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const REMINDER_FUNCTION_SECRET = Deno.env.get('MNEME_REMINDER_FUNCTION_SECRET')!
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!
const RESEND_FROM = Deno.env.get('MNEME_RESEND_FROM') ?? 'Mneme <onboarding@resend.dev>'

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { db: { schema: 'mneme' } })

const UPCOMING_DAYS = 7

interface DueTask {
  task_id: string
  user_id: string
  email: string
  title: string
  note_public_id: string | null
  due_date: string
  due_time: string | null
}

interface DigestRow {
  user_id: string
  email: string
  local_date: string
  task_id: string | null
  title: string | null
  note_public_id: string | null
  due_date: string | null
  due_time: string | null
  priority: string | null
  bucket: 'overdue' | 'today' | 'upcoming' | null
}

interface Digest {
  userId: string
  email: string
  localDate: string
  overdue: DigestRow[]
  today: DigestRow[]
  upcoming: DigestRow[]
}

function formatDue(t: { due_date: string | null; due_time: string | null }): string {
  return t.due_time ? `${t.due_date} at ${t.due_time.slice(0, 5)}` : `${t.due_date}`
}

function taskLine(t: DueTask | DigestRow, withDate = true): string {
  const ref = t.note_public_id ? ` (${t.note_public_id})` : ''
  const prio = 'priority' in t && t.priority === 'high' ? ' [high]' : ''
  const when = withDate ? ` — due ${formatDue(t)}` : t.due_time ? ` — ${t.due_time.slice(0, 5)}` : ''
  return `- ${t.title}${prio}${when}${ref}`
}

async function sendEmail(to: string, subject: string, text: string): Promise<void> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: RESEND_FROM, to: [to], subject, text }),
  })
  if (!res.ok) throw new Error(`Resend API responded with ${res.status}: ${await res.text()}`)
}

function sendDueSoonEmail(to: string, tasks: DueTask[]): Promise<void> {
  const subject =
    tasks.length === 1 ? `Mneme — "${tasks[0].title}" is due soon` : `Mneme — ${tasks.length} tasks due soon`
  const body = `You have ${tasks.length} task${tasks.length === 1 ? '' : 's'} due:\n\n${tasks.map((t) => taskLine(t)).join('\n')}\n\n— Mneme`
  return sendEmail(to, subject, body)
}

function sendDigestEmail(d: Digest): Promise<void> {
  const pending = d.overdue.length + d.today.length
  const subject =
    pending > 0
      ? `Mneme — ${pending} unfinished task${pending === 1 ? '' : 's'}${d.overdue.length ? ` (${d.overdue.length} overdue)` : ''}`
      : `Mneme — ${d.upcoming.length} upcoming task${d.upcoming.length === 1 ? '' : 's'}`
  const sections: string[] = []
  if (d.overdue.length) sections.push(`Overdue:\n${d.overdue.map((t) => taskLine(t)).join('\n')}`)
  if (d.today.length) sections.push(`Due today:\n${d.today.map((t) => taskLine(t, false)).join('\n')}`)
  if (d.upcoming.length) sections.push(`Coming up (next ${UPCOMING_DAYS} days):\n${d.upcoming.map((t) => taskLine(t)).join('\n')}`)
  const body =
    `Your Mneme tasks for ${d.localDate}\n\n${sections.join('\n\n')}\n\n` +
    `Unfinished tasks show up here every day until you mark them done.\n\n— Mneme`
  return sendEmail(d.email, subject, body)
}

function groupDigests(rows: DigestRow[]): Digest[] {
  const byUser = new Map<string, Digest>()
  for (const r of rows) {
    let d = byUser.get(r.user_id)
    if (!d) {
      d = { userId: r.user_id, email: r.email, localDate: r.local_date, overdue: [], today: [], upcoming: [] }
      byUser.set(r.user_id, d)
    }
    if (r.task_id && r.bucket) d[r.bucket].push(r)
  }
  return [...byUser.values()]
}

Deno.serve(async (req) => {
  const authHeader = req.headers.get('Authorization') ?? ''
  if (authHeader !== `Bearer ${REMINDER_FUNCTION_SECRET}`) {
    return new Response('Unauthorized', { status: 401 })
  }

  const [digestRes, dueRes] = await Promise.all([
    supabase.rpc('digests_due', { p_upcoming_days: UPCOMING_DAYS }),
    supabase.rpc('tasks_due_for_reminder'),
  ])
  if (digestRes.error) return new Response(`Digest query failed: ${digestRes.error.message}`, { status: 500 })
  if (dueRes.error) return new Response(`Query failed: ${dueRes.error.message}`, { status: 500 })

  const errors: string[] = []

  // ---- daily digests --------------------------------------------------------
  // A due user with nothing to report is still marked, so they aren't
  // re-checked (or emailed about a task added later) until tomorrow's slot.
  const digests = groupDigests((digestRes.data ?? []) as DigestRow[])
  const digestDone: string[] = []
  const digestedTaskIds = new Set<string>()
  let digestsSent = 0
  for (const d of digests) {
    const all = [...d.overdue, ...d.today, ...d.upcoming]
    if (all.length === 0 || !d.email) {
      digestDone.push(d.userId)
      continue
    }
    try {
      await sendDigestEmail(d)
      digestDone.push(d.userId)
      digestsSent++
      for (const t of all) digestedTaskIds.add(t.task_id!)
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err))
    }
  }
  if (digestDone.length > 0) {
    const { error } = await supabase.rpc('mark_digest_sent', { p_user_ids: digestDone })
    if (error) errors.push(`mark_digest_sent failed: ${error.message}`)
  }

  // ---- one-off "due soon" reminders for timed tasks -------------------------
  // A task already listed in a digest sent this run counts as reminded.
  const due = (dueRes.data ?? []) as DueTask[]
  const sentIds = due.filter((t) => digestedTaskIds.has(t.task_id)).map((t) => t.task_id)
  const byEmail = new Map<string, DueTask[]>()
  for (const t of due) {
    if (!t.email || digestedTaskIds.has(t.task_id)) continue
    if (!byEmail.has(t.email)) byEmail.set(t.email, [])
    byEmail.get(t.email)!.push(t)
  }
  let dueSoonSent = 0
  for (const [email, tasks] of byEmail) {
    try {
      await sendDueSoonEmail(email, tasks)
      sentIds.push(...tasks.map((t) => t.task_id))
      dueSoonSent++
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err))
    }
  }
  // Only mark the ones that actually went out -- a partial Resend failure
  // leaves the rest eligible again on the next run.
  if (sentIds.length > 0) {
    const { error } = await supabase.rpc('mark_reminder_sent', { p_task_ids: sentIds })
    if (error) errors.push(`mark_reminder_sent failed: ${error.message}`)
  }

  const summary = `${digestsSent} digest(s), ${dueSoonSent} due-soon email(s)`
  if (errors.length > 0) {
    return new Response(`Sent ${summary}; errors: ${errors.join('; ')}`, { status: 207 })
  }
  return new Response(`ok: sent ${summary}`, { status: 200 })
})
