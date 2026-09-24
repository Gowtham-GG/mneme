// Reminders, both opt-in per user — by email (settings.reminders_enabled) and/or
// as a notification on every device that allowed them (mneme.push_subscriptions):
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
//   MNEME_VAPID_PUBLIC_KEY / MNEME_VAPID_PRIVATE_KEY / MNEME_VAPID_SUBJECT
//                                    device notifications (scripts/vapid-keys.mjs
//                                    makes the pair; the subject is mailto:you@…).
//                                    Without them notifications are skipped.
//   MNEME_APP_URL                    optional, e.g. https://mneme.example.com — the
//                                    link in the weekly backup email
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically by
// the Edge Functions runtime.
//
// Also sends the weekly backup (settings.backup_enabled): the whole account
// except the password vault, zipped and attached — see backups_due() in
// 20260927100000_mneme_26_dates_snooze_push_backup.sql.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { strToU8, zipSync } from 'npm:fflate@0.8.2'

// ---- webpush: inlined copy of ../_shared/webpush.ts (a function deploys as one file; src/lib/webpush.test.ts keeps the copies identical) ----
// Web Push with nothing but WebCrypto + fetch (runs in Supabase Edge Functions
// and in Node 18+): VAPID (RFC 8292) + aes128gcm payload encryption (RFC 8291).

export interface PushTarget { endpoint: string; p256dh: string; auth: string }
export interface VapidKeys { publicKey: string; privateKey: string; subject: string }

const enc = new TextEncoder()
/** bytes backed by a plain ArrayBuffer (what WebCrypto and fetch accept) */
type Bytes = Uint8Array<ArrayBuffer>

export function b64url(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function unb64url(s: string): Bytes {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4))
  const out = new Uint8Array(b.length)
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i)
  return out
}

const concat = (...parts: Uint8Array[]): Bytes => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

async function hmac(key: Bytes, data: Bytes): Promise<Bytes> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data))
}

/** HKDF (RFC 5869) with a single expand block (≤ 32 bytes out). */
async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, len: number): Promise<Bytes> {
  const prk = await hmac(salt, ikm)
  return (await hmac(prk, concat(info, new Uint8Array([1])))).slice(0, len)
}

/** The VAPID "Authorization" header value for this endpoint (ES256 JWT, 12 h). */
export async function vapidAuth(endpoint: string, keys: VapidKeys): Promise<string> {
  const pub = unb64url(keys.publicKey)
  const jwk = { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: b64url(pub.slice(1, 33)), y: b64url(pub.slice(33, 65)), ext: true }
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  const head = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const body = b64url(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: keys.subject })))
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${body}`)))
  return `vapid t=${head}.${body}.${b64url(sig)}, k=${keys.publicKey}`
}

/** Encrypt `payload` for one subscription (RFC 8291, a single aes128gcm record). */
export async function encryptPayload(target: PushTarget, payload: Uint8Array): Promise<Bytes> {
  const uaPublic = unb64url(target.p256dh)
  const authSecret = unb64url(target.auth)
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey))
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, eph.privateKey, 256))

  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32)
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12)
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt'])
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(payload, new Uint8Array([2]))))

  const rs = new Uint8Array(4)
  new DataView(rs.buffer).setUint32(0, 4096)
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher)
}

export interface PushMessage { title: string; body: string; url?: string; tag?: string }

/**
 * Send one notification. Resolves to the push service's status:
 * 201/200 delivered · 404/410 the subscription is gone (drop it) · others = try again later.
 */
export async function sendPush(target: PushTarget, msg: PushMessage, keys: VapidKeys, fetcher: typeof fetch = fetch): Promise<number> {
  const body = await encryptPayload(target, enc.encode(JSON.stringify(msg)))
  const res = await fetcher(target.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidAuth(target.endpoint, keys),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400',
      Urgency: 'high',
      ...(msg.tag ? { Topic: msg.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) } : {}),
    },
    body,
  })
  await res.body?.cancel()
  return res.status
}
// ---- end webpush ----


const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const REMINDER_FUNCTION_SECRET = Deno.env.get('MNEME_REMINDER_FUNCTION_SECRET')!
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!
const RESEND_FROM = Deno.env.get('MNEME_RESEND_FROM') ?? 'Mneme <onboarding@resend.dev>'
// overridable only so the function can be exercised against a local fake
const RESEND_URL = Deno.env.get('MNEME_RESEND_URL') ?? 'https://api.resend.com/emails'
const APP_URL = Deno.env.get('MNEME_APP_URL') ?? ''
const VAPID: VapidKeys | null = Deno.env.get('MNEME_VAPID_PRIVATE_KEY') && Deno.env.get('MNEME_VAPID_PUBLIC_KEY')
  ? { publicKey: Deno.env.get('MNEME_VAPID_PUBLIC_KEY')!, privateKey: Deno.env.get('MNEME_VAPID_PRIVATE_KEY')!, subject: Deno.env.get('MNEME_VAPID_SUBJECT') ?? 'mailto:mneme@example.com' }
  : null

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
  code: string
  send_email: boolean
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
  send_email: boolean
}

interface Digest {
  userId: string
  email: string
  sendEmail: boolean
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

async function sendEmail(to: string, subject: string, text: string, attachments?: { filename: string; content: string }[]): Promise<void> {
  const res = await fetch(RESEND_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: RESEND_FROM, to: [to], subject, text, ...(attachments ? { attachments } : {}) }),
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

// ---- device notifications ---------------------------------------------------

type Devices = Map<string, PushTarget[]>

async function devicesOf(userIds: string[]): Promise<Devices> {
  const out: Devices = new Map()
  if (!VAPID || userIds.length === 0) return out
  const { data, error } = await supabase.rpc('push_targets', { p_user_ids: [...new Set(userIds)] })
  if (error) throw new Error(`push_targets failed: ${error.message}`)
  for (const d of (data ?? []) as (PushTarget & { user_id: string })[]) out.set(d.user_id, [...(out.get(d.user_id) ?? []), d])
  return out
}

/** Push to every device of a user; true when at least one got it. Gone devices are dropped. */
async function notify(devices: Devices, userId: string, msg: PushMessage, errors: string[]): Promise<boolean> {
  let ok = false
  for (const d of devices.get(userId) ?? []) {
    try {
      const status = await sendPush(d, msg, VAPID!)
      if (status === 404 || status === 410) await supabase.rpc('push_result', { p_endpoint: d.endpoint, p_ok: false })
      else if (status >= 200 && status < 300) { ok = true; await supabase.rpc('push_result', { p_endpoint: d.endpoint, p_ok: true }) }
      else errors.push(`push ${status} from ${new URL(d.endpoint).host}`)
    } catch (err) {
      errors.push(`push failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return ok
}

