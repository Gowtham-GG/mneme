-- =============================================================================
-- Mneme 26 — typed dates, snooze, task mentions, device notifications, and a
-- restorable (weekly emailed) backup.
--   typed dates      a new task's title is read for a date/time:
--                    "call bank tomorrow 3pm" -> "call bank", due tomorrow 15:00
--                    (parse_due). Task boxes take the words out; a new
--                    checkbox line in a note keeps them and just gets the date.
--   snooze           tasks.snoozed_until: until that day the task is out of
--                    every list, the board, the badge and reminders; the
--                    Tasks page has a Snoozed list.
--   mentions         task_mentions(task): notes linking to it with [[T-…]].
--   push             push_subscriptions (one per device that allowed
--                    notifications). Reminders now go to users with email
--                    reminders on OR a device; the Edge Function emails only
--                    when send_email and pushes to every device.
--   backup           backup_data(user) = the whole account except the vault;
--                    export_backup() for the signed-in user; import_backup()
--                    rebuilds it in an empty account (N-… ids kept);
--                    backups_due()/mark_backup_sent() drive the weekly email.
-- Additive; nothing in `public` (Argus) is touched.
-- =============================================================================
begin;


-- ------------------------------------------------------------------ columns --
alter table mneme.tasks add column if not exists snoozed_until date;
alter table mneme.settings
  add column if not exists backup_enabled boolean not null default false,
  add column if not exists backup_weekday smallint not null default 7 check (backup_weekday between 1 and 7),  -- ISO, 7 = Sunday
  add column if not exists last_backup_on date;

-- the caller's (or a given user's) local date
create or replace function mneme.user_today(p_user uuid default null)
returns date
language sql
stable
set search_path = ''
as $$
  select (now() at time zone coalesce(
    (select s.timezone from mneme.settings s where s.user_id = coalesce(p_user, (select auth.uid()))), 'UTC'))::date
$$;

-- ------------------------------------------------------- push subscriptions --
-- One row per browser/device that allowed notifications (Web Push).
create table if not exists mneme.push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  endpoint   text not null unique check (endpoint ~ '^https://'),
  p256dh     text not null,
  auth       text not null,
  device     text check (device is null or char_length(device) <= 200),
  created_at timestamptz not null default now(),
  last_ok_at timestamptz
);
create index if not exists push_subscriptions_user_idx on mneme.push_subscriptions (user_id);
alter table mneme.push_subscriptions enable row level security;
drop policy if exists push_subscriptions_owner on mneme.push_subscriptions;
create policy push_subscriptions_owner on mneme.push_subscriptions for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant select, insert, update, delete on mneme.push_subscriptions to authenticated;

