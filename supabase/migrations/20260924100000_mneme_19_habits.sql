-- =============================================================================
-- Mneme 19 — habit tracker.
--   habits      name, daily target (1 = a plain yes/no habit, >1 = a count such
--               as 8 glasses), optional unit, and which weekdays it is due on
--               (bitmask, Monday = 1 … Sunday = 64; 127 = every day)
--   habit_logs  one row per habit per local day that has progress
--   bump_habit(habit, day, delta)  atomic +/- (rapid taps never lose a count);
--                                  a count of 0 deletes the row
--   habits_for_day(day)            the day's due habits with progress + streak
-- Streak = consecutive DUE days that met the target, ending today; today not
-- being met yet does not break it (the day isn't over). Days a habit isn't
-- scheduled on are skipped, never counted as misses.
-- Additive; nothing in `public` (Argus) is touched.
-- =============================================================================
begin;

create table if not exists mneme.habits (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name        text not null check (char_length(btrim(name)) between 1 and 80),
  target      integer not null default 1 check (target between 1 and 1000),
  unit        text check (unit is null or char_length(unit) <= 20),
  days        smallint not null default 127 check (days between 1 and 127),
  position    integer not null default 0,
  created_at  timestamptz not null default now(),
  archived_at timestamptz,
  constraint habits_id_user_key unique (id, user_id)
);

create table if not exists mneme.habit_logs (
  habit_id uuid not null,
  user_id  uuid not null default auth.uid() references auth.users(id) on delete cascade,
  day      date not null,
  value    integer not null check (value between 1 and 100000),
  primary key (habit_id, day),
  foreign key (habit_id, user_id) references mneme.habits (id, user_id) on delete cascade
);

create index if not exists habits_user_idx on mneme.habits (user_id, position) where archived_at is null;
create index if not exists habit_logs_user_day_idx on mneme.habit_logs (user_id, day);

do $$
declare t text;
begin
  foreach t in array array['habits', 'habit_logs'] loop
    execute format('alter table mneme.%I enable row level security', t);
    execute format('drop policy if exists %I on mneme.%I', t || '_owner', t);
    execute format(
      'create policy %I on mneme.%I for all to authenticated
         using (user_id = (select auth.uid()))
         with check (user_id = (select auth.uid()))',
      t || '_owner', t);
  end loop;
end $$;

grant select, insert, update, delete on mneme.habits, mneme.habit_logs to authenticated;

-- is `day` one of the habit's weekdays?
create or replace function mneme.habit_due(p_days smallint, p_day date)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select (p_days & (1 << (extract(isodow from p_day)::int - 1))) <> 0
$$;

create or replace function mneme.bump_habit(p_habit uuid, p_day date, p_delta integer)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_uid   uuid := (select auth.uid());
  v_tz    text;
  v_value integer;
begin
  if v_uid is null then raise exception 'not signed in' using errcode = '28000'; end if;
  select s.timezone into v_tz from mneme.settings s where s.user_id = v_uid;
  if p_day is null or p_day > (now() at time zone coalesce(v_tz, 'UTC'))::date + 1 then
    raise exception 'cannot log a future day' using errcode = '22023';
  end if;
  if not exists (select 1 from mneme.habits h where h.id = p_habit and h.user_id = v_uid) then
    raise exception 'habit not found' using errcode = 'P0002';
  end if;

  p_delta := coalesce(p_delta, 0);
  if p_delta > 0 then
    insert into mneme.habit_logs as l (habit_id, user_id, day, value)
    values (p_habit, v_uid, p_day, p_delta)
    on conflict (habit_id, day) do update set value = l.value + excluded.value
    returning l.value into v_value;
    return v_value;
  end if;
  if p_delta < 0 then
    -- going to (or below) zero means "nothing logged that day": drop the row
    delete from mneme.habit_logs l
    where l.habit_id = p_habit and l.day = p_day and l.value + p_delta <= 0;
    update mneme.habit_logs l set value = l.value + p_delta
    where l.habit_id = p_habit and l.day = p_day
    returning l.value into v_value;
    return coalesce(v_value, 0);
  end if;
  select l.value into v_value from mneme.habit_logs l where l.habit_id = p_habit and l.day = p_day;
  return coalesce(v_value, 0);
end
$$;

create or replace function mneme.habits_for_day(p_day date)
returns table (
  id uuid, name text, target integer, unit text, days smallint, "position" integer,
  due boolean, value integer, streak integer
)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_tz text;
begin
  select s.timezone into v_tz from mneme.settings s where s.user_id = (select auth.uid());
  v_tz := coalesce(v_tz, 'UTC');

  return query
  select h.id, h.name, h.target, h.unit, h.days, h.position,
         mneme.habit_due(h.days, p_day),
         coalesce(today.value, 0),
         coalesce(st.streak, 0)
  from mneme.habits h
  left join mneme.habit_logs today on today.habit_id = h.id and today.day = p_day
  left join lateral (
    with span as (
      select g::date as d
      from generate_series(
        p_day::timestamp,
        least(
          (h.created_at at time zone v_tz)::date,
          coalesce((select min(l.day) from mneme.habit_logs l where l.habit_id = h.id), p_day),
          p_day
        )::timestamp,
        interval '-1 day') g
      where mneme.habit_due(h.days, g::date)
        and g::date >= p_day - 1000
    ), marked as (
      select s.d, coalesce(l.value, 0) >= h.target as met
      from span s left join mneme.habit_logs l on l.habit_id = h.id and l.day = s.d
    )
    select count(*)::int as streak
    from marked m
    where m.met
      and m.d > coalesce((select max(x.d) from marked x where not x.met and x.d < p_day), '-infinity'::date)
  ) st on true
  where h.archived_at is null
    -- hidden on days before it existed (unless progress was backfilled there)
    and least((h.created_at at time zone v_tz)::date,
              coalesce((select min(l.day) from mneme.habit_logs l where l.habit_id = h.id), p_day)) <= p_day
  order by h.position, h.created_at;
end
$$;

revoke all on function mneme.habit_due(smallint, date) from public, anon;
revoke all on function mneme.bump_habit(uuid, date, integer) from public, anon;
revoke all on function mneme.habits_for_day(date) from public, anon;
grant execute on function mneme.habit_due(smallint, date) to authenticated;
grant execute on function mneme.bump_habit(uuid, date, integer) to authenticated;
grant execute on function mneme.habits_for_day(date) to authenticated;

commit;
