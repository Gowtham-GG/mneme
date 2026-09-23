-- =============================================================================
-- Mneme 17 — calendar_month(): per-day marks for the Home calendar.
-- One row per local day in [p_from, p_to] that has anything on it:
--   notes     notes written that day (created_at in the user's timezone; trash
--             excluded, archive included — same as list_notes' 'all')
--   meetings  of those, notes typed 'meeting'
--   scheduled open tasks due that day WITH a due_time (appointments/schedule)
--   open_tasks / done_tasks  every task due that day, by status
-- SECURITY INVOKER: RLS scopes it to the caller, like every other read RPC.
-- Additive; nothing in `public` (Argus) is touched.
-- =============================================================================
begin;

create or replace function mneme.calendar_month(p_from date, p_to date)
returns table (
  day date, notes integer, meetings integer,
  scheduled integer, open_tasks integer, done_tasks integer
)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_tz text;
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 62 then
    raise exception 'calendar range must be at most 62 days' using errcode = '22023';
  end if;
  select s.timezone into v_tz from mneme.settings s where s.user_id = (select auth.uid());
  v_tz := coalesce(v_tz, 'UTC');

  return query
  with n as (
    select (x.created_at at time zone v_tz)::date as d,
           count(*)::int as notes,
           count(*) filter (where x.note_type = 'meeting')::int as meetings
    from mneme.notes x
    where x.deleted_at is null
      and x.created_at >= (p_from::timestamp at time zone v_tz)
      and x.created_at <  ((p_to + 1)::timestamp at time zone v_tz)
    group by 1
  ), t as (
    select x.due_date as d,
           count(*) filter (where x.status = 'open' and x.due_time is not null)::int as scheduled,
           count(*) filter (where x.status = 'open')::int as open_tasks,
           count(*) filter (where x.status = 'done')::int as done_tasks
    from mneme.tasks_active x
    where x.due_date between p_from and p_to
    group by 1
  )
  select coalesce(n.d, t.d),
         coalesce(n.notes, 0), coalesce(n.meetings, 0),
         coalesce(t.scheduled, 0), coalesce(t.open_tasks, 0), coalesce(t.done_tasks, 0)
  from n full join t on t.d = n.d
  order by 1;
end
$$;

revoke all on function mneme.calendar_month(date, date) from public, anon;
grant execute on function mneme.calendar_month(date, date) to authenticated;

commit;