-- ------------------------------------------------------------- reminders ---
-- Now for users with reminder emails on OR a device with notifications; the
-- caller emails only when send_email. Snoozed tasks stay quiet.
drop function if exists mneme.tasks_due_for_reminder();
create function mneme.tasks_due_for_reminder()
returns table (
  task_id uuid, user_id uuid, email text, title text,
  note_public_id text, due_date date, due_time time, code text, send_email boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select t.id, t.user_id, u.email, t.title, n.public_id, t.due_date, t.due_time, mneme.task_code(t.id), s.reminders_enabled
  from mneme.tasks t
  join mneme.settings s on s.user_id = t.user_id
  join auth.users u on u.id = t.user_id
  left join mneme.notes n on n.id = t.note_id
  where t.status = 'open'
    and t.removed_at is null
    and (t.note_id is null or n.deleted_at is null)
    and t.reminder_sent_at is null
    and (s.reminders_enabled or exists (select 1 from mneme.push_subscriptions p where p.user_id = t.user_id))
    and t.due_date is not null
    and t.due_time is not null
    and (t.snoozed_until is null or t.snoozed_until <= (now() at time zone coalesce(s.timezone, 'UTC'))::date)
    and (now() at time zone coalesce(s.timezone, 'UTC'))
        >= (t.due_date + t.due_time) - make_interval(mins => s.reminder_lead_minutes)
$$;

drop function if exists mneme.digests_due(integer);
create function mneme.digests_due(p_upcoming_days integer default 7)
returns table (
  user_id uuid, email text, local_date date,
  task_id uuid, title text, note_public_id text,
  due_date date, due_time time, priority text, bucket text, send_email boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  with due_users as (
    select s.user_id, u.email, s.reminders_enabled,
           (now() at time zone coalesce(s.timezone, 'UTC'))::date as local_date
    from mneme.settings s
    join auth.users u on u.id = s.user_id
    where (s.reminders_enabled or exists (select 1 from mneme.push_subscriptions p where p.user_id = s.user_id))
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
              else 'upcoming' end,
         d.reminders_enabled
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
      and (t.snoozed_until is null or t.snoozed_until <= d.local_date)
      and t.due_date <= d.local_date + least(greatest(coalesce(p_upcoming_days, 7), 0), 60)
  ) t on true
  order by d.user_id, t.due_date nulls first, t.due_time nulls last, t.title
$$;

-- the devices to notify
create or replace function mneme.push_targets(p_user_ids uuid[])
returns table (user_id uuid, endpoint text, p256dh text, auth text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.user_id, p.endpoint, p.p256dh, p.auth from mneme.push_subscriptions p where p.user_id = any (coalesce(p_user_ids, '{}'))
$$;

-- a push service said the subscription is gone (404/410), or it worked
create or replace function mneme.push_result(p_endpoint text, p_ok boolean)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from mneme.push_subscriptions where endpoint = p_endpoint and not p_ok;
  update mneme.push_subscriptions set last_ok_at = now() where endpoint = p_endpoint and p_ok;
$$;

revoke all on function mneme.tasks_due_for_reminder()   from public, anon, authenticated;
revoke all on function mneme.digests_due(integer)       from public, anon, authenticated;
revoke all on function mneme.push_targets(uuid[])       from public, anon, authenticated;
revoke all on function mneme.push_result(text, boolean) from public, anon, authenticated;
grant execute on function mneme.tasks_due_for_reminder()   to service_role;
grant execute on function mneme.digests_due(integer)       to service_role;
grant execute on function mneme.push_targets(uuid[])       to service_role;
grant execute on function mneme.push_result(text, boolean) to service_role;

-- ---------------------------------------------------------------- mentions --
-- Notes whose text links to the task ([[T-1A2B3C4D]] or [[T-…|label]]).
create or replace function mneme.task_mentions(p_task uuid)
returns table (id uuid, public_id text, title text, note_type text, updated_at timestamptz)
language sql
stable
set search_path = ''
as $$
  select n.id, n.public_id, n.title, n.note_type, n.updated_at
  from mneme.notes n
  where n.deleted_at is null
    and n.content ~* ('\[\[\s*' || mneme.task_code(p_task) || '\s*(\||\]\])')
  order by n.updated_at desc
  limit 50
$$;
revoke all on function mneme.task_mentions(uuid) from public, anon;
grant execute on function mneme.task_mentions(uuid) to authenticated;

-- ------------------------------------------------------------ typed dates --
create or replace function mneme.month_num(p text)
returns integer language sql immutable set search_path = '' as $$
  select array_position(array['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'], left(lower(p), 3))
$$;

create or replace function mneme.weekday_num(p text)   -- ISO: Monday = 1
returns integer language sql immutable set search_path = '' as $$
  select array_position(array['mon','tue','wed','thu','fri','sat','sun'], left(lower(p), 3))
$$;

-- "call bank tomorrow 3pm" -> ("call bank", tomorrow, 15:00). English phrases:
--   today · tonight · tomorrow/tmrw · day after tomorrow · monday… (mon/tue… only
--   after on/by/due/next/this) · next week · next month · in 3 days/weeks/months ·
--   25 sep [2027] · sep 25th · 25/9[/2027] · 2026-09-25
--   3pm · 3:30pm · 15:00 · at 5 (1–6 = pm) · noon · midnight
-- A time with no date means today; a day/month already past means next year.
-- If nothing but the date words would be left, nothing is taken out.
drop function if exists mneme.parse_due(text, date);
create function mneme.parse_due(p_text text, p_today date)
returns table (title text, due_date date, due_time time, has_date boolean)
language plpgsql
immutable
set search_path = ''
as $$
declare
  s   text := ' ' || coalesce(p_text, '') || ' ';
  m   text[];
  pat text;
  d   date;
  tm  time;
  y   integer; mo integer; dd integer; h integer; mi integer;
  pre constant text := '(?:(?:on|by|due|this) )?';
  mon constant text := '(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)';
begin
  -- ------------------------------------------------------------- the date
  pat := '\m' || pre || 'day after tomorrow\M';
  if d is null and s ~* pat then d := p_today + 2; s := regexp_replace(s, pat, ' ', 'i'); end if;
  pat := '\m' || pre || '(?:tomorrow|tmrw|tmr)\M';
  if d is null and s ~* pat then d := p_today + 1; s := regexp_replace(s, pat, ' ', 'i'); end if;
  pat := '\m' || pre || '(?:today|tonight)\M';
  if d is null and s ~* pat then d := p_today; s := regexp_replace(s, pat, ' ', 'i'); end if;
  pat := '\m(?:next week)\M';
  if d is null and s ~* pat then d := p_today + 7; s := regexp_replace(s, pat, ' ', 'i'); end if;
  pat := '\m(?:next month)\M';
  if d is null and s ~* pat then d := (p_today + interval '1 month')::date; s := regexp_replace(s, pat, ' ', 'i'); end if;

  pat := '\min (a|an|\d{1,3}) (day|days|week|weeks|month|months)\M';
  m := regexp_match(s, pat, 'i');
  if d is null and m is not null then
    y := case when m[1] ~ '^\d' then m[1]::int else 1 end;
    d := case when m[2] ~* '^day' then p_today + y
              when m[2] ~* '^week' then p_today + 7 * y
              else (p_today + make_interval(months => y))::date end;
    s := regexp_replace(s, pat, ' ', 'i');
  end if;

  -- weekdays: full names anywhere; short ones only after on/by/due/next/this
  pat := '\m(?:(on|by|due|next|this) )?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\M';
  m := regexp_match(s, pat, 'i');
  if d is null and m is null then
    pat := '\m(on|by|due|next|this) (mon|tues|tue|wed|thurs|thur|thu|fri|sat|sun)\M';
    m := regexp_match(s, pat, 'i');
  end if;
  if d is null and m is not null then
    y := mneme.weekday_num(m[2]);
    dd := (y - extract(isodow from p_today)::int + 7) % 7;   -- 0 = today
    if lower(coalesce(m[1], '')) = 'next' and dd = 0 then dd := 7; end if;
    d := p_today + dd;
    s := regexp_replace(s, pat, ' ', 'i');
  end if;

  -- 25 sep [2027] / 25th september
  pat := '\m' || pre || '(\d{1,2})(?:st|nd|rd|th)? ' || mon || '\.?(?:,? (\d{4}))?\M';
  m := regexp_match(s, pat, 'i');
  if d is null and m is not null then
    dd := m[1]::int; mo := mneme.month_num(m[2]); y := coalesce(m[3]::int, extract(year from p_today)::int);
    begin d := make_date(y, mo, dd); exception when others then d := null; end;
    if d is not null and m[3] is null and d < p_today then d := make_date(y + 1, mo, dd); end if;
    if d is not null then s := regexp_replace(s, pat, ' ', 'i'); end if;
  end if;
  -- sep 25 [2027] / september 25th, 2027
  pat := '\m' || pre || mon || '\.? (\d{1,2})(?:st|nd|rd|th)?(?:,? (\d{4}))?\M';
  m := regexp_match(s, pat, 'i');
  if d is null and m is not null then
    mo := mneme.month_num(m[1]); dd := m[2]::int; y := coalesce(m[3]::int, extract(year from p_today)::int);
    begin d := make_date(y, mo, dd); exception when others then d := null; end;
    if d is not null and m[3] is null and d < p_today then d := make_date(y + 1, mo, dd); end if;
    if d is not null then s := regexp_replace(s, pat, ' ', 'i'); end if;
  end if;
  -- 2026-09-25
  pat := '\m(\d{4})-(\d{2})-(\d{2})\M';
  m := regexp_match(s, pat);
  if d is null and m is not null then
    begin d := make_date(m[1]::int, m[2]::int, m[3]::int); exception when others then d := null; end;
    if d is not null then s := regexp_replace(s, pat, ' '); end if;
  end if;
  -- 25/9[/2027] (day first)
  pat := '\m' || pre || '(\d{1,2})/(\d{1,2})(?:/(\d{2}|\d{4}))?\M';
  m := regexp_match(s, pat, 'i');
  if d is null and m is not null then
    dd := m[1]::int; mo := m[2]::int;
    y := case when m[3] is null then extract(year from p_today)::int when length(m[3]) = 2 then 2000 + m[3]::int else m[3]::int end;
    begin d := make_date(y, mo, dd); exception when others then d := null; end;
    if d is not null and m[3] is null and d < p_today then d := make_date(y + 1, mo, dd); end if;
    if d is not null then s := regexp_replace(s, pat, ' ', 'i'); end if;
  end if;

  -- ------------------------------------------------------------- the time
  pat := '\m(?:(?:at|by) )?(\d{1,2})(?:[:.](\d{2}))? ?(am|pm|a\.m\.|p\.m\.)(?=\s|[.,;!?)]|$)';
  m := regexp_match(s, pat, 'i');
  if m is not null and m[1]::int between 1 and 12 and coalesce(m[2], '0')::int < 60 then
    h := m[1]::int % 12 + case when lower(left(m[3], 1)) = 'p' then 12 else 0 end;
    tm := make_time(h, coalesce(m[2], '0')::int, 0);
    s := regexp_replace(s, pat, ' ', 'i');
  end if;
  pat := '\m(?:(?:at|by) )?([01]?\d|2[0-3]):([0-5]\d)\M';
  m := regexp_match(s, pat, 'i');
  if tm is null and m is not null then
    tm := make_time(m[1]::int, m[2]::int, 0);
    s := regexp_replace(s, pat, ' ', 'i');
  end if;
  pat := '\m(?:(?:at|by) )?(noon|midday|midnight)\M';
  m := regexp_match(s, pat, 'i');
  if tm is null and m is not null then
    tm := case when lower(m[1]) = 'midnight' then time '00:00' else time '12:00' end;
    s := regexp_replace(s, pat, ' ', 'i');
  end if;
  pat := '\mat (\d{1,2})\M(?![:./])';
  m := regexp_match(s, pat, 'i');
  if tm is null and m is not null and m[1]::int between 1 and 23 then
    h := m[1]::int;
    tm := make_time(case when h between 1 and 6 then h + 12 else h end, 0, 0);
    s := regexp_replace(s, pat, ' ', 'i');
  end if;

  if d is null and tm is null then
    return query select p_text, null::date, null::time, false;
    return;
  end if;
  s := btrim(regexp_replace(regexp_replace(s, '\s+', ' ', 'g'), '^[\s,;:–—-]+|[\s,;:–—-]+$', '', 'g'));
  if s = '' then
    -- nothing but date words: keep the text as typed, no date
    return query select p_text, null::date, null::time, false;
    return;
  end if;
  return query select s, coalesce(d, p_today), tm, d is not null;
end
$$;

-- ------------------------------------------------------------- triggers --
create or replace function mneme.notes_before_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.created_at := least(new.created_at, now());   -- offline capture time, but never the future
  new.updated_at := case when mneme.task_flag('import') then least(coalesce(new.updated_at, now()), now()) else now() end;
  new.title      := nullif(btrim(new.title), '');
  new.version    := 1;
  if mneme.task_flag('import') and coalesce(new.public_id, '') <> '' then
    -- a restored backup keeps its N-… ids (links point at them)
    perform mneme.claim_public_id(new.public_id);
  else
    new.public_id  := mneme.next_public_id(new.created_at, new.user_id);
  end if;
  return new;
end
$$;

create or replace function mneme.tasks_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_sync         boolean := mneme.task_flag('note_sync');
  v_move         boolean := mneme.task_flag('move');
  v_import       boolean := mneme.task_flag('import');
  v_internal     boolean := mneme.task_flag('internal') or mneme.task_flag('cascade') or v_sync or v_import;
  v_parsed       record;
  v_state_set    boolean := tg_op = 'UPDATE' and new.state is distinct from old.state;
  v_status_set   boolean := tg_op = 'UPDATE' and new.status is distinct from old.status and not (new.state is distinct from old.state);
  v_moved        boolean;
  v_due_changed  boolean;
  v_seq_parent   uuid;
  v_parent       mneme.tasks;
  k              timestamp;
  v_lim          record;
begin
  -- typed dates: "call bank tomorrow 3pm" -> "call bank", due tomorrow 15:00
  if tg_op = 'INSERT' and new.source = 'standalone' and not (v_internal or v_move) then
    select * into v_parsed from mneme.parse_due(new.title, mneme.user_today(new.user_id));
    if v_parsed.due_date is not null then
      new.title := v_parsed.title;
      if v_parsed.has_date then
        new.due_date := v_parsed.due_date;
        new.due_time := coalesce(v_parsed.due_time, new.due_time);
      else
        new.due_date := coalesce(new.due_date, v_parsed.due_date);
        new.due_time := v_parsed.due_time;
      end if;
    end if;
  end if;

  -- state <-> status
  if tg_op = 'INSERT' then
    if new.status = 'done' and new.state = 'open' then new.state := 'done'; end if;
    new.status := case when new.state in ('done', 'cancelled') then 'done' else 'open' end;
  elsif v_state_set then
    new.status := case when new.state in ('done', 'cancelled') then 'done' else 'open' end;
  elsif v_status_set then
    new.state := case when new.status = 'done' then 'done' else 'open' end;
  end if;
  if new.state <> 'cancelled' then new.cascade_cancelled := false; end if;

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

  -- place in the tree: a sequence decides the parent; leaving the parent leaves the sequence
  if new.sequence_id is not null and (tg_op = 'INSERT' or new.sequence_id is distinct from old.sequence_id) then
    select s.task_id into v_seq_parent from mneme.task_sequences s where s.id = new.sequence_id;
    if not found then raise exception 'sequence not found' using errcode = 'P0002'; end if;
    new.parent_id := v_seq_parent;
  elsif tg_op = 'UPDATE' and new.parent_id is distinct from old.parent_id and new.sequence_id is not null then
    new.sequence_id := null;
  end if;

  v_moved := tg_op = 'INSERT'
          or new.parent_id is distinct from old.parent_id
          or new.sequence_id is distinct from old.sequence_id;

  if new.parent_id is not null and v_moved then
    select * into v_parent from mneme.tasks p where p.id = new.parent_id;
    if not found then raise exception 'parent task not found' using errcode = 'P0002'; end if;
    -- a note decides the structure of its own tasks; everything else goes through move_task()
    if not (v_sync or v_move or v_import) and (new.source = 'note' or v_parent.source = 'note') then
      raise exception 'Tasks written in a note are arranged in the note — use Move under… or edit the note.';
    end if;
    if tg_op = 'UPDATE' and (new.parent_id = new.id or new.id in (select mneme.task_ancestor_ids(new.parent_id))) then
      raise exception 'A task can’t go under one of its own subtasks.';
    end if;
  end if;

  if new.sequence_id is not null and new.source = 'standalone' and not (v_sync or v_move or v_import)
     and exists (select 1 from mneme.task_sequences s where s.id = new.sequence_id and s.note_id is not null) then
    raise exception 'That sequence is written in a note — add the step there.';
  end if;
  if tg_op = 'UPDATE' and new.source = 'note' and not (v_sync or v_move or v_import)
     and new.sequence_id is distinct from old.sequence_id then
    raise exception 'Tasks written in a note are arranged in the note — edit the note instead.';
  end if;

  -- position among siblings: appended when new to the group (a note sets line numbers itself)
  if not (v_sync or v_import) and new.parent_id is not null and (
       (tg_op = 'INSERT' and new.sort_order = 0)
    or (tg_op = 'UPDATE' and v_moved and new.sort_order is not distinct from old.sort_order)
  ) then
    select coalesce(max(s.sort_order), 0) + 1 into new.sort_order
      from mneme.tasks s
     where s.parent_id = new.parent_id and s.sequence_id is not distinct from new.sequence_id
       and s.id <> new.id;
  end if;

  -- guards: blocked tasks can't start or finish; a parent can't finish before its subtasks
  if tg_op = 'UPDATE' and not v_internal and new.state in ('in_progress', 'done')
     and (v_state_set or (v_status_set and new.source = 'standalone')) then
    if mneme.task_blocked(new.id) then
      raise exception 'This is blocked — finish what comes before it first.';
    end if;
    if new.state = 'done' and exists (
      select 1 from mneme.tasks c where c.parent_id = new.id and c.removed_at is null
         and c.state not in ('done', 'cancelled')) then
      raise exception 'Finish or cancel its subtasks first.';
    end if;
  end if;

  -- chronology (pushes to parents / later steps happen in the after-trigger);
  -- a cancel cascade only flips states and is left alone
  -- a note save is never refused over dates: the pushes still happen afterwards
  if new.state <> 'cancelled' and not mneme.task_flag('cascade') and not v_sync and not v_import then
    v_due_changed := tg_op = 'INSERT' or new.due_date is distinct from old.due_date or new.due_time is distinct from old.due_time;
    k := mneme.due_key(new.due_date, new.due_time);

    if tg_op = 'UPDATE' and v_due_changed then
      select c.due_date, c.due_time into v_lim
        from mneme.tasks c
       where c.parent_id = new.id and c.removed_at is null and c.state <> 'cancelled' and c.due_date is not null
       order by mneme.due_key(c.due_date, c.due_time) desc limit 1;
      if found and (k is null or k < mneme.due_key(v_lim.due_date, v_lim.due_time)) then
        raise exception 'It can’t be due before its subtasks — the latest is due %.', mneme.fmt_due(v_lim.due_date, v_lim.due_time);
      end if;
    end if;

    if new.sequence_id is not null and k is not null and (
         v_due_changed or v_moved or new.sort_order is distinct from old.sort_order
      or (tg_op = 'UPDATE' and old.state = 'cancelled')
    ) then
      select s.due_date, s.due_time into v_lim
        from mneme.tasks s
       where s.sequence_id = new.sequence_id and s.id <> new.id
         and s.removed_at is null and s.state <> 'cancelled' and s.due_date is not null
         and (s.sort_order, s.created_at, s.id) < (new.sort_order, new.created_at, new.id)
       order by mneme.due_key(s.due_date, s.due_time) desc limit 1;
      if found and k < mneme.due_key(v_lim.due_date, v_lim.due_time) then
        raise exception 'A step can’t be due before the step before it (due %).', mneme.fmt_due(v_lim.due_date, v_lim.due_time);
      end if;
    end if;
  end if;

  return new;
end
$$;

create or replace function mneme.tasks_after_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  k       timestamp;
  v_next  record;
  v_prev  text;
  r       record;
begin
  if mneme.task_flag('cascade') or mneme.task_flag('import') then return null; end if;

  if tg_op = 'DELETE' then
    perform mneme.task_rollup(old.parent_id);
    return null;
  end if;

  -- a subtask follows its main task: it is never on a canvas itself
  if new.parent_id is not null and (tg_op = 'INSERT' or old.parent_id is null) then
    delete from mneme.canvas_tasks where task_id = new.id;
  end if;

  -- cancel cascade / un-cancel
  if tg_op = 'UPDATE' and new.state = 'cancelled' and old.state <> 'cancelled' then
    v_prev := coalesce(current_setting('mneme.cascade', true), '');
    perform set_config('mneme.cascade', 'on', true);
    with recursive down as (
      select c.id from mneme.tasks c where c.parent_id = new.id
      union all
      select c.id from mneme.tasks c join down d on c.parent_id = d.id
    )
    update mneme.tasks x set state = 'cancelled', cascade_cancelled = true
     where x.id in (select id from down) and x.state not in ('done', 'cancelled');
    perform set_config('mneme.cascade', v_prev, true);
  elsif tg_op = 'UPDATE' and old.state = 'cancelled' and new.state <> 'cancelled' then
    v_prev := coalesce(current_setting('mneme.cascade', true), '');
    perform set_config('mneme.cascade', 'on', true);
    with recursive down as (
      select c.id from mneme.tasks c where c.parent_id = new.id
      union all
      select c.id from mneme.tasks c join down d on c.parent_id = d.id
    )
    update mneme.tasks x set state = 'open'
     where x.id in (select id from down) and x.state = 'cancelled' and x.cascade_cancelled;
    perform set_config('mneme.cascade', v_prev, true);
    -- reopened parents re-derive their state, deepest first
    for r in
      with recursive down as (
        select c.id, 1 as d from mneme.tasks c where c.parent_id = new.id
        union all
        select c.id, d.d + 1 from mneme.tasks c join down d on c.parent_id = d.id
      )
      select down.id from down
       where exists (select 1 from mneme.tasks c where c.parent_id = down.id)
       order by down.d desc
    loop
      perform mneme.task_rollup(r.id);
    end loop;
  end if;
  -- leaving a manual hold / cancel lets the roll-up take over again
  if tg_op = 'UPDATE' and old.state in ('on_hold', 'cancelled') and new.state not in ('on_hold', 'cancelled') then
    perform mneme.task_rollup(new.id);
  end if;

  -- chronology pushes: the parent and the next dated step are moved later
  if new.state <> 'cancelled' and new.due_date is not null and (
       tg_op = 'INSERT'
    or new.due_date is distinct from old.due_date or new.due_time is distinct from old.due_time
    or new.parent_id is distinct from old.parent_id or new.sequence_id is distinct from old.sequence_id
    or new.sort_order is distinct from old.sort_order or old.state = 'cancelled'
  ) then
    k := mneme.due_key(new.due_date, new.due_time);
    if new.parent_id is not null then
      update mneme.tasks p set due_date = new.due_date, due_time = new.due_time
       where p.id = new.parent_id and p.state <> 'cancelled'
         and (p.due_date is null or mneme.due_key(p.due_date, p.due_time) < k);
    end if;
    if new.sequence_id is not null then
      select s.id, s.due_date, s.due_time into v_next
        from mneme.tasks s
       where s.sequence_id = new.sequence_id and s.id <> new.id
         and s.removed_at is null and s.state <> 'cancelled' and s.due_date is not null
         and (s.sort_order, s.created_at, s.id) > (new.sort_order, new.created_at, new.id)
       order by s.sort_order, s.created_at, s.id limit 1;
      if found and mneme.due_key(v_next.due_date, v_next.due_time) < k then
        update mneme.tasks set due_date = new.due_date, due_time = new.due_time where id = v_next.id;
      end if;
    end if;
  end if;

  -- roll-up of the (old and new) parent
  if tg_op = 'INSERT'
     or new.state is distinct from old.state
     or new.parent_id is distinct from old.parent_id
     or new.removed_at is distinct from old.removed_at then
    perform mneme.task_rollup(new.parent_id);
    if tg_op = 'UPDATE' and old.parent_id is distinct from new.parent_id then
      perform mneme.task_rollup(old.parent_id);
    end if;
  end if;

  -- a note task changed outside its note (Tasks page, board, roll-up): write the
  -- status markers back into the note. Never during that note's own save.
  if new.source = 'note' and (tg_op = 'INSERT' or new.state is distinct from old.state)
     and not mneme.task_flag('note_sync') and not mneme.task_flag('move') then
    perform mneme.write_task_markers(new.note_id);
  end if;
  return null;
end
$$;

create or replace function mneme.sync_note_tasks(p_note uuid, p_uid uuid, p_content text)
returns void
language plpgsql
set search_path = ''
as $$
declare
  nl int[]; nm text[]; nt text[]; nk text[]; nord boolean[];
  eid uuid[]; ekey text[];
  n_new int; n_old int;
  t_of uuid[]; used boolean[];
  i int; j int; v_rid uuid;
  v_prev text;
  -- structure
  line_task int[];          -- line number -> index into the arrays above (0 = not a task line)
  par int[]; grp int[];
  g_parent int[] := '{}'; g_title text[] := '{}'; g_seq uuid[] := '{}'; g_key text[] := '{}'; ng int := 0;
  s_ind int[] := '{}'; s_idx int[] := '{}'; s_gopen int[] := '{}'; s_title text[] := '{}'; sp int := 0;
  root_gopen int := 0; root_title text := null;
  ctx_gopen int; ctx_title text;
  r record; v_ind int; v_p int; v_sid uuid; v_nlines int; v_ord int;
  v_today date := mneme.user_today(p_uid);
  v_parse boolean := not mneme.task_flag('import');
  v_due record;
begin
  v_prev := coalesce(current_setting('mneme.note_sync', true), '');
  perform set_config('mneme.note_sync', 'on', true);

  select coalesce(array_agg(t.n order by t.n), '{}'),
         coalesce(array_agg(t.marker order by t.n), '{}'),
         coalesce(array_agg(t.title order by t.n), '{}'),
         coalesce(array_agg(t.key order by t.n), '{}'),
         coalesce(array_agg(t.ordered order by t.n), '{}')
    into nl, nm, nt, nk, nord
    from mneme.note_task_items(p_content) t;

  select coalesce(array_agg(x.id order by x.position, x.created_at, x.id), '{}'),
         coalesce(array_agg(x.line_key order by x.position, x.created_at, x.id), '{}')
    into eid, ekey
    from mneme.tasks x
   where x.note_id = p_note and x.source = 'note' and x.removed_at is null;

  n_new := coalesce(cardinality(nl), 0);
  n_old := coalesce(cardinality(eid), 0);
  t_of  := array_fill(null::uuid, array[n_new]);
  used  := array_fill(false, array[n_old]);

  -- pass 1: identical text keeps its task (due date, priority survive moves/ticks)
  for i in 1..n_new loop
    for j in 1..n_old loop
      if not used[j] and ekey[j] = nk[i] then
        t_of[i] := eid[j]; used[j] := true; exit;
      end if;
    end loop;
  end loop;

  -- pass 2: leftover lines pair up in order with leftover tasks (= edited text)
  j := 1;
  for i in 1..n_new loop
    if t_of[i] is null then
      while j <= n_old and used[j] loop j := j + 1; end loop;
      if j <= n_old then
        t_of[i] := eid[j]; used[j] := true;
      end if;
    end if;
  end loop;

  for i in 1..n_new loop
    if t_of[i] is null then
      -- a previously removed line with the same text comes back to life
      select x.id into v_rid
        from mneme.tasks x
       where x.note_id = p_note and x.source = 'note'
         and x.removed_at is not null and x.line_key = nk[i]
       order by x.removed_at desc limit 1;
      t_of[i] := v_rid;
    end if;

    -- a date typed in the line sets the due date while the line is new (the text stays as typed)
    -- (an import restores dates itself: parse nothing)
    select p.due_date, p.due_time into v_due from mneme.parse_due(case when v_parse then nt[i] else '' end, v_today) p;
    if t_of[i] is null then
      insert into mneme.tasks (user_id, note_id, source, title, state, position, sort_order, line_key, line_marker, due_date, due_time)
      values (p_uid, p_note, 'note', nt[i], mneme.marker_state(nm[i]), nl[i], nl[i], nk[i], nm[i], v_due.due_date, v_due.due_time)
      returning id into v_rid;
      t_of[i] := v_rid;
    else
      update mneme.tasks x
         set title = nt[i], line_key = nk[i], position = nl[i], removed_at = null,
             state = case when x.line_marker is distinct from nm[i] then mneme.marker_state(nm[i]) else x.state end,
             line_marker = nm[i],
             -- still being typed (autosave caught it half-way): pick the date up once it appears
             due_date = case when x.due_date is null and x.created_at > now() - interval '15 minutes' and x.title is distinct from nt[i]
                             then v_due.due_date else x.due_date end,
             due_time = case when x.due_date is null and x.created_at > now() - interval '15 minutes' and x.title is distinct from nt[i]
                             then v_due.due_time else x.due_time end
       where x.id = t_of[i]
         and (x.title, x.line_key, x.position, x.removed_at, x.line_marker)
             is distinct from (nt[i], nk[i], nl[i], null::timestamptz, nm[i]);
    end if;
  end loop;

  -- lines that disappeared: keep the task for history, hide it
  for j in 1..n_old loop
    if not used[j] then
      update mneme.tasks set removed_at = now() where id = eid[j];
    end if;
  end loop;

  ------------------------------------------------------------ structure ----
  v_nlines := coalesce(array_length(string_to_array(coalesce(p_content, ''), E'\n'), 1), 0);
  line_task := array_fill(0, array[greatest(v_nlines, 1)]);
  for i in 1..n_new loop line_task[nl[i]] := i; end loop;
  par := array_fill(0, array[greatest(n_new, 1)]);
  grp := array_fill(0, array[greatest(n_new, 1)]);

  for r in select l.n, l.line from mneme.note_lines(p_content) l order by l.n loop
    continue when btrim(r.line) = '';
    v_ind := mneme.line_indent(r.line);
    while sp > 0 and s_ind[sp] >= v_ind loop sp := sp - 1; end loop;
    -- nearest task above in the indentation = the parent
    v_p := 0;
    for k in reverse sp..1 loop
      if s_idx[k] > 0 then v_p := s_idx[k]; exit; end if;
    end loop;
    if sp > 0 then ctx_gopen := s_gopen[sp]; ctx_title := s_title[sp];
    else ctx_gopen := root_gopen; ctx_title := root_title; end if;

    i := line_task[r.n];
    if i > 0 then
      par[i] := v_p;
      if nord[i] then
        if ctx_gopen = 0 then
          ng := ng + 1;
          v_ord := 1 + coalesce((select count(*) from unnest(g_parent) gp where gp = v_p), 0);
          g_parent := g_parent || v_p;
          g_title  := g_title || ctx_title;
          g_key    := g_key || (coalesce(case when v_p > 0 then t_of[v_p]::text end, 'root') || ':' || v_ord);
          ctx_gopen := ng;
        end if;
        grp[i] := ctx_gopen;
      else
        ctx_gopen := 0;
      end if;
      ctx_title := null;
    else
      -- a plain line ends a numbered run; "Name:" names the next one
      ctx_gopen := 0;
      ctx_title := case when btrim(r.line) ~ ':$' then left(btrim(regexp_replace(btrim(r.line), '^([-*+]|[0-9]+[.)])\s+|:$', '', 'g')), 200) end;
    end if;

    if sp > 0 then s_gopen[sp] := ctx_gopen; s_title[sp] := ctx_title;
    else root_gopen := ctx_gopen; root_title := ctx_title; end if;

    sp := sp + 1;
    s_ind[sp] := v_ind; s_idx[sp] := i; s_gopen[sp] := 0; s_title[sp] := null;
  end loop;

  -- the note's sequences, matched to existing rows by (parent task, n-th run)
  for k in 1..ng loop
    v_sid := null;
    select s.id into v_sid from mneme.task_sequences s where s.note_id = p_note and s.note_key = g_key[k];
    if v_sid is null then
      insert into mneme.task_sequences (user_id, task_id, note_id, note_key, title, sort_order)
      values (p_uid, case when g_parent[k] > 0 then t_of[g_parent[k]] end, p_note, g_key[k], g_title[k], k)
      returning id into v_sid;
    else
      update mneme.task_sequences s
         set task_id = case when g_parent[k] > 0 then t_of[g_parent[k]] end, title = g_title[k], sort_order = k
       where s.id = v_sid
         and (s.task_id, s.title, s.sort_order) is distinct from (case when g_parent[k] > 0 then t_of[g_parent[k]] end, g_title[k], k::double precision);
    end if;
    g_seq := g_seq || v_sid;
  end loop;

  -- parents before children (line order), so the tree never loops mid-way
  for i in 1..n_new loop
    update mneme.tasks x
       set parent_id   = case when par[i] > 0 then t_of[par[i]] end,
           sequence_id = case when grp[i] > 0 then g_seq[grp[i]] end,
           sort_order  = nl[i]
     where x.id = t_of[i]
       and (x.parent_id, x.sequence_id, x.sort_order) is distinct from
           (case when par[i] > 0 then t_of[par[i]] end, case when grp[i] > 0 then g_seq[grp[i]] end, nl[i]::double precision);
  end loop;

  -- runs that are gone: detach retired rows first (the FK would delete them)
  update mneme.tasks x set sequence_id = null
   where x.sequence_id in (select s.id from mneme.task_sequences s where s.note_id = p_note and not (s.id = any (g_seq)));
  delete from mneme.task_sequences s where s.note_id = p_note and not (s.id = any (g_seq));

  perform set_config('mneme.note_sync', v_prev, true);
end
$$;

create or replace function mneme.add_subtask(p_parent uuid, p_title text, p_sequence uuid default null)
returns void
language plpgsql
set search_path = ''
as $$
declare
  p         mneme.tasks;
  v_title   text := left(btrim(regexp_replace(coalesce(p_title, ''), '\s+', ' ', 'g')), 500);
  v_content text;
  v_lines   text[];
  v_n       integer;
  v_slot    record;
  v_line    text;
  v_due     record;
begin
  if v_title = '' then raise exception 'task title is empty' using errcode = '22023'; end if;
  select * into p from mneme.tasks where id = p_parent and user_id = (select auth.uid()) for update;
  if not found then raise exception 'task not found' using errcode = 'P0002'; end if;

  if p.source = 'standalone' then
    if p_sequence is not null then
      insert into mneme.tasks (source, title, sequence_id) values ('standalone', v_title, p_sequence);
    else
      insert into mneme.tasks (source, title, parent_id) values ('standalone', v_title, p_parent);
    end if;
    return;
  end if;

  select * into v_due from mneme.parse_due(v_title, mneme.user_today());
  if v_due.due_date is not null then v_title := v_due.title; end if;
  select n.content into v_content from mneme.notes n where n.id = p.note_id for update;
  v_lines := string_to_array(v_content, E'\n');
  if p_sequence is not null then
    select * into v_slot from mneme.step_slot(v_lines, p_sequence, v_content);
    v_line := repeat(' ', v_slot.v_indent) || v_slot.v_number || '. [ ] ' || v_title;
  else
    v_n := mneme.task_line_in(v_content, p.line_key, p.position);
    if v_n is null then raise exception 'task line not found in note' using errcode = 'P0002'; end if;
    select * into v_slot from mneme.child_slot(v_lines, v_n);
    v_line := repeat(' ', v_slot.v_indent) || '- [ ] ' || v_title;
  end if;
  v_lines := v_lines[1:v_slot.v_after] || v_line || v_lines[v_slot.v_after + 1:];
  update mneme.notes set content = array_to_string(v_lines, E'\n') where id = p.note_id;
  if v_due.due_date is not null then
    update mneme.tasks set due_date = v_due.due_date, due_time = v_due.due_time
     where id = (select t.id from mneme.tasks t where t.note_id = p.note_id and t.removed_at is null
                   and t.line_key = left(lower(v_title), 500) order by t.created_at desc limit 1);
  end if;
end
$$;

-- ---------------------------------------------------------------- reads --
create or replace view mneme.tasks_active
with (security_invoker = true) as
select t.id, t.user_id, t.note_id, t.source, t.title, t.status, t.priority,
       t.due_date, t.position, t.created_at, t.completed_at,
       n.public_id as note_public_id,
       n.title     as note_title,
       t.due_time,
       t.state, t.parent_id, t.sequence_id, t.sort_order,
       (t.state not in ('done', 'cancelled') and mneme.task_blocked(t.id)) as blocked,
       (select count(*) from mneme.tasks c where c.parent_id = t.id and c.removed_at is null)::int as child_count,
       (select count(*) from mneme.tasks c where c.parent_id = t.id and c.removed_at is null
           and c.state in ('done', 'cancelled'))::int as child_resolved,
       t.updated_at,
       case when t.parent_id is null then t.id else mneme.task_root_id(t.id) end as root_id,
       p.title as parent_title,
       mneme.task_code(t.id) as code,
       t.snoozed_until,
       (t.snoozed_until is not null and t.snoozed_until > mneme.user_today(t.user_id)) as snoozed
from mneme.tasks t
left join mneme.notes n on n.id = t.note_id
left join mneme.tasks p on p.id = t.parent_id
where t.removed_at is null
  and (t.note_id is null or n.deleted_at is null)
  and mneme.task_ancestors_live(t.parent_id);
grant select on mneme.tasks_active to authenticated;
create or replace function mneme.list_tasks(p_bucket text default 'today', p_limit integer default 200)
returns setof mneme.tasks_active
language plpgsql
stable
set search_path = ''
as $$
declare
  v_tz    text;
  v_today date;
begin
  select s.timezone into v_tz from mneme.settings s where s.user_id = (select auth.uid());
  v_today := (now() at time zone coalesce(v_tz, 'UTC'))::date;
  p_limit := least(greatest(coalesce(p_limit, 200), 1), 500);

  if p_bucket = 'completed' then
    return query select * from mneme.tasks_active t where t.status = 'done' and t.parent_id is null
                 order by t.completed_at desc nulls last limit p_limit;
  elsif p_bucket = 'snoozed' then
    return query select * from mneme.tasks_active t where t.status = 'open' and t.snoozed
                 order by t.snoozed_until, t.created_at limit p_limit;
  elsif p_bucket = 'today' then
    return query select * from mneme.tasks_active t
                 where t.status = 'open' and t.due_date <= v_today
                   and t.state <> 'on_hold' and not t.blocked and t.child_resolved = t.child_count and not t.snoozed
                 order by t.due_date, t.due_time nulls last, t.created_at limit p_limit;
  elsif p_bucket = 'upcoming' then
    return query select * from mneme.tasks_active t
                 where t.status = 'open' and t.due_date > v_today and t.parent_id is null and not t.snoozed
                 order by t.due_date, t.due_time nulls last, t.created_at limit p_limit;
  elsif p_bucket = 'no_date' then
    return query select * from mneme.tasks_active t
                 where t.status = 'open' and t.due_date is null and t.parent_id is null and not t.snoozed
                 order by t.created_at desc limit p_limit;
  else
    raise exception 'unknown bucket %', p_bucket using errcode = '22023';
  end if;
end
$$;

create or replace function mneme.due_task_count()
returns bigint
language plpgsql
stable
set search_path = ''
as $$
declare
  v_tz    text;
  v_today date;
begin
  select s.timezone into v_tz from mneme.settings s where s.user_id = (select auth.uid());
  v_today := (now() at time zone coalesce(v_tz, 'UTC'))::date;
  return (
    select count(*) from mneme.tasks_active t
    where t.status = 'open' and t.due_date is not null and t.due_date <= v_today
      and t.state <> 'on_hold' and not t.blocked and t.child_resolved = t.child_count and not t.snoozed
  );
end
$$;

create or replace function mneme.board_data(p_canvas uuid default null, p_done boolean default false)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with recursive roots as (
    select a.id from mneme.tasks_active a
    where a.parent_id is null
      and (p_done or a.status = 'open')
      and not a.snoozed
      and case when p_canvas is null
               then not exists (select 1 from mneme.canvas_tasks ct where ct.task_id = a.id)
               else exists (select 1 from mneme.canvas_tasks ct where ct.task_id = a.id and ct.canvas_id = p_canvas) end
  ),
  tree as (
    select id from roots
    union all
    select c.id from mneme.tasks c join tree on c.parent_id = tree.id
  ),
  rows as (select a.* from mneme.tasks_active a where a.id in (select id from tree)),
  canv as (
    select ct.task_id, jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name) order by c.sort_order, c.name) as list
    from mneme.canvas_tasks ct join mneme.canvases c on c.id = ct.canvas_id
    group by ct.task_id
  )
  select jsonb_build_object(
    'tasks', coalesce((select jsonb_agg(to_jsonb(r) order by r.created_at, r.id) from rows r), '[]'::jsonb),
    'sequences', coalesce((
      select jsonb_agg(jsonb_build_object('id', s.id, 'task_id', s.task_id, 'title', s.title, 'sort_order', s.sort_order,
                                          'created_at', s.created_at, 'note_id', s.note_id)
                       order by s.sort_order, s.created_at, s.id)
      from mneme.task_sequences s
      where s.task_id in (select id from rows)
         or (s.task_id is null and exists (select 1 from rows r where r.sequence_id = s.id))), '[]'::jsonb),
    'links', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'kind', l.kind, 'from_task_id', l.from_task_id, 'to_task_id', l.to_task_id,
               'other', jsonb_build_object('id', o.id, 'title', o.title, 'state', o.state, 'root_id', o.root_id,
                                           'canvases', coalesce((select list from canv where canv.task_id = o.root_id), '[]'::jsonb)))
             order by l.created_at)
      from mneme.task_links l
      join mneme.tasks_active o
        on o.id = case when l.from_task_id in (select id from rows) then l.to_task_id else l.from_task_id end
      where l.from_task_id in (select id from rows) or l.to_task_id in (select id from rows)), '[]'::jsonb),
    'canvas_ids', '[]'::jsonb,
    'positions', coalesce((
      select jsonb_object_agg(p.task_id, jsonb_build_object('x', p.x, 'y', p.y))
      from mneme.board_positions p
      where p.board = coalesce(p_canvas::text, 'inbox') and p.task_id in (select id from rows)), '{}'::jsonb)
  )
