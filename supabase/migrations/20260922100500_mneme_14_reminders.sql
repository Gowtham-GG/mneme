-- =============================================================================
-- Mneme 14 — due-date reminder emails: settings + task bookkeeping + the two
-- functions the (separately deployed) Edge Function calls.
--
-- mneme.tasks_due_for_reminder() and mneme.mark_reminder_sent() are SECURITY
-- DEFINER and granted ONLY to service_role — never authenticated/anon/public.
-- This is stricter than every other function in this schema on purpose: the
-- reminder function reads auth.users.email for arbitrary users, which no
-- regular client may ever do. Only the Edge Function (using the service-role
-- key) can call them; a signed-in user calling either gets permission denied.
--
-- Reminder timing (matches Settings -> Reminders):
--   * a task WITH a due_time fires reminder_lead_minutes before that time
--   * a task with only a due_date (no time) fires at reminder_morning_time
--     (a fixed local clock time) on the due date
-- One reminder per due task: reminder_sent_at dedupes, and is reset back to
-- null whenever due_date/due_time changes or a done task is reopened, so a
-- rescheduled task gets a fresh reminder.
--
-- Off by default (settings.reminders_enabled = false) — no one gets a
-- surprise email. Additive; nothing in `public` (Argus) is touched.
-- =============================================================================
begin;

alter table mneme.settings
  add column if not exists reminders_enabled boolean not null default false;
alter table mneme.settings
  add column if not exists reminder_lead_minutes integer not null default 60
    check (reminder_lead_minutes between 0 and 10080);
alter table mneme.settings
  add column if not exists reminder_morning_time time not null default '09:00';

alter table mneme.tasks add column if not exists reminder_sent_at timestamptz;

-- Reset the dedupe marker on reschedule/reopen (everything else in this
-- trigger is unchanged from 03_triggers.sql).
create or replace function mneme.tasks_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or old.status is distinct from new.status then
    new.completed_at := case when new.status = 'done' then coalesce(new.completed_at, now()) else null end;
  end if;
  if tg_op = 'UPDATE' and (
       new.due_date is distinct from old.due_date
    or new.due_time is distinct from old.due_time
    or (old.status = 'done' and new.status = 'open')
  ) then
    new.reminder_sent_at := null;
  end if;
  new.updated_at := now();
  return new;
end
$$;

-- Every open, not-yet-reminded, due-or-due-soon task whose owner has opted
-- in, with the email to send to. Runs as the defining role (which, as on
-- every Supabase project, can read auth.users) so the Edge Function never
-- needs its own per-user email lookup.
create or replace function mneme.tasks_due_for_reminder()
returns table (
  task_id uuid, user_id uuid, email text, title text,
  note_public_id text, due_date date, due_time time
)
language sql
stable
security definer
set search_path = ''
as $$
  select t.id, t.user_id, u.email, t.title, n.public_id, t.due_date, t.due_time
  from mneme.tasks t
  join mneme.settings s on s.user_id = t.user_id
  join auth.users u on u.id = t.user_id
  left join mneme.notes n on n.id = t.note_id
  where t.status = 'open'
    and t.removed_at is null
    and t.reminder_sent_at is null
    and s.reminders_enabled
    and t.due_date is not null
    and (
      (t.due_time is not null
       and (now() at time zone coalesce(s.timezone, 'UTC'))
           >= (t.due_date + t.due_time) - make_interval(mins => s.reminder_lead_minutes))
      or
      (t.due_time is null
       and (now() at time zone coalesce(s.timezone, 'UTC'))
           >= (t.due_date + s.reminder_morning_time))
    )
$$;

create or replace function mneme.mark_reminder_sent(p_task_ids uuid[])
returns void
language sql
security definer
set search_path = ''
as $$
  update mneme.tasks set reminder_sent_at = now() where id = any (coalesce(p_task_ids, '{}'));
$$;

grant usage on schema mneme to service_role;
revoke all on function mneme.tasks_due_for_reminder()   from public, anon, authenticated;
revoke all on function mneme.mark_reminder_sent(uuid[]) from public, anon, authenticated;
grant execute on function mneme.tasks_due_for_reminder()   to service_role;
grant execute on function mneme.mark_reminder_sent(uuid[]) to service_role;

commit;
