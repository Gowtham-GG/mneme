-- =============================================================================
-- Mneme 16 — daily reminder digest. Once a day, at the user's
-- reminder_morning_time (in their timezone), every opted-in user gets ONE email
-- listing every unfinished task that is overdue or due today — repeated every
-- day until the task is done, no matter how many reminders it already got —
-- plus their upcoming tasks for the next few days.
--
-- The per-task "due soon" reminder from 14_reminders.sql stays, but only for
-- tasks WITH a due_time (fires reminder_lead_minutes before). Date-only tasks
-- are now covered by the digest instead of a one-off morning email, so nobody
-- gets two emails for the same task at the same moment.
--
-- Dedupe: settings.last_digest_on holds the user's local date of the last
-- digest; a user is due when their local clock has passed
-- reminder_morning_time and last_digest_on is before their local today. A
-- missed tick (cron hiccup) catches up on the next one the same day.
--
-- Same privilege boundary as 14: both new functions are SECURITY DEFINER and
-- granted ONLY to service_role. Additive; nothing in `public` (Argus) is touched.
-- =============================================================================
begin;

alter table mneme.settings add column if not exists last_digest_on date;

-- Timed tasks only now; date-only tasks are handled by digests_due().
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
    and (t.note_id is null or n.deleted_at is null)
    and t.reminder_sent_at is null
    and s.reminders_enabled
    and t.due_date is not null
    and t.due_time is not null
    and (now() at time zone coalesce(s.timezone, 'UTC'))
        >= (t.due_date + t.due_time) - make_interval(mins => s.reminder_lead_minutes)
$$;

-- One row per (user due for a digest, task in that digest). A due user with
-- no qualifying tasks still gets exactly one row with task_id = null, so the
-- caller can mark them done for the day without emailing them.
-- bucket: 'overdue' | 'today' | 'upcoming' (due within p_upcoming_days).
create or replace function mneme.digests_due(p_upcoming_days integer default 7)
returns table (
  user_id uuid, email text, local_date date,
  task_id uuid, title text, note_public_id text,
  due_date date, due_time time, priority text, bucket text
)
language sql
stable
security definer
set search_path = ''
as $$
  with due_users as (
    select s.user_id, u.email,
           (now() at time zone coalesce(s.timezone, 'UTC'))::date as local_date
    from mneme.settings s
    join auth.users u on u.id = s.user_id
    where s.reminders_enabled
      and (now() at time zone coalesce(s.timezone, 'UTC'))
          >= ((now() at time zone coalesce(s.timezone, 'UTC'))::date + s.reminder_morning_time)
      and (s.last_digest_on is null
           or s.last_digest_on < (now() at time zone coalesce(s.timezone, 'UTC'))::date)
  )
  select d.user_id, d.email, d.local_date,
         t.id, t.title, t.note_public_id, t.due_date, t.due_time, t.priority,
         case when t.id is null then null
              when t.due_date < d.local_date then 'overdue'
              when t.due_date = d.local_date then 'today'
              else 'upcoming' end
  from due_users d
  left join lateral (
    select t.id, t.title, n.public_id as note_public_id, t.due_date, t.due_time, t.priority
    from mneme.tasks t
    left join mneme.notes n on n.id = t.note_id
    where t.user_id = d.user_id
      and t.status = 'open'
      and t.removed_at is null
      and (t.note_id is null or n.deleted_at is null)
      and t.due_date is not null
      and t.due_date <= d.local_date + least(greatest(coalesce(p_upcoming_days, 7), 0), 60)
  ) t on true
  order by d.user_id, t.due_date nulls first, t.due_time nulls last, t.title
$$;

create or replace function mneme.mark_digest_sent(p_user_ids uuid[])
returns void
language sql
security definer
set search_path = ''
as $$
  update mneme.settings s
     set last_digest_on = (now() at time zone coalesce(s.timezone, 'UTC'))::date
   where s.user_id = any (coalesce(p_user_ids, '{}'));
$$;

revoke all on function mneme.tasks_due_for_reminder()   from public, anon, authenticated;
revoke all on function mneme.digests_due(integer)       from public, anon, authenticated;
revoke all on function mneme.mark_digest_sent(uuid[])   from public, anon, authenticated;
grant execute on function mneme.tasks_due_for_reminder() to service_role;
grant execute on function mneme.digests_due(integer)     to service_role;
grant execute on function mneme.mark_digest_sent(uuid[]) to service_role;

commit;