const hhmm = (t: string | null) => (t ? t.slice(0, 5) : '')

function dueSoonPush(tasks: DueTask[]): PushMessage {
  if (tasks.length === 1) {
    const t = tasks[0]
    return { title: `Due ${hhmm(t.due_time)}: ${t.title}`, body: t.note_public_id ? `From ${t.note_public_id}` : 'Tap to open', url: `/tasks?task=${t.code}`, tag: `task-${t.code}` }
  }
  return { title: `${tasks.length} tasks due soon`, body: tasks.map((t) => `${hhmm(t.due_time)} ${t.title}`).join('\n'), url: '/tasks', tag: 'due-soon' }
}

function digestPush(d: Digest): PushMessage {
  const pending = d.overdue.length + d.today.length
  const title = pending
    ? `${pending} task${pending === 1 ? '' : 's'} today${d.overdue.length ? ` (${d.overdue.length} overdue)` : ''}`
    : `${d.upcoming.length} coming up this week`
  const body = [...d.overdue, ...d.today, ...(pending ? [] : d.upcoming)].slice(0, 4).map((t) => t.title).join(' · ')
  return { title, body, url: '/tasks', tag: `digest-${d.localDate}` }
}

// ---- weekly backup -------------------------------------------------------------

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

const safeName = (s: string) => s.replace(/[^\p{L}\p{N} ._-]+/gu, '').trim().slice(0, 60) || 'note'