$$;

-- ------------------------------------------------------------------ backup --
-- Everything of one account except the password vault, as one JSON document
-- that import_backup() turns back into the same knowledge base elsewhere.
create or replace function mneme.backup_data(p_user uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'format', 'mneme-backup', 'version', 1, 'exported_at', now(),
    'settings', (select to_jsonb(s) - 'user_id' - 'last_digest_on' - 'last_backup_on' - 'created_at' - 'updated_at'
                 from mneme.settings s where s.user_id = p_user),
    'notes', coalesce((select jsonb_agg(to_jsonb(n) - 'user_id' - 'version' order by n.created_at, n.id)
                       from mneme.notes n where n.user_id = p_user), '[]'::jsonb),
    'tags', coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name)) from mneme.tags g where g.user_id = p_user), '[]'::jsonb),
    'note_tags', coalesce((select jsonb_agg(to_jsonb(rw) - 'user_id') from mneme.note_tags rw where rw.user_id = p_user), '[]'::jsonb),
    'note_links', coalesce((select jsonb_agg(to_jsonb(rw) - 'user_id' - 'id') from mneme.note_links rw where rw.user_id = p_user), '[]'::jsonb),
    'note_revisions', coalesce((select jsonb_agg(to_jsonb(rw) - 'user_id' - 'id') from mneme.note_revisions rw where rw.user_id = p_user), '[]'::jsonb),
    'note_views', coalesce((select jsonb_agg(to_jsonb(rw) - 'user_id') from mneme.note_views rw where rw.user_id = p_user), '[]'::jsonb),
    'tasks', coalesce((select jsonb_agg(to_jsonb(t) - 'user_id' - 'reminder_sent_at' order by t.created_at, t.id)
                       from mneme.tasks t where t.user_id = p_user and t.removed_at is null), '[]'::jsonb),
    'task_sequences', coalesce((select jsonb_agg(to_jsonb(rw) - 'user_id') from mneme.task_sequences rw where rw.user_id = p_user), '[]'::jsonb),
    'task_links', coalesce((select jsonb_agg(to_jsonb(rw) - 'user_id' - 'id') from mneme.task_links rw where rw.user_id = p_user), '[]'::jsonb),
    'canvases', coalesce((select jsonb_agg(to_jsonb(rw) - 'user_id') from mneme.canvases rw where rw.user_id = p_user), '[]'::jsonb),
    'canvas_tasks', coalesce((select jsonb_agg(to_jsonb(rw) - 'user_id') from mneme.canvas_tasks rw where rw.user_id = p_user), '[]'::jsonb),
    'board_positions', coalesce((select jsonb_agg(to_jsonb(rw) - 'user_id') from mneme.board_positions rw where rw.user_id = p_user), '[]'::jsonb),
    'habits', coalesce((select jsonb_agg(to_jsonb(rw) - 'user_id') from mneme.habits rw where rw.user_id = p_user), '[]'::jsonb),
    'habit_logs', coalesce((select jsonb_agg(to_jsonb(rw) - 'user_id') from mneme.habit_logs rw where rw.user_id = p_user), '[]'::jsonb),
    'saved_searches', coalesce((select jsonb_agg(to_jsonb(rw) - 'user_id' - 'id') from mneme.saved_searches rw where rw.user_id = p_user), '[]'::jsonb)
  )
