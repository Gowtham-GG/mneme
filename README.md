# Mneme

A quiet, text-first **external brain**: capture in seconds, organise later (or never), find anything.

```
CAPTURE  →  PROCESS  →  CONNECT  →  RETRIEVE
```

Mneme is a web app (React + Vite, installable as a PWA) on **Supabase** (Auth + Postgres), hosted on **Vercel**.
It shares one Supabase project — and the same login — with [Argus](../Argus/argus), inside its own isolated
`mneme` Postgres schema. Data is private per user (Row Level Security), so it is multi-user by construction even
though it is designed for personal use.

- **No folders.** One chronological stream. Structure comes from `#tags`, `[[links]]`, search and a dynamic index.
- **Nothing is mandatory.** No title, category, tag, project or template. Open → type → done.
- **Text only.** No uploads, no Storage, no images/PDF/audio. URLs are just text.
- **Almost no backend.** Everything is Postgres + RLS, with exactly one opt-in exception: a single Edge Function on a
  10-minute `pg_cron` tick, only for due-task reminder emails (§15, set up in §5.6) — off by default, nothing else in the app uses it.
- **Your data stays yours.** Export everything as Markdown / JSON / CSV any time.

**Since first launch, also added:** tag rename & merge (Index/tag page), directly editable task due date/time/priority
(Tasks view and a note's Tasks panel), related-note suggestions (tag overlap + title similarity), multi-select bulk
actions on the Notes/Archive/Trash/Search lists (star, tag, archive, trash, restore, delete forever), named/pinned
saved searches, an overdue/due-today count on the Tasks dock icon, optional due-date reminder emails (§15), and a
month calendar on Home (ring = notes written that day, dots = scheduled/tasks/overdue/done; pick a day to see its
notes and agenda, or add a task/appointment to it), and a daily journal (one page per day — ✎ Journal in the
day agenda, or press J; `type:journal` finds them all), and habits (yes/no or daily counts, every day or chosen weekdays; tap chips
under the capture box; heatmap, streaks (can be turned off in Settings) and 30-day rate at /habits). The Tasks page
has tabs with counts, task search, and delete for any task (a task from a note also loses its line in that note).

---

## 1. The note-taking model

| You write | Mneme does |
|---|---|
| anything, no title | Stable ID `N-260920-042`, timestamp. Title = first line if you don't set one |
| `#java`, `#jvm/memory` | Tag (nested with `/`). Feeds the **Index** |
| `[[JVM Memory]]` or `[[N-260920-042\|label]]` or a bare `N-260920-042` | A link; the target shows it under **Referenced by** automatically |
| `- [ ] Read docs` | A **task**, linked to its note. Tick it in the note *or* in the Tasks view — both stay in sync |
| `? why…`  `! important`  `★ key`  `→ leads to`  `× dropped`  `> continues` | Styled lines (never change the note type on their own) |
| `**bold**` `*italic*` `` `code` `` `# Heading` lists, quotes, fenced code | Lightweight rendering. Storage is always plain Markdown text |

Notes start as **capture**. Later you can promote them (knowledge / question / idea / meeting / reference) from the
note, or in bulk-free fashion from **Inbox** (one card at a time, keyboard-driven, always optional).

Physical-notebook hybrid: every note has an optional **paper reference** (e.g. `N1-042`), searchable.

### Look & feel

"Executive glass", modelled on Argus: a wordmark with an accent full stop (**Mneme.**) and *Sign Out* in the top bar,
a floating **icon dock** for navigation (Today · Notes · Inbox · **＋ Capture** · Tasks · Search · More), translucent
cards with small-caps labels, and a login screen with an oversized **M.** letterform behind a see-through form.
Font: DM Sans (self-hosted, so the strict CSP stays intact). Eased motion, honours `prefers-reduced-motion`.

**Themes** (Settings → Appearance, saved to your account so they follow you): *Amethyst* (default, deep violet),
*Sapphire*, *Jade*, *Ember*, *Crimson*, *Graphite* — dark; *Slate*, *Lilac*, *Sand* — light; plus *Match my device*.
A theme is just a few hue knobs in `src/index.css` (`--h`, `--h2`, `--ha`, …) and one entry in `src/lib/themes.ts`;
every colour, glass tint, glow and the login letter derive from them. The database only checks the *shape* of the
theme id (migration 07), so adding a theme never needs a migration. The browser tab icon is `public/icon.svg`
(an "M." tile); PNG variants for installs live next to it.

### Keyboard

`Ctrl/Cmd+N` (or `C`) new note · `Ctrl/Cmd+K` command palette · `Ctrl/Cmd+P` jump to a note ·
`/` search · `Ctrl/Cmd+Enter` save & close · `E` edit · `Esc` back · `?` help.
In the editor: `Enter` continues lists · `Tab`/`Shift+Tab` indent · `[[` / `#` open pickers.

---

## 2. Architecture

```
 Web (React + TS + Vite + Tailwind, PWA)  ─┐
 Android (installable PWA now, Expo later) ─┴─ supabase-js ─▶ Supabase Auth
                                                        └──▶ PostgREST ─▶ Postgres  schema `mneme`  (RLS on every table)
 Vercel = static hosting only

 pg_cron (10 min, opt-in) ─▶ Edge Function `task-reminders` ─▶ Postgres (service_role, 2 functions only) ─▶ Resend
```

* **All logic that must be identical on every client lives in Postgres**: ID assignment, tag/link/task extraction,
  search, task toggling. The web app and a future Android app share one implementation.
* Writes are plain `insert/update` on `mneme.notes`; triggers do the rest. A few RPCs where a query can't express it.
* Reads are paginated (keyset for the timeline). Nothing loads "all notes" into the browser (except an explicit export).

```
src/
  api/          typed data layer (notes, search, tasks, tags, saved searches, revisions, settings, export, auth)
  lib/          pure logic + tests: markdown renderer model, editing helpers, dates/timezones (incl. taskDueStatus),
                drafts (IndexedDB), sync engine, export formatting, tag tree
  hooks/        useNoteEditor (autosave engine), hotkeys, media, online, useSelection (bulk actions)…
  components/   Shell, Editor, NoteBody, NotesList, BulkBar, CommandPalette, ContextPanel, dialogs…
  pages/        Home, Notes (list+detail), Note, Inbox, Tasks, Search, Index, Tag, Settings, Login, Share
supabase/
  migrations/   01–15, versioned, idempotent (15 is the one manual, cron-scheduling exception — see §5.6)
  functions/    task-reminders (the one Edge Function; deployed manually, see §5.6)
  tests/        SQL test-suite (RLS matrix, sync triggers, search, IDs, rename/merge, reminders …) + Supabase shim
tests/
  integration/  real client code ↔ real migrations via PostgREST (local, throwaway DB)
  e2e/          Playwright smoke test (optional tooling)
```

---

## 3. Database

Schema **`mneme`** (nothing is created in `public`). Every table has `user_id uuid default auth.uid()
references auth.users on delete cascade` and RLS `user_id = (select auth.uid())`. Child tables reference parents
through **composite foreign keys `(id, user_id)`**, so a row can never point at another user's row.

| Table | Purpose |
|---|---|
| `notes` | `id` (client-generated UUID → idempotent retries), `public_id` (`N-YYMMDD-NNN`, server-assigned, immutable), nullable `title`, `content` (Markdown text ≤ 100k chars), `note_type`, `is_starred`, `paper_ref`, `version`, `created_at`, `updated_at`, `archived_at`, `deleted_at` |
| `tags`, `note_tags` | many-to-many. `note_tags.source` = `inline` (typed as `#tag`, owned by the sync trigger) or `manual` (added via chip, never touched by the trigger) |
| `note_links` | `source → target`, `relationship_type` (`related` default; `derived_from`, `continuation`, `contradicts`, `supports`, `reference`) |
| `tasks` | mirrors `- [ ]` lines (`source='note'`) or created in the Tasks view (`'standalone'`). `due_date`, `priority`, `position` (line no.), `removed_at` |
| `note_revisions` | previous text, snapshotted at most once / 15 min, newest 10 per note kept |
| `note_views` | "recently opened" |
| `settings` | timezone (decides "today" and the date in IDs), theme |
| `note_counters` | per-day ID sequence. RLS on, **no grants**: only the `SECURITY DEFINER` `next_public_id()` touches it |

**IDs.** `N-260920-042` = local date in the user's timezone + a per-user, per-day counter (widens past 999). Stable
forever: title, tags, type and content edits never change it. A note captured offline keeps its capture-day ID.

**Derived data.** One trigger (`sync_note_derived`) parses the note text on save (skipping fenced/inline code and
`[[link labels]]`): tags → `note_tags`, links → `note_links`, checkbox lines → `tasks`. Edited task text keeps the same
task (due date survives a typo fix); deleted lines hide the task (`removed_at`) instead of deleting it; identical text
revives it.

**Search** (`search_notes`): Postgres full-text (`english`, expression GIN index — no duplicated text) + substring match
on titles/paper refs (trigram index). Operators, all optional and combinable:

```
words            #tag (matches nested #tag/…)   type:question   is:starred|archived|inbox|task|trash
after:2026-09-01   before:2026-10-01   N-260920-042 (or a prefix: N-2609)
```

**RPCs**: `search_notes`, `list_notes`, `recent_viewed`, `inbox_count`, `note_context` (tags + links + backlinks +
tasks in one call), `list_tasks`, `set_task_done` (rewrites the checkbox line), `tag_counts` (with nesting rollup),
`empty_trash`. All `SECURITY INVOKER` → RLS applies.

### Row Level Security & grants

* RLS enabled on every table; one `for all` policy `user_id = (select auth.uid())` (USING + WITH CHECK).
* `revoke all on schema mneme from public, anon`; only `authenticated` gets `usage`, table and function grants.
* Composite FKs block cross-tenant references; length/format `CHECK`s bound abuse (sign-ups are open on the shared project).
* No service-role key anywhere. Never put `SUPABASE_SERVICE_ROLE_KEY` in this app.

### Size (free tier = 500 MB, shared with Argus)

Roughly 3–4× the raw text (rows + FTS index + revisions): ~5 MB per 1 000 notes, ~40 MB per 10 000, ~150–200 MB per
50 000. Argus used 12 MB when Mneme was designed.

---

## 4. Argus coexistence (read before touching the database)

Inspected from Argus's source **and** the live database (2026-09-20):

* Argus keeps everything in `public` (17 tables, RLS on) — including a table called **`tags`**. Mneme therefore
  lives in its own schema `mneme`; it creates **nothing** in `public` and never modifies Argus objects.
* Both apps use the same Supabase Auth users. Mneme adds **no** trigger on `auth.users` (Argus's `handle_new_user`
  keeps working); Mneme creates its own `settings` row lazily.
* Live extensions (as of 2026-09-20): `pgcrypto, uuid-ossp, pg_stat_statements, supabase_vault`. `pg_cron` / `pg_net`
  were **not** installed then (contrary to Argus's SQL files, whose own weekly-export cron job never activated for the
  same reason). Migration 15 (§15) enables both, **project-wide** — shared with Argus, since extensions aren't
  per-schema — to run Mneme's own opt-in reminder job; this does not reactivate Argus's dormant job (its migration
  failed on the same missing-extension line, so nothing Argus-owned was ever scheduled). Mneme also uses `pg_trgm`
  (bundled, free-tier OK).
* Argus applies migrations by pasting SQL into the editor, so its history is not in `supabase_migrations`. Mneme's
  migrations are additive (`if not exists`), each in a transaction.
* **Never run `supabase db reset`, `db pull` or `db diff` against the shared project.** Use `db push` (only Mneme's files)
  or the SQL editor.
* Shared auth settings: Mneme's Vercel URL must be in **Authentication → URL Configuration → Redirect URLs**.
  Mneme's sign-up passes `emailRedirectTo` so confirmation links return to Mneme, not to Argus's Site URL.

---

## 5. Setup

### 5.1 Apply the database migrations (once)

Files in `supabase/migrations/`, in order:

```
20260920100000_mneme_01_schema.sql     schema, grants, helper functions
20260920100100_mneme_02_tables.sql     tables, indexes, RLS
20260920100200_mneme_03_triggers.sql   parsing, IDs, triggers
20260920100300_mneme_04_rpc.sql        view + search/task/tag RPCs
20260920100400_mneme_05_trigram.sql    pg_trgm + substring indexes
20260920100500_mneme_06_lists.sql      list/recent RPCs
20260921100000_mneme_07_themes.sql     settings.theme accepts any theme id (run this to enable the new themes)
20260921110000_mneme_08_vault.sql      Passwords: end-to-end-encrypted vault tables + atomic re-key/reset RPCs
20260922100000_mneme_09_tag_rename.sql   tag rename & merge (rewrites #tag text, RLS-scoped)
20260922100100_mneme_10_task_time.sql    tasks.due_time + due_task_count() for the dock badge
20260922100200_mneme_11_related_notes.sql  related_notes() RPC (tag overlap + title trigram similarity)
20260922100300_mneme_12_saved_searches.sql  saved_searches table (named/pinned searches)
20260922100400_mneme_13_bulk_tags.sql    bulk_add_tag() RPC for the Notes-list multi-select bar
20260922100500_mneme_14_reminders.sql    reminder settings + the two service_role-only reminder RPCs
20260922100600_mneme_15_reminders_cron.sql  cron schedule for reminders — run MANUALLY, see 5.6 below
20260923100000_mneme_16_daily_digest.sql daily reminder digest (overdue/today repeated daily + upcoming 7 days)
20260923100100_mneme_17_calendar.sql     calendar_month() RPC — per-day marks for the Home calendar
20260923100200_mneme_18_journal.sql      daily journal: note_type 'journal' + journal_date, open_journal() RPC
20260924100000_mneme_19_habits.sql       habits + habit_logs (yes/no or counts, weekday schedules), bump_habit/habits_for_day RPCs
20260924100100_mneme_20_habit_marks_task_delete.sql  habit calendar marks, settings.show_streaks, delete_task/clear_completed_tasks
```

**Option A – SQL editor (same workflow as Argus).** Paste each file, in order, into *SQL Editor → New query → Run*.

**Option B – Supabase CLI.**

```bash
supabase link --project-ref <your-project-ref>     # the SAME project as Argus
supabase db push                                    # applies only the files above
```

### 5.2 Expose the schema (once, manual)

Dashboard → **Settings → API → Exposed schemas** → add **`mneme`** (keep `public`, so Argus is untouched) → Save.
Without this every request fails with a *schema not found / not exposed* error.

### 5.3 Auth URLs

Dashboard → **Authentication → URL Configuration → Redirect URLs**: add your Mneme URL(s), e.g.
`https://mneme.vercel.app` and `http://localhost:5173`. Leave Argus's *Site URL* alone.

### 5.4 Environment variables

| Variable | Where | Value |
|---|---|---|
| `VITE_SUPABASE_URL` | `.env.local` + Vercel | `https://<project-ref>.supabase.co` (same as Argus) |
| `VITE_SUPABASE_ANON_KEY` | `.env.local` + Vercel | the public **anon** key (same as Argus) |

```bash
cp .env.example .env.local   # then fill in the two values
```

The **service-role key is never used and must never be added** to the frontend or to Vercel env vars for this app.

### 5.5 Run locally

```bash
npm install
npm run dev          # http://localhost:5173
```

Sign in with your Argus account (or create one — same Auth).

### 5.6 Reminder email setup (optional — skip if you don't want reminder emails)

Off until you do this; the app works fully without it (Settings → Reminders just won't be able to send).

1. Install the Supabase CLI locally if you haven't (`npm i -g supabase`), then `supabase login` and
   `supabase link --project-ref <your-project-ref>` (the same project as Argus).
2. Deploy the function: `supabase functions deploy task-reminders`.
3. Set secrets: `supabase secrets set MNEME_REMINDER_FUNCTION_SECRET=<a random string> MNEME_RESEND_FROM="Mneme <onboarding@resend.dev>"`.
   `RESEND_API_KEY` is almost certainly already set project-wide for Argus's own email functions — Supabase secrets
   are shared by every Edge Function in a project, so you don't need to set it again. If Argus doesn't have one yet,
   create a free [Resend](https://resend.com) account and `supabase secrets set RESEND_API_KEY=...`.
4. Open `supabase/migrations/20260922100600_mneme_15_reminders_cron.sql`, replace `<project-ref>` and
   `<mneme-reminder-function-secret>` with your real values, and run it **once** in the SQL editor (this file is
   intentionally excluded from `db push` / the numbered list above — see its own header comment).
5. In the app, Settings → Reminders → turn it on, set a lead time and a daily email time, and give a task a due date.

**Resend's free sandbox sender caveat**: `onboarding@resend.dev` can only deliver to the email address the Resend
account itself was created with, until you verify your own domain — the exact same limitation Argus's spending-report
emails already have. Until then, reminder emails will only actually arrive at that one address regardless of which
account's task triggered them.

---

## 6. Deploy to Vercel

Mneme is its own Vercel project (same account as Argus; free tier is fine).

1. Push this repo to Git, then in Vercel: **Add New → Project → Import**. Framework preset: **Vite**.
2. Add the two env vars from 5.4 (Production + Preview).
3. Deploy. `vercel.json` already contains the SPA rewrite and hardened headers
   (strict **Content-Security-Policy** — `connect-src` allows only `*.supabase.co`, no inline scripts — plus
   `nosniff`, referrer and permissions policies). If you ever use a custom Supabase domain, add it to `connect-src`.
4. Add the deployed URL to Supabase **Redirect URLs** (5.3).

---

## 7. Reliability, offline & conflicts

* **You always know if a note is safe.** Status pill: `Saving…` → `Saved` · `Offline — saved locally` ·
  `Couldn't save. Retrying…` (with *Retry now*).
* **Autosave** ~800 ms after you stop typing, one request at a time; edits made mid-save are queued.
* **Nothing is lost.** Every keystroke is first mirrored to IndexedDB (`drafts`). If the network is down, the tab
  closes or the browser crashes, the draft survives and a background sync (`SyncManager`: on start, on reconnect, every
  30 s) delivers it. Notes have client-generated UUIDs, so replays can never create duplicates
  (a lost response is recognised via the primary-key conflict and treated as an update).
* **Empty new notes are never stored.** Leaving a blank capture creates nothing.
* **Conflicts are explicit, never silent.** Saves are `update … where version = <base>`. If the note changed
  elsewhere, a dialog offers *Keep mine* / *Use the other device's* — the version you don't pick is saved as a separate
  note. Star/type/archive changes don't bump the text version, so they never cause conflicts.
* **Version history** (⋯ → *Version history…*): browse and restore earlier versions; restoring first snapshots the
  current text, so it is itself undoable.
* Online-first by design: no full offline replica, no sync engine to babysit. Local drafts + retry cover capture.

---

## 8. Backup & export

* In-app: **Settings → Export** → Markdown files (`.zip`, one file per note with YAML front-matter + `notes.json` +
  `tasks.csv`), a single JSON, or tasks CSV. Generated in the browser; nothing is uploaded.
* Full database backup of just Mneme (no Argus data):

  ```bash
  pg_dump "$SUPABASE_DB_URL" --schema=mneme --no-owner --no-privileges > mneme-backup.sql
  ```

  (connection string: Dashboard → Project Settings → Database.)

---

## 9. Testing

```bash
npm test          # unit tests (vitest): renderer, editing helpers, dates/timezones (incl. taskDueStatus), sync engine, export, tag tree
npm run test:sql  # SQL suite — needs a THROWAWAY Postgres with the Supabase shim (see below)
npm run test:int  # integration: real API code + real migrations through PostgREST, in a local throwaway DB
npm run lint && npm run build
```

* **SQL suite** (`supabase/tests/mneme_tests.sql`, ~160 assertions, runs in one rolled-back transaction): ID format /
  timezone / concurrency past 999, tag & link & task extraction and edits, revisions, search operators, list
  pagination, tag rename/merge (incl. atomicity of a refused rename and code-span/`[[link]]` protection), task
  `due_time` survival, saved searches, bulk tag-add, the reminder functions' `service_role`-only gating and timing
  logic, and a full **tenant-isolation matrix** — *user B cannot read, update, delete, link to, tag, or attach
  anything to user A's rows*, `note_counters` unreachable, anon has no access, deleting a user cascades.
  Never run it against the production project (it creates `auth.users` rows). `supabase/tests/supabase_shim.sql`
  provides `auth.uid()`, `anon`/`authenticated`/`service_role`, and `extensions` schema access for a plain local
  Postgres. `related_notes()` (migration 11) needs `pg_trgm`, not installed locally — like trigram search itself,
  it's excluded from the automated local suite and verified manually instead (see the migration's own comment).
* **Integration** (`npm run test:int`): needs `initdb/pg_ctl`, `psql`, `podman` (or set `CONTAINER_CLI=docker`) and
  network access once for the PostgREST image. It never touches your Supabase project. Skips the same
  trigram-dependent migration, plus the manual-only reminders-cron one (see `tests/integration/run.sh`).
* **Browser smoke test** (`tests/e2e/smoke.mjs`): optional Playwright run of the real UI against the local stack —
  capture, `[[` linking, tasks, search, palette, offline → reconnect, dark mode, mobile layout (run with the strict
  CSP enforced).

---

## 10. Android

The backend is already shared: same Auth users, same schema, same RLS, same RPCs. There is **no** Android-specific
database.

1. **Now: install the PWA** (Chrome → *Install app*). Runs fullscreen, works with the Android share sheet:
   *Share → Mneme* creates a capture (`share_target` → `/share`), saved locally first if you are offline.
2. **If the PWA ever feels short: Expo / React Native.** Reuse `src/types/db.ts`, the whole SQL layer and
   `src/api/*` (they only depend on `supabase-js`; swap `localStorage`/IndexedDB for AsyncStorage/SQLite drafts). Point
   the client at the `mneme` schema (`db: { schema: 'mneme' }`). Native Kotlin would re-implement everything the
   database already does once and is not recommended.
3. Never ship the service-role key in a mobile app either.

---

## 11. Free-tier notes

Supabase free: 500 MB DB, projects pause after ~7 days of no activity (Argus + Mneme share one project, so either
keeping it warm helps), 2 active projects max — Mneme deliberately does **not** need a new one. Mneme uses no Storage,
no realtime, no background workers, and issues no polling except a 30-second local-draft check that makes a network
call **only if unsent drafts exist**. The one exception is the optional, off-by-default reminder feature (§15): one
Edge Function, woken every 10 minutes by `pg_cron` — negligible against Supabase's free-tier Edge Function invocation
quota, and it does nothing at all for anyone who hasn't turned Reminders on in Settings.

## 12. Troubleshooting

| Symptom | Fix |
|---|---|
| Every request fails: *schema mneme not found / permission denied for schema* | Add `mneme` to **Exposed schemas** (5.2); re-run the grants in migration 01 if you dropped the schema |
| Sign-up email links open Argus | Sign up through Mneme (it passes `emailRedirectTo`); add Mneme's URL to Redirect URLs (5.3) |
| `Missing Supabase env vars` in the console | `.env.local` (or Vercel env) missing `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`; redeploy after adding |
| Blank page on Vercel after adding a custom Supabase domain | Add the domain to `connect-src` in `vercel.json` (CSP) |
| "Couldn't save. Retrying…" persists | Hover the pill for the error. `check_violation` = text > 100 000 chars; otherwise it is a network/auth issue and the text is safe in local drafts |
| A note shows "Edited on another device" | Expected when two devices edit the same note; pick a side — the other version is kept as a separate note |
| Search misses part of a word in the body | Body search is stemmed full-text (words). Substring matching applies to titles and paper refs only (keeps the index small) |
| `supabase db push` wants to change Argus | Stop. Only Mneme's files are in `supabase/migrations`; never use `db pull/diff/reset` on the shared project |

## 13. Not built (on purpose) / later

Files, images, PDFs, audio, video, AI summaries/auto-tagging, graph visualisation, collaboration/sharing, calendars,
templates, realtime, full offline replica. (Edge Functions/cron are no longer a blanket "not built" — see §15: one
narrow, opt-in exception for reminder emails, nothing else uses them.) Candidates for later: daily/weekly review
digest, an Expo client.

---

## 14. Passwords (encrypted vault)

A separate section (**Passwords**, key icon in the dock) for logins: **website · username/email · password**, with one-click
**copy** on the username and the password, and any number of logins per website (they are grouped under the site).

**Security model — zero-knowledge, end-to-end encrypted**

* You choose a **master passphrase**. It is never stored or sent. From it the browser derives a 256-bit key with
  **PBKDF2-SHA256 (600 000 iterations, random per-user salt)**.
* Each login (website, username, password, notes) is encrypted **in the browser** with **AES-256-GCM** (fresh random IV per
  encryption) *before* it is saved. The database — and your Supabase dashboard — only ever hold opaque `v1.<iv>.<ciphertext>`.
  The test-suite asserts that no site, username, password, note or passphrase ever appears in the stored data.
* Every ciphertext is bound (as GCM "associated data") to its owner and row id, so a malicious database can't swap or
  replay records between rows/users; any tampering is detected on decrypt.
* The key is a **non-extractable** WebCrypto key held **only in memory**. It is discarded on Lock, on the idle timeout
  (default 5 min, configurable), on sign-out and on page reload. Nothing secret is written to localStorage/IndexedDB.
* Copied passwords are wiped from the clipboard after 30 s; passwords are masked and only shown on request (auto-hide 15 s).
* RLS isolates vaults per user like everything else; the vault is capped at 5 000 items to protect the shared free tier.
* Change master passphrase = every item re-encrypted client-side and swapped in **one atomic transaction** (`vault_rekey`);
  if another device changed the vault meanwhile the change is refused and nothing is modified.

**Things to know**

* **If you forget the master passphrase, the passwords cannot be recovered — by anyone.** "Erase the vault" lets you start over.
* Import from Chrome / Edge / Bitwarden / 1Password / LastPass CSV; export a Chrome-compatible CSV (**plain text**, with a warning).
* This protects against database leaks and anyone with backend access. It cannot protect against malware/keyloggers on your
  device or a compromised browser. It uses only standard WebCrypto primitives and has **not** been independently audited —
  for your most critical accounts consider a dedicated, audited manager as well.
* The strength meter is a heuristic estimate, not a guarantee.

---

## 15. Reminders (optional, off by default)

An email at your login address when a task's due date/time arrives. Setup is manual and one-time — §5.6 walks through
it — because it's the one place Mneme steps outside "just Postgres + RLS": a single Edge Function
(`supabase/functions/task-reminders`), woken every 10 minutes by `pg_cron`.

* **Daily digest.** Once a day at `reminder_morning_time` (default 09:00, your timezone) you get one email listing
  every **unfinished** task that is overdue or due today — repeated every day until you mark it done, even if it was
  already reminded — plus your **upcoming** tasks for the next 7 days. `settings.last_digest_on` makes it once per
  local day; a day with nothing to list sends nothing.
* **Due-soon heads-up.** A task with a specific due **time** is additionally emailed `reminder_lead_minutes` before it
  (default 60), once — `tasks.reminder_sent_at` dedupes, and changing its due date/time or reopening it resets that.
  If the digest goes out in the same run, the task is covered by the digest instead of a second email.
  Both times are editable in Settings → Reminders, alongside the on/off toggle.
* **Multiple tasks are one email**, not one per task.
* **Privilege boundary.** The functions the Edge Function calls — `tasks_due_for_reminder()` / `digests_due()` (read
  across every user, including their login email) and `mark_reminder_sent()` / `mark_digest_sent()` — are granted
  **only to `service_role`**, not even
  `authenticated`. No client, including Mneme's own frontend, can ever call them; only the deployed Edge Function
  (holding the service-role key) can.
* **Free-tier email limits.** Sent via [Resend](https://resend.com), the same provider Argus already uses — see the
  sandbox-sender caveat in §5.6. Resend's free tier and the 10-minute cron tick both stay comfortably inside Supabase
  and Resend's free quotas for personal use.
* **Turning it off** again: Settings → Reminders, or leave every task without a due date. To remove the infrastructure
  entirely: `select cron.unschedule('mneme-task-reminders');` and `supabase functions delete task-reminders` — the
  `pg_cron`/`pg_net` extensions themselves are left enabled since Argus's SQL files already assume them.