/** mneme-backup.json (restorable in Settings → Backup) + every note as readable Markdown. */
function backupZip(backup: Record<string, unknown>): Uint8Array {
  const files: Record<string, Uint8Array> = { 'mneme-backup.json': strToU8(JSON.stringify(backup)) }
  for (const n of (backup.notes ?? []) as { public_id: string; title: string | null; content: string; deleted_at: string | null }[]) {
    const dir = n.deleted_at ? 'notes/trash' : 'notes'
    files[`${dir}/${n.public_id} ${safeName(n.title ?? '')}.md`] = strToU8(`${n.title ? `# ${n.title}\n\n` : ''}${n.content}\n`)
  }
  files['README.txt'] = strToU8('Mneme backup\n\nmneme-backup.json  everything except your passwords — restore it in Mneme: Settings → Backup → Restore from a file\nnotes/             each note as Markdown, to read anywhere\n')
  return zipSync(files, { level: 6 })
}

async function sendBackups(errors: string[]): Promise<number> {
  const { data, error } = await supabase.rpc('backups_due')
  if (error) { errors.push(`backups_due failed: ${error.message}`); return 0 }
  let sent = 0
  for (const u of (data ?? []) as { user_id: string; email: string; local_date: string }[]) {
    try {
      const b = await supabase.rpc('backup_data', { p_user: u.user_id })
      if (b.error) throw new Error(b.error.message)
      const backup = b.data as Record<string, unknown>
      const zip = backupZip(backup)
      const notes = ((backup.notes ?? []) as unknown[]).length, tasks = ((backup.tasks ?? []) as unknown[]).length
      await sendEmail(u.email, `Mneme backup — ${u.local_date}`,
        `Your weekly Mneme backup is attached: ${notes} notes and ${tasks} tasks (your passwords are never included).\n\n` +
        `To restore it — here or in another account — open Mneme → Settings → Backup → Restore from a file.${APP_URL ? `\n${APP_URL}/settings#backup` : ''}\n\n— Mneme`,
        [{ filename: `mneme-backup-${u.local_date}.zip`, content: toBase64(zip) }])
      const m = await supabase.rpc('mark_backup_sent', { p_user_ids: [u.user_id] })
      if (m.error) errors.push(`mark_backup_sent failed: ${m.error.message}`)
      sent++
    } catch (err) {
      errors.push(`backup for ${u.email}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return sent
}

function groupDigests(rows: DigestRow[]): Digest[] {
  const byUser = new Map<string, Digest>()
  for (const r of rows) {
    let d = byUser.get(r.user_id)
    if (!d) {
      d = { userId: r.user_id, email: r.email, sendEmail: r.send_email, localDate: r.local_date, overdue: [], today: [], upcoming: [] }
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
  const due = (dueRes.data ?? []) as DueTask[]
  let devices: Devices = new Map()
  try { devices = await devicesOf([...digests.map((d) => d.userId), ...due.map((t) => t.user_id)]) } catch (err) { errors.push(String(err)) }
  const digestDone: string[] = []
  const digestedTaskIds = new Set<string>()
  let digestsSent = 0
  let pushesSent = 0
  for (const d of digests) {
    const all = [...d.overdue, ...d.today, ...d.upcoming]
    if (all.length === 0) {
      digestDone.push(d.userId)
      continue
    }
    let reached = false
    if (d.sendEmail && d.email) {
      try { await sendDigestEmail(d); reached = true; digestsSent++ } catch (err) { errors.push(err instanceof Error ? err.message : String(err)) }
    }
    if (await notify(devices, d.userId, digestPush(d), errors)) { reached = true; pushesSent++ }
    // nowhere to send it (no email opt-in, no working device): done for today anyway
    if (reached || (!d.sendEmail && !devices.get(d.userId)?.length)) {
      digestDone.push(d.userId)
      if (reached) for (const t of all) digestedTaskIds.add(t.task_id!)
    }
  }
  if (digestDone.length > 0) {
    const { error } = await supabase.rpc('mark_digest_sent', { p_user_ids: digestDone })
    if (error) errors.push(`mark_digest_sent failed: ${error.message}`)
  }

  // ---- one-off "due soon" reminders for timed tasks -------------------------
  // A task already listed in a digest sent this run counts as reminded.
  const sentIds = due.filter((t) => digestedTaskIds.has(t.task_id)).map((t) => t.task_id)
  const byUser = new Map<string, DueTask[]>()
  for (const t of due) {
    if (digestedTaskIds.has(t.task_id)) continue
    if (!byUser.has(t.user_id)) byUser.set(t.user_id, [])
    byUser.get(t.user_id)!.push(t)
  }
  let dueSoonSent = 0
  for (const [userId, tasks] of byUser) {
    let reached = false
    const email = tasks[0].email
    if (tasks[0].send_email && email) {
      try { await sendDueSoonEmail(email, tasks); reached = true; dueSoonSent++ } catch (err) { errors.push(err instanceof Error ? err.message : String(err)) }
    }
    if (await notify(devices, userId, dueSoonPush(tasks), errors)) { reached = true; pushesSent++ }
    if (reached) sentIds.push(...tasks.map((t) => t.task_id))
  }
  // Only mark the ones that actually went out -- a partial Resend failure
  // leaves the rest eligible again on the next run.
  if (sentIds.length > 0) {
    const { error } = await supabase.rpc('mark_reminder_sent', { p_task_ids: sentIds })
    if (error) errors.push(`mark_reminder_sent failed: ${error.message}`)
  }

  const backupsSent = await sendBackups(errors)
  const summary = `${digestsSent} digest(s), ${dueSoonSent} due-soon email(s), ${pushesSent} notification(s), ${backupsSent} backup(s)`
  if (errors.length > 0) {
    return new Response(`Sent ${summary}; errors: ${errors.join('; ')}`, { status: 207 })
  }
  return new Response(`ok: sent ${summary}`, { status: 200 })
})
