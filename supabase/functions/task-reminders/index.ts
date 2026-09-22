// Sends a reminder email for tasks whose due moment has arrived: a task with
// a due_time fires reminder_lead_minutes before it; a date-only task fires at
// the fixed reminder_morning_time on its due date (both per-user settings,
// see supabase/migrations/20260922100500_mneme_14_reminders.sql). Invoked by
// pg_cron every 10 minutes (20260922100600_mneme_15_reminders_cron.sql) with
// a shared-secret bearer token, the same pattern Argus's own
// export-financial-data function uses.
//
// Uses the service-role key, but never queries mneme.tasks/settings/notes
// directly -- mneme.tasks_due_for_reminder() and mneme.mark_reminder_sent()
// are granted ONLY to service_role (not even authenticated), since the first
// one reads auth.users.email for arbitrary users. This function is the only
// caller either was written for.
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

interface DueTask {
  task_id: string
  user_id: string
  email: string
  title: string
  note_public_id: string | null
  due_date: string
  due_time: string | null
}

function formatDue(t: DueTask): string {
  return t.due_time ? `${t.due_date} at ${t.due_time.slice(0, 5)}` : t.due_date
}

function buildEmailBody(tasks: DueTask[]): string {
  const lines = tasks.map((t) => {
    const ref = t.note_public_id ? ` (${t.note_public_id})` : ''
    return `- ${t.title} — due ${formatDue(t)}${ref}`
  })
  return `You have ${tasks.length} task${tasks.length === 1 ? '' : 's'} due:\n\n${lines.join('\n')}\n\n— Mneme`
}

async function sendReminderEmail(to: string, tasks: DueTask[]): Promise<void> {
  const subject =
    tasks.length === 1 ? `Mneme — "${tasks[0].title}" is due soon` : `Mneme — ${tasks.length} tasks due soon`
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: RESEND_FROM, to: [to], subject, text: buildEmailBody(tasks) }),
  })
  if (!res.ok) throw new Error(`Resend API responded with ${res.status}: ${await res.text()}`)
}

Deno.serve(async (req) => {
  const authHeader = req.headers.get('Authorization') ?? ''
  if (authHeader !== `Bearer ${REMINDER_FUNCTION_SECRET}`) {
    return new Response('Unauthorized', { status: 401 })
  }

  const { data, error } = await supabase.rpc('tasks_due_for_reminder')
  if (error) {
    return new Response(`Query failed: ${error.message}`, { status: 500 })
  }
  const due = (data ?? []) as DueTask[]
  if (due.length === 0) {
    return new Response('ok: nothing due', { status: 200 })
  }

  // One email per user, even if several of their tasks are due at once.
  const byEmail = new Map<string, DueTask[]>()
  for (const t of due) {
    if (!t.email) continue
    if (!byEmail.has(t.email)) byEmail.set(t.email, [])
    byEmail.get(t.email)!.push(t)
  }

  const sentIds: string[] = []
  const errors: string[] = []
  for (const [email, tasks] of byEmail) {
    try {
      await sendReminderEmail(email, tasks)
      sentIds.push(...tasks.map((t) => t.task_id))
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err))
    }
  }

  // Only mark the ones that actually went out -- a partial Resend failure
  // leaves the rest eligible again on the next run.
  if (sentIds.length > 0) {
    const { error: markErr } = await supabase.rpc('mark_reminder_sent', { p_task_ids: sentIds })
    if (markErr) errors.push(`mark_reminder_sent failed: ${markErr.message}`)
  }

  if (errors.length > 0) {
    return new Response(`Sent ${sentIds.length}/${due.length}; errors: ${errors.join('; ')}`, { status: 207 })
  }
  return new Response(`ok: sent ${sentIds.length} reminder(s)`, { status: 200 })
})