$$;

-- the signed-in user's own backup (Settings → Backup)
create or replace function mneme.export_backup()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$ select mneme.backup_data((select auth.uid())) where (select auth.uid()) is not null $$;

-- keep an imported N-YYMMDD-NNN id, and move that day's counter past it
create or replace function mneme.claim_public_id(p_public_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  m text[] := regexp_match(p_public_id, '^N-(\d{6})-(\d{3,})$');
begin
  if m is null or auth.uid() is null then return; end if;
  insert into mneme.note_counters as c (user_id, day, last_seq)
  values (auth.uid(), to_date(m[1], 'YYMMDD'), m[2]::int)
  on conflict (user_id, day) do update set last_seq = greatest(c.last_seq, excluded.last_seq);
end
$$;
revoke all on function mneme.claim_public_id(text) from public, anon;
grant execute on function mneme.claim_public_id(text) to authenticated;

-- Rebuild a backup into the signed-in (empty) account. Note ids (N-…) are
-- kept, so links keep working; every other row gets a fresh id.
create or replace function mneme.import_backup(p jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_uid  uuid := (select auth.uid());
  r      jsonb;
  v_new  uuid;
  v_left integer;
  v_prev integer := -1;
  n_notes integer := 0; n_tasks integer := 0;
begin
  if v_uid is null then raise exception 'not signed in' using errcode = '28000'; end if;
  if coalesce(p->>'format', '') <> 'mneme-backup' then
    raise exception 'That file isn’t a Mneme backup.';
  end if;
  if exists (select 1 from mneme.notes where user_id = v_uid) or exists (select 1 from mneme.tasks where user_id = v_uid) then
    raise exception 'Import needs an empty account — this one already has notes or tasks.';
  end if;
  perform set_config('mneme.import', 'on', true);
  create temp table if not exists imp_map (kind text, old uuid, new uuid, primary key (kind, old)) on commit drop;
  truncate imp_map;

  -- settings
  insert into mneme.settings (user_id) values (v_uid) on conflict (user_id) do nothing;
  if jsonb_typeof(p->'settings') = 'object' then
    update mneme.settings s set
      timezone = coalesce(p->'settings'->>'timezone', s.timezone),
      theme = coalesce(p->'settings'->>'theme', s.theme),
      reminders_enabled = coalesce((p->'settings'->>'reminders_enabled')::boolean, s.reminders_enabled),
      reminder_lead_minutes = coalesce((p->'settings'->>'reminder_lead_minutes')::int, s.reminder_lead_minutes),
      reminder_morning_time = coalesce((p->'settings'->>'reminder_morning_time')::time, s.reminder_morning_time),
      show_streaks = coalesce((p->'settings'->>'show_streaks')::boolean, s.show_streaks),
      backup_enabled = coalesce((p->'settings'->>'backup_enabled')::boolean, s.backup_enabled),
      backup_weekday = coalesce((p->'settings'->>'backup_weekday')::smallint, s.backup_weekday)
    where s.user_id = v_uid;
  end if;

  -- notes: their text re-derives inline tags, links and note tasks
  for r in select value from jsonb_array_elements(coalesce(p->'notes', '[]')) order by (value->>'created_at')::timestamptz loop
    insert into mneme.notes (public_id, title, content, note_type, is_starred, paper_ref, created_at, updated_at, archived_at, deleted_at, journal_date)
    values (coalesce(r->>'public_id', ''), r->>'title', coalesce(r->>'content', ''), coalesce(r->>'note_type', 'capture'),
            coalesce((r->>'is_starred')::boolean, false), r->>'paper_ref',
            coalesce((r->>'created_at')::timestamptz, now()), coalesce((r->>'updated_at')::timestamptz, now()),
            (r->>'archived_at')::timestamptz, (r->>'deleted_at')::timestamptz, (r->>'journal_date')::date)
    returning id into v_new;
    insert into imp_map values ('note', (r->>'id')::uuid, v_new);
    n_notes := n_notes + 1;
  end loop;

  insert into mneme.note_links (source_note_id, target_note_id, relationship_type)
  select s.new, t.new, coalesce(l->>'relationship_type', 'related')
  from jsonb_array_elements(coalesce(p->'note_links', '[]')) l
  join imp_map s on s.kind = 'note' and s.old = (l->>'source_note_id')::uuid
  join imp_map t on t.kind = 'note' and t.old = (l->>'target_note_id')::uuid
  on conflict (source_note_id, target_note_id) do update set relationship_type = excluded.relationship_type;

  -- hand-added tags (inline ones came back with the text)
  insert into mneme.tags (user_id, name)
  select distinct v_uid, g->>'name'
  from jsonb_array_elements(coalesce(p->'note_tags', '[]')) x
  join jsonb_array_elements(coalesce(p->'tags', '[]')) g on g->>'id' = x->>'tag_id'
  where x->>'source' = 'manual'
  on conflict (user_id, name) do nothing;
  insert into mneme.note_tags (note_id, tag_id, source)
  select m.new, tg.id, 'manual'
  from jsonb_array_elements(coalesce(p->'note_tags', '[]')) x
  join jsonb_array_elements(coalesce(p->'tags', '[]')) g on g->>'id' = x->>'tag_id'
  join imp_map m on m.kind = 'note' and m.old = (x->>'note_id')::uuid
  join mneme.tags tg on tg.user_id = v_uid and tg.name = g->>'name'
  where x->>'source' = 'manual'
  on conflict (note_id, tag_id) do nothing;

  insert into mneme.note_revisions (note_id, title, content, saved_at)
  select m.new, x->>'title', x->>'content', (x->>'saved_at')::timestamptz
  from jsonb_array_elements(coalesce(p->'note_revisions', '[]')) x
  join imp_map m on m.kind = 'note' and m.old = (x->>'note_id')::uuid;
  insert into mneme.note_views (note_id, viewed_at)
  select m.new, (x->>'viewed_at')::timestamptz
  from jsonb_array_elements(coalesce(p->'note_views', '[]')) x
  join imp_map m on m.kind = 'note' and m.old = (x->>'note_id')::uuid
  on conflict do nothing;

  -- tasks written in notes: already re-created from the text; bring back what only the database knew
  for r in select value from jsonb_array_elements(coalesce(p->'tasks', '[]')) where value->>'source' = 'note' loop
    update mneme.tasks t set
      due_date = (r->>'due_date')::date, due_time = (r->>'due_time')::time, priority = r->>'priority',
      state = coalesce(r->>'state', t.state), line_marker = coalesce(r->>'line_marker', t.line_marker),
      snoozed_until = (r->>'snoozed_until')::date, completed_at = (r->>'completed_at')::timestamptz,
      created_at = coalesce((r->>'created_at')::timestamptz, t.created_at),
      cascade_cancelled = coalesce((r->>'cascade_cancelled')::boolean, false)
    from imp_map m
    where m.kind = 'note' and m.old = (r->>'note_id')::uuid
      and t.note_id = m.new and t.source = 'note' and t.removed_at is null
      and t.position = (r->>'position')::int and t.line_key is not distinct from r->>'line_key'
    returning t.id into v_new;
    if v_new is not null then
      insert into imp_map values ('task', (r->>'id')::uuid, v_new) on conflict do nothing;
      n_tasks := n_tasks + 1;
    end if;
    v_new := null;
  end loop;

  -- standalone tasks, parents before children
  loop
    v_left := 0;
    for r in select value from jsonb_array_elements(coalesce(p->'tasks', '[]')) x
              where value->>'source' = 'standalone'
                and not exists (select 1 from imp_map m where m.kind = 'task' and m.old = (x.value->>'id')::uuid)
    loop
      if r->>'parent_id' is not null
         and not exists (select 1 from imp_map m where m.kind = 'task' and m.old = (r->>'parent_id')::uuid) then
        v_left := v_left + 1;
        continue;
      end if;
      insert into mneme.tasks (source, title, state, priority, due_date, due_time, parent_id, sort_order,
                               created_at, completed_at, snoozed_until, cascade_cancelled)
      values ('standalone', r->>'title', coalesce(r->>'state', 'open'), r->>'priority', (r->>'due_date')::date, (r->>'due_time')::time,
              (select m.new from imp_map m where m.kind = 'task' and m.old = (r->>'parent_id')::uuid),
              coalesce((r->>'sort_order')::double precision, 0), coalesce((r->>'created_at')::timestamptz, now()),
              (r->>'completed_at')::timestamptz, (r->>'snoozed_until')::date, coalesce((r->>'cascade_cancelled')::boolean, false))
      returning id into v_new;
      insert into imp_map values ('task', (r->>'id')::uuid, v_new);
      n_tasks := n_tasks + 1;
    end loop;
    exit when v_left = 0 or v_left = v_prev;   -- done, or only orphans left
    v_prev := v_left;
  end loop;

  -- standalone sequences, then their steps join them
  for r in select value from jsonb_array_elements(coalesce(p->'task_sequences', '[]')) where value->>'note_id' is null loop
    insert into mneme.task_sequences (task_id, title, sort_order, created_at)
    select m.new, r->>'title', coalesce((r->>'sort_order')::double precision, 0), coalesce((r->>'created_at')::timestamptz, now())
    from imp_map m where m.kind = 'task' and m.old = (r->>'task_id')::uuid
    returning id into v_new;
    if v_new is not null then insert into imp_map values ('seq', (r->>'id')::uuid, v_new); end if;
    v_new := null;
  end loop;
  update mneme.tasks t set sequence_id = s.new
  from jsonb_array_elements(coalesce(p->'tasks', '[]')) x
  join imp_map m on m.kind = 'task' and m.old = (x->>'id')::uuid
  join imp_map s on s.kind = 'seq' and s.old = (x->>'sequence_id')::uuid
  where t.id = m.new and x->>'source' = 'standalone';

  insert into mneme.task_links (from_task_id, to_task_id, kind)
  select f.new, t.new, coalesce(l->>'kind', 'blocks')
  from jsonb_array_elements(coalesce(p->'task_links', '[]')) l
  join imp_map f on f.kind = 'task' and f.old = (l->>'from_task_id')::uuid
  join imp_map t on t.kind = 'task' and t.old = (l->>'to_task_id')::uuid
  on conflict do nothing;

  -- canvases, their tasks, and where boxes sit on each board
  for r in select value from jsonb_array_elements(coalesce(p->'canvases', '[]')) loop
    insert into mneme.canvases (name, sort_order, created_at)
    values (r->>'name', coalesce((r->>'sort_order')::double precision, 0), coalesce((r->>'created_at')::timestamptz, now()))
    on conflict do nothing
    returning id into v_new;
    if v_new is not null then insert into imp_map values ('canvas', (r->>'id')::uuid, v_new); end if;
    v_new := null;
  end loop;
  insert into mneme.canvas_tasks (canvas_id, task_id)
  select c.new, t.new
  from jsonb_array_elements(coalesce(p->'canvas_tasks', '[]')) x
  join imp_map c on c.kind = 'canvas' and c.old = (x->>'canvas_id')::uuid
  join imp_map t on t.kind = 'task' and t.old = (x->>'task_id')::uuid
  where not exists (select 1 from mneme.tasks k where k.id = t.new and k.parent_id is not null)
  on conflict do nothing;
  insert into mneme.board_positions (board, task_id, x, y)
  select case when x->>'board' = 'inbox' then 'inbox' else c.new::text end, t.new, (x->>'x')::real, (x->>'y')::real
  from jsonb_array_elements(coalesce(p->'board_positions', '[]')) x
  join imp_map t on t.kind = 'task' and t.old = (x->>'task_id')::uuid
  left join imp_map c on c.kind = 'canvas' and c.old = case when x->>'board' <> 'inbox' then (x->>'board')::uuid end
  where x->>'board' = 'inbox' or c.new is not null
  on conflict do nothing;

  -- habits
  for r in select value from jsonb_array_elements(coalesce(p->'habits', '[]')) loop
    insert into mneme.habits (name, target, unit, days, position, created_at, archived_at)
    values (r->>'name', coalesce((r->>'target')::int, 1), r->>'unit', coalesce((r->>'days')::smallint, 127),
            coalesce((r->>'position')::int, 0), coalesce((r->>'created_at')::timestamptz, now()), (r->>'archived_at')::timestamptz)
    returning id into v_new;
    insert into imp_map values ('habit', (r->>'id')::uuid, v_new);
  end loop;
  insert into mneme.habit_logs (habit_id, day, value)
  select m.new, (x->>'day')::date, (x->>'value')::int
  from jsonb_array_elements(coalesce(p->'habit_logs', '[]')) x
  join imp_map m on m.kind = 'habit' and m.old = (x->>'habit_id')::uuid
  on conflict do nothing;

  insert into mneme.saved_searches (name, query, pinned, position, created_at)
  select x->>'name', x->>'query', coalesce((x->>'pinned')::boolean, false), coalesce((x->>'position')::int, 0),
         coalesce((x->>'created_at')::timestamptz, now())
  from jsonb_array_elements(coalesce(p->'saved_searches', '[]')) x;

  perform set_config('mneme.import', '', true);
  return jsonb_build_object('notes', n_notes, 'tasks', n_tasks);
end
$$;

-- Weekly emailed backup: due on the chosen weekday at the morning time, once.
create or replace function mneme.backups_due()
returns table (user_id uuid, email text, local_date date)
language sql
stable
security definer
set search_path = ''
as $$
  select s.user_id, u.email, (now() at time zone coalesce(s.timezone, 'UTC'))::date
  from mneme.settings s
  join auth.users u on u.id = s.user_id
  where s.backup_enabled
    and extract(isodow from (now() at time zone coalesce(s.timezone, 'UTC')))::int = s.backup_weekday
    and (now() at time zone coalesce(s.timezone, 'UTC')) >= ((now() at time zone coalesce(s.timezone, 'UTC'))::date + s.reminder_morning_time)
    and (s.last_backup_on is null or s.last_backup_on < (now() at time zone coalesce(s.timezone, 'UTC'))::date)
$$;

create or replace function mneme.mark_backup_sent(p_user_ids uuid[])
returns void
language sql
security definer
set search_path = ''
as $$
  update mneme.settings s set last_backup_on = (now() at time zone coalesce(s.timezone, 'UTC'))::date
   where s.user_id = any (coalesce(p_user_ids, '{}'));
$$;

revoke all on function mneme.backup_data(uuid)            from public, anon, authenticated;
revoke all on function mneme.backups_due()                from public, anon, authenticated;
revoke all on function mneme.mark_backup_sent(uuid[])     from public, anon, authenticated;
revoke all on function mneme.export_backup()              from public, anon;
revoke all on function mneme.import_backup(jsonb)         from public, anon;
grant execute on function mneme.backup_data(uuid)         to service_role;
grant execute on function mneme.backups_due()             to service_role;
grant execute on function mneme.mark_backup_sent(uuid[])  to service_role;
grant execute on function mneme.export_backup()           to authenticated;
grant execute on function mneme.import_backup(jsonb)      to authenticated;

commit;
