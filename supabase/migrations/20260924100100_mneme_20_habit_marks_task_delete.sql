-- =============================================================================
-- Mneme 20 — habit calendar marks, a streaks on/off setting, and deleting any
-- task (not just standalone ones).
--   settings.show_streaks      hide 🔥 streaks everywhere when false
--   calendar_month()           + habits_due / habits_met per day (days up to
--                              the caller's today; return type changes, so it
--                              is dropped and recreated)
--   delete_task(id)            standalone -> row deleted; from a note -> its
--                              "- [ ]" line is removed from the note text (the
--                              sync trigger then retires the task). The note's
--                              revision history keeps the old text.
--   clear_completed_tasks()    delete_task() for every done task; returns count
-- Additive; nothing in `public` (Argus) is touched.
-- =============================================================================
begin;

alter table mneme.settings add column if not exists show_streaks boolean not null default true;

drop function if exists mneme.calendar_month(date, date);
create function mneme.calendar_month(p_from date, p_to date)
returns table (
  day date, notes integer, meetings integer,
  scheduled integer, open_tasks integer, done_tasks integer, journal boolean,
  habits_due integer, habits_met integer
)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_tz    text;
  v_today date;
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 62 then
    raise exception 'calendar range must be at most 62 days' using errcode = '22023';
  end if;
  select s.timezone into v_tz from mneme.settings s where s.user_id = (select auth.uid());
  v_tz := coalesce(v_tz, 'UTC');
  v_today := (now() at time zone v_tz)::date;

  return query
  with n as (
    select (x.created_at at time zone v_tz)::date as d,
           count(*)::int as notes,
           count(*) filter (where x.note_type = 'meeting')::int as meetings
    from mneme.notes x
    where x.deleted_at is null and x.journal_date is null
      and x.created_at >= (p_from::timestamp at time zone v_tz)
      and x.created_at <  ((p_to + 1)::timestamp at time zone v_tz)
    group by 1
  ), j as (
    select x.journal_date as d from mneme.notes x
    where x.deleted_at is null and x.journal_date between p_from and p_to
  ), t as (
    select x.due_date as d,
           count(*) filter (where x.status = 'open' and x.due_time is not null)::int as scheduled,
           count(*) filter (where x.status = 'open')::int as open_tasks,
           count(*) filter (where x.status = 'done')::int as done_tasks
    from mneme.tasks_active x
    where x.due_date between p_from and p_to
    group by 1
  ), h as (
    -- each active habit on each of its due days that it already existed on
    select g::date as d,
           count(*)::int as habits_due,
           count(*) filter (where coalesce(l.value, 0) >= hb.target)::int as habits_met
    from generate_series(p_from::timestamp, least(p_to, v_today)::timestamp, interval '1 day') g
    join mneme.habits hb
      on hb.archived_at is null
     and mneme.habit_due(hb.days, g::date)
     and (hb.created_at at time zone v_tz)::date <= g::date
    left join mneme.habit_logs l on l.habit_id = hb.id and l.day = g::date
    group by 1
  ), days as (
    select d from n union select d from j union select d from t union select d from h
  )
  select days.d,
         coalesce(n.notes, 0), coalesce(n.meetings, 0),
         coalesce(t.scheduled, 0), coalesce(t.open_tasks, 0), coalesce(t.done_tasks, 0),
         j.d is not null,
         coalesce(h.habits_due, 0), coalesce(h.habits_met, 0)
  from days
  left join n on n.d = days.d
  left join j on j.d = days.d
  left join t on t.d = days.d
  left join h on h.d = days.d
  order by 1;
end
$$;

create or replace function mneme.delete_task(p_task_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  t         mneme.tasks;
  v_content text;
  v_lines   text[];
  v_line_no integer;
begin
  select * into t from mneme.tasks
   where id = p_task_id and user_id = (select auth.uid()) for update;
  if not found then
    raise exception 'task not found' using errcode = 'P0002';
  end if;

  if t.source = 'standalone' then
    delete from mneme.tasks where id = t.id;
    return;
  end if;

  select n.content into v_content from mneme.notes n where n.id = t.note_id for update;
  -- same line lookup as set_task_done(): exact position first, else nearest same text
  select l.n into v_line_no from mneme.note_task_lines(v_content) l
   where l.n = t.position and l.key = t.line_key;
  if v_line_no is null then
    select l.n into v_line_no from mneme.note_task_lines(v_content) l
     where l.key = t.line_key order by abs(l.n - t.position) limit 1;
  end if;
  if v_line_no is null then
    -- the line is already gone; just retire the row
    update mneme.tasks set removed_at = now() where id = t.id;
    return;
  end if;

  v_lines := string_to_array(v_content, E'\n');
  v_lines := v_lines[1:v_line_no - 1] || v_lines[v_line_no + 1:];
  update mneme.notes set content = array_to_string(v_lines, E'\n') where id = t.note_id;
end
$$;

create or replace function mneme.clear_completed_tasks()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  r record;
  v_n integer := 0;
begin
  -- bottom-up within a note, so removing a line never shifts one still to come
  for r in
    select t.id from mneme.tasks t
    where t.user_id = (select auth.uid()) and t.status = 'done' and t.removed_at is null
      and (t.note_id is null or exists (   -- what the Completed list shows: never touch trashed notes
            select 1 from mneme.notes n where n.id = t.note_id and n.deleted_at is null))
    order by t.note_id nulls first, t.position desc
  loop
    perform mneme.delete_task(r.id);
    v_n := v_n + 1;
  end loop;
  return v_n;
end
$$;

revoke all on function mneme.calendar_month(date, date) from public, anon;
revoke all on function mneme.delete_task(uuid) from public, anon;
revoke all on function mneme.clear_completed_tasks() from public, anon;
grant execute on function mneme.calendar_month(date, date) to authenticated;
grant execute on function mneme.delete_task(uuid) to authenticated;
grant execute on function mneme.clear_completed_tasks() to authenticated;

commit;
