-- =============================================================================
-- Mneme 27 — habits become tasks with a rhythm.
--   A habit is no longer its own kind of thing: any main task made outside a
--   note can repeat (tasks.rhythm_days, weekday bitmask Monday = 1 … Sunday =
--   64), optionally as a daily count (rhythm_target / rhythm_unit, "8 glasses").
--   task_checkins     one row per task per local day: its count, an optional
--                     one-line note, or `skipped` (the habit was set aside)
--   tasks.step_days   a step's own weekdays inside its habit ("Upper body" on
--                     Mon, Wed, Fri under a daily "Gym"); null = whenever its parent is on
--   check_in(task, day, delta)   atomic +/- on a habit, or a tick on one of its
--                     steps; ticking a step that has steps of its own ticks them all
--   set_checkin_note(task, day, note)
--   habits_for_day(day)          the day's habits for the strip, with steps
--   parse_rhythm(text)           "stretch every day" / "gym every mon, wed and
--                     fri" / "… weekdays" / "… weekends" -> title + weekdays;
--                     a new task's title is read for it before typed dates
-- Rules
--   * A habit is a main task; it and everything under it have no dates (they'd
--     be cleared). Its steps (subtasks, sequences) are ticked per day, never
--     done/in progress; a routine counts for a day when every live step that is
--     on that day does.
--   * Sub-habits: a step can have its own days (only within its parent's) and a
--     count ("3 sets"). A step or habit is on a day when its days (and every
--     parent's) allow it and, if it has steps, at least one of them is on — so a
--     daily habit whose steps all skip Sunday rests on Sunday: not due, streak
--     untouched. Streaks stay on the habit itself.
--   * Statuses: on hold = paused, done = graduated, cancelled = retired. Days a
--     habit spends set aside are recorded as skipped when it comes back, so the
--     streak is frozen instead of broken. A habit's state is never rolled up
--     from its steps, and it can graduate with steps still open.
--   * Habits stay out of the task lists (Today/Upcoming/No date/Done) — they
--     live in the habit strip, on the Habits page and on the board.
--   * The old habits/habit_logs rows are moved into tasks/task_checkins
--     (removed habits become retired ones) and the old tables are dropped.
--   * Backups: version 2 carries task_checkins; a version-1 file's habits are
--     imported as habit tasks.
-- Nothing in `public` (Argus) is touched.
-- =============================================================================
begin;

-- ------------------------------------------------------------------ columns --
alter table mneme.tasks
  add column if not exists rhythm_days smallint check (rhythm_days between 1 and 127),
  add column if not exists rhythm_target integer not null default 1 check (rhythm_target between 1 and 1000),
  add column if not exists rhythm_unit text check (rhythm_unit is null or char_length(rhythm_unit) <= 20),
  add column if not exists rhythm_paused_on date,
  add column if not exists step_days smallint check (step_days between 1 and 127);

do $$ begin
  alter table mneme.tasks add constraint tasks_rhythm_main
    check (rhythm_days is null or (parent_id is null and source = 'standalone'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table mneme.tasks add constraint tasks_step_days_sub
    check (step_days is null or parent_id is not null);
exception when duplicate_object then null; end $$;

create index if not exists tasks_rhythm_idx on mneme.tasks (user_id) where rhythm_days is not null;

create table if not exists mneme.task_checkins (
  task_id uuid not null,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  day     date not null,
  value   integer not null default 0 check (value between 0 and 100000),
  note    text check (note is null or char_length(note) <= 500),
  skipped boolean not null default false,
  primary key (task_id, day),
  foreign key (task_id, user_id) references mneme.tasks (id, user_id) on delete cascade
);
create index if not exists task_checkins_user_day_idx on mneme.task_checkins (user_id, day);

alter table mneme.task_checkins enable row level security;
drop policy if exists task_checkins_owner on mneme.task_checkins;
create policy task_checkins_owner on mneme.task_checkins for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
grant select, insert, update, delete on mneme.task_checkins to authenticated;

-- ------------------------------------------------------------------ helpers --
-- the habit a task belongs to: itself, or the habit its tree hangs from
create or replace function mneme.task_habit_of(p_id uuid)
returns uuid
language sql
stable
set search_path = ''
as $$
  with recursive up as (
    select t.id, t.parent_id, t.rhythm_days, 0 as d from mneme.tasks t where t.id = p_id
    union all
    select p.id, p.parent_id, p.rhythm_days, u.d + 1 from mneme.tasks p join up u on p.id = u.parent_id where u.d < 100
  )
  select id from up where rhythm_days is not null order by d limit 1
$$;

-- The weekdays a habit or step is on, judged from below: its own days (the
-- habit's rhythm, a step's own days, or every day) narrowed to the days at least
-- one of its live steps is on. 0 = never (all its steps are on other days).
create or replace function mneme.routine_days(p_id uuid)
returns smallint
language plpgsql
stable
set search_path = ''
as $$
declare
  v_own  smallint;
  v_kids integer := 0;
  v_any  boolean := false;
  c      record;
begin
  select coalesce(t.rhythm_days, t.step_days, 127) into v_own from mneme.tasks t where t.id = p_id;
  if not found then return 0; end if;
  for c in
    select x.id from mneme.tasks x
    where x.parent_id = p_id and x.removed_at is null and x.state not in ('cancelled', 'on_hold', 'done')
  loop
    v_any := true;
    v_kids := v_kids | mneme.routine_days(c.id);
    exit when v_kids = 127;
  end loop;
  return (v_own & case when v_any then v_kids else 127 end)::smallint;
end
$$;

-- ... and judged from above: its own days narrowed by every parent's up to the habit
create or replace function mneme.path_days(p_id uuid)
returns smallint
language sql
stable
set search_path = ''
as $$
  with recursive up as (
    select t.id, t.parent_id, t.rhythm_days, t.step_days, 0 as d from mneme.tasks t where t.id = p_id
    union all
    select p.id, p.parent_id, p.rhythm_days, p.step_days, u.d + 1
    from mneme.tasks p join up u on p.id = u.parent_id
    where u.rhythm_days is null and u.d < 100
  )
  select bit_and(coalesce(rhythm_days, step_days, 127))::smallint from up
$$;

-- Did the task count on `day`? A step with live steps of its own counts when
-- all of those that are on that day do (none on = it isn't due, so no);
-- anything else when its check-in reached its target (1 unless it has a count).
-- Steps on hold, cancelled or done are out of the routine.
create or replace function mneme.routine_met(p_id uuid, p_day date)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  c      record;
  v_live boolean := false;
  v_any  boolean := false;
begin
  for c in
    select x.id from mneme.tasks x
    where x.parent_id = p_id and x.removed_at is null and x.state not in ('cancelled', 'on_hold', 'done')
  loop
    v_live := true;
    continue when not mneme.habit_due(mneme.routine_days(c.id), p_day);
    v_any := true;
    if not mneme.routine_met(c.id, p_day) then return false; end if;
  end loop;
  if v_live then return v_any; end if;
  return coalesce((
    select k.value >= t.rhythm_target
    from mneme.tasks t join mneme.task_checkins k on k.task_id = t.id and k.day = p_day
    where t.id = p_id), false);
end
$$;

-- write a day's value; a row with nothing left in it goes away
create or replace function mneme.checkin_put(p_task uuid, p_user uuid, p_day date, p_value integer)
returns void
language plpgsql
set search_path = ''
as $$
begin
  insert into mneme.task_checkins as k (task_id, user_id, day, value)
  values (p_task, p_user, p_day, p_value)
  on conflict (task_id, day) do update set value = excluded.value, skipped = false;
  delete from mneme.task_checkins k
   where k.task_id = p_task and k.day = p_day and k.value = 0 and k.note is null and not k.skipped;
end
$$;

-- re-score `p_id` and each routine above it for the day (default: the owner's today)
create or replace function mneme.routine_refresh(p_id uuid, p_day date default null)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v uuid := p_id;
  t record;
begin
  if p_id is null or mneme.task_habit_of(p_id) is null then return; end if;
  loop
    select x.id, x.user_id, x.parent_id into t from mneme.tasks x where x.id = v;
    exit when not found;
    if exists (select 1 from mneme.tasks c where c.parent_id = t.id and c.removed_at is null
                 and c.state not in ('cancelled', 'on_hold', 'done')) then
      perform mneme.checkin_put(t.id, t.user_id, coalesce(p_day, mneme.user_today(t.user_id)),
                                mneme.routine_met(t.id, coalesce(p_day, mneme.user_today(t.user_id)))::int);
    end if;
    exit when t.parent_id is null;
    v := t.parent_id;
  end loop;
end
$$;

-- Streak = consecutive due days that counted, ending on `p_day`; `p_day` not
-- counting yet doesn't break it. Days off the rhythm (its own, or days none of
-- its steps are on) and skipped days (the habit was set aside) are passed
-- over, never misses.
create or replace function mneme.rhythm_streak(p_task uuid, p_day date)
returns integer
language sql
stable
set search_path = ''
as $$
  with h as (
    select t.id, mneme.routine_days(t.id) as days, t.user_id,
           case when exists (select 1 from mneme.tasks c where c.parent_id = t.id and c.removed_at is null
                               and c.state not in ('cancelled', 'on_hold', 'done'))
                then 1 else t.rhythm_target end as target,
           least((t.created_at at time zone coalesce((select s.timezone from mneme.settings s where s.user_id = t.user_id), 'UTC'))::date,
                 coalesce((select min(k.day) from mneme.task_checkins k where k.task_id = t.id), p_day),
                 p_day) as since
    from mneme.tasks t where t.id = p_task and t.rhythm_days is not null
  ), span as (
    select g::date as d
    from h, generate_series(p_day::timestamp, h.since::timestamp, interval '-1 day') g
    where mneme.habit_due(h.days, g::date) and g::date >= p_day - 1000
      and not exists (select 1 from mneme.task_checkins k where k.task_id = h.id and k.day = g::date and k.skipped)
  ), marked as (
    select s.d, coalesce(k.value, 0) >= h.target as met
    from span s cross join h left join mneme.task_checkins k on k.task_id = h.id and k.day = s.d
  )
  select count(*)::int from marked m
  where m.met
    and m.d > coalesce((select max(x.d) from marked x where not x.met and x.d < p_day), '-infinity'::date)
$$;

-- "stretch every day" -> ("stretch", 127). Recognised anywhere in the text:
--   every day · everyday · daily · each day · weekdays / every weekday ·
--   weekends / every weekend · every mon[day][, wed … and fri]
-- If nothing but the rhythm words would be left, nothing is taken out.
create or replace function mneme.parse_rhythm(p_text text)
returns table (title text, days smallint)
language plpgsql
immutable
set search_path = ''
as $$
declare
  s   text := ' ' || coalesce(p_text, '') || ' ';
  m   text[];
  pat text;
  v   integer;
  w   text;
  wd  constant text := '(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day|nesday|sday|urday|s)?s?';
begin
  pat := '\m(?:every ?day|daily|each day)\M';
  if s ~* pat then v := 127; s := regexp_replace(s, pat, ' ', 'i'); end if;
  pat := '\m(?:every weekday|weekdays)\M';
  if v is null and s ~* pat then v := 31; s := regexp_replace(s, pat, ' ', 'i'); end if;
  pat := '\m(?:every weekend|weekends)\M';
  if v is null and s ~* pat then v := 96; s := regexp_replace(s, pat, ' ', 'i'); end if;
  pat := '\mevery (' || wd || '(?:\s*(?:,|and|&|/)\s*' || wd || '|\s+' || wd || ')*)\M';
  m := regexp_match(s, pat, 'i');
  if v is null and m is not null then
    v := 0;
    for w in select x[1] from regexp_matches(m[1], '(mon|tue|wed|thu|fri|sat|sun)', 'gi') x loop
      v := v | (1 << (mneme.weekday_num(w) - 1));
    end loop;
    s := regexp_replace(s, pat, ' ', 'i');
  end if;

  s := btrim(regexp_replace(s, '\s+', ' ', 'g'));
  if v is null or v = 0 or s = '' then
    return query select p_text, null::smallint;
  else
    return query select s, v::smallint;
  end if;
end
$$;

-- ------------------------------------------------------------- triggers --
create or replace function mneme.task_rollup(p_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  ps       text;
  v_total  integer;
  v_res    integer;
  v_prog   integer;
  v_target text;
  v_prev   text;
  v_rhythm smallint;
begin
  if p_id is null then return; end if;
  select t.state, t.rhythm_days into ps, v_rhythm from mneme.tasks t where t.id = p_id for update;
  -- a habit's state is only ever set by hand (its steps are ticked per day)
  if not found or ps in ('on_hold', 'cancelled') or v_rhythm is not null then return; end if;

  select count(*),
         count(*) filter (where c.state in ('done', 'cancelled')),
         count(*) filter (where c.state in ('in_progress', 'done'))
    into v_total, v_res, v_prog
    from mneme.tasks c where c.parent_id = p_id and c.removed_at is null;
  if v_total = 0 then return; end if;

  v_target := case
    when v_res = v_total then 'done'
    when ps = 'done'     then case when v_prog > 0 then 'in_progress' else 'open' end
    when ps = 'open' and v_prog > 0 then 'in_progress'
    else ps
  end;
  if v_target is distinct from ps then
    v_prev := coalesce(current_setting('mneme.internal', true), '');
    perform set_config('mneme.internal', 'on', true);
    update mneme.tasks set state = v_target where id = p_id;
    perform set_config('mneme.internal', v_prev, true);
  end if;
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
  v_rhythm       record;
  v_habit_tree   boolean;
  v_today        date;
  v_habit_step   boolean := false;
begin
  -- a new step of a habit: "Upper body every mon, wed and fri" -> its own days
  -- (and no date reading: a habit's steps have no dates)
  if tg_op = 'INSERT' and new.source = 'standalone' and not (v_internal or v_move)
     and (new.parent_id is not null or new.sequence_id is not null) then
    v_habit_step := mneme.task_habit_of(coalesce(
      (select s.task_id from mneme.task_sequences s where s.id = new.sequence_id), new.parent_id)) is not null;
    if v_habit_step and new.step_days is null then
      select * into v_rhythm from mneme.parse_rhythm(new.title);
      if v_rhythm.days is not null then
        new.title := v_rhythm.title;
        new.step_days := nullif(v_rhythm.days, 127);
      end if;
    end if;
  end if;

  -- typed rhythm: "stretch every day" -> a habit "stretch" (read before dates)
  if tg_op = 'INSERT' and new.source = 'standalone' and new.parent_id is null and new.sequence_id is null
     and new.rhythm_days is null and not (v_internal or v_move) then
    select * into v_rhythm from mneme.parse_rhythm(new.title);
    if v_rhythm.days is not null then
      new.title := v_rhythm.title;
      new.rhythm_days := v_rhythm.days;
    end if;
  end if;

  -- typed dates: "call bank tomorrow 3pm" -> "call bank", due tomorrow 15:00
  if tg_op = 'INSERT' and new.source = 'standalone' and new.rhythm_days is null and not v_habit_step and not (v_internal or v_move) then
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

  -- habits: a main task made outside a note; it and its steps never have dates
  if new.rhythm_days is not null and new.source <> 'standalone' then
    raise exception 'Only tasks made outside a note can repeat.';
  end if;
  if new.rhythm_days is not null and new.parent_id is not null then
    raise exception 'A habit stays a main task — stop repeating it first.';
  end if;
  v_habit_tree := new.rhythm_days is not null or (new.parent_id is not null and mneme.task_habit_of(new.parent_id) is not null);
  if v_habit_tree then
    new.due_date := null; new.due_time := null; new.snoozed_until := null;
  end if;
  -- own days (and a count) belong to a habit's steps; outside a habit they mean nothing
  if not v_habit_tree or new.rhythm_days is not null then new.step_days := null; end if;
  -- set aside (on hold / done / cancelled) -> remember since when; back on
  -- track -> those days are recorded as skipped, so the streak is frozen
  if new.rhythm_days is not null and tg_op = 'UPDATE' and not v_import then
    if old.rhythm_days is null then
      new.rhythm_paused_on := case when new.state in ('on_hold', 'done', 'cancelled') then mneme.user_today(new.user_id) end;
    elsif new.state in ('on_hold', 'done', 'cancelled') and old.state not in ('on_hold', 'done', 'cancelled') then
      new.rhythm_paused_on := mneme.user_today(new.user_id);
    elsif new.state not in ('on_hold', 'done', 'cancelled') and old.state in ('on_hold', 'done', 'cancelled') then
      v_today := mneme.user_today(new.user_id);
      insert into mneme.task_checkins (task_id, user_id, day, value, skipped)
      select new.id, new.user_id, g::date, 0, true
        from generate_series(coalesce(old.rhythm_paused_on, v_today)::timestamp, (v_today - 1)::timestamp, interval '1 day') g
      on conflict (task_id, day) do nothing;
      new.rhythm_paused_on := null;
    end if;
  elsif new.rhythm_days is null then
    new.rhythm_paused_on := null;
  end if;

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

  -- a habit's steps are ticked per day (check_in), never finished
  if tg_op = 'UPDATE' and not v_internal and v_habit_tree and new.rhythm_days is null
     and new.state in ('in_progress', 'done') and (v_state_set or v_status_set) then
    raise exception 'Steps of a habit are ticked per day — use its checkbox.';
  end if;

  -- guards: blocked tasks can't start or finish; a parent can't finish before its subtasks
  -- (a habit can graduate whenever, steps and all)
  if tg_op = 'UPDATE' and not v_internal and new.state in ('in_progress', 'done')
     and (v_state_set or (v_status_set and new.source = 'standalone')) then
    if not v_habit_tree and mneme.task_blocked(new.id) then
      raise exception 'This is blocked — finish what comes before it first.';
    end if;
    if new.state = 'done' and new.rhythm_days is null and exists (
      select 1 from mneme.tasks c where c.parent_id = new.id and c.removed_at is null
         and c.state not in ('done', 'cancelled')) then
      raise exception 'Finish or cancel its subtasks first.';
    end if;
  end if;

  -- chronology (pushes to parents / later steps happen in the after-trigger);
  -- a cancel cascade only flips states and is left alone
  -- a note save is never refused over dates: the pushes still happen afterwards
  if new.state <> 'cancelled' and not mneme.task_flag('cascade') and not v_sync and not v_import and not v_habit_tree then
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
    perform mneme.routine_refresh(old.parent_id);
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

  -- a habit's routine: a step joining, leaving, being set aside or getting other
  -- days or another count re-scores today
  if tg_op = 'INSERT'
     or new.state is distinct from old.state
     or new.parent_id is distinct from old.parent_id
     or new.removed_at is distinct from old.removed_at
     or new.step_days is distinct from old.step_days
     or (new.rhythm_target is distinct from old.rhythm_target and new.rhythm_days is null) then
    perform mneme.routine_refresh(new.parent_id);
    if tg_op = 'UPDATE' and old.parent_id is distinct from new.parent_id then
      perform mneme.routine_refresh(old.parent_id);
    end if;
  end if;
  -- became a habit, or moved into one: no dates anywhere below it
  if (new.rhythm_days is not null and (tg_op = 'INSERT' or old.rhythm_days is null))
     or (new.parent_id is not null and (tg_op = 'INSERT' or new.parent_id is distinct from old.parent_id)
         and mneme.task_habit_of(new.parent_id) is not null) then
    update mneme.tasks x set due_date = null, due_time = null, snoozed_until = null
     where x.id in (select mneme.task_subtree_ids(new.id)) and x.id <> new.id
       and (x.due_date is not null or x.snoozed_until is not null);
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

-- ---------------------------------------------------------------- reads --
create or replace view mneme.tasks_active
with (security_invoker = true) as
select t.id, t.user_id, t.note_id, t.source, t.title, t.status, t.priority,
       t.due_date, t.position, t.created_at, t.completed_at,
       n.public_id as note_public_id,
       n.title     as note_title,
       t.due_time,
       t.state, t.parent_id, t.sequence_id, t.sort_order,
       (t.state not in ('done', 'cancelled') and (hr.id is null or hr.id = t.id) and mneme.task_blocked(t.id)) as blocked,
       (select count(*) from mneme.tasks c where c.parent_id = t.id and c.removed_at is null)::int as child_count,
       (select count(*) from mneme.tasks c where c.parent_id = t.id and c.removed_at is null
           and c.state in ('done', 'cancelled'))::int as child_resolved,
       t.updated_at,
       case when t.parent_id is null then t.id else mneme.task_root_id(t.id) end as root_id,
       p.title as parent_title,
       mneme.task_code(t.id) as code,
       t.snoozed_until,
       (t.snoozed_until is not null and t.snoozed_until > mneme.user_today(t.user_id)) as snoozed,
       t.rhythm_days, t.rhythm_target, t.rhythm_unit,
       hr.id as habit_id,
       case when hr.id is not null then mneme.routine_met(t.id, mneme.user_today(t.user_id)) end as checked_today,
       case when t.rhythm_days is not null then mneme.rhythm_streak(t.id, mneme.user_today(t.user_id)) end as streak,
       t.step_days,
       -- the weekdays it is actually on (its own and its parents' days, and its steps')
       case when hr.id is not null then mneme.path_days(t.id) & mneme.routine_days(t.id) end as due_days,
       -- what a step's own days can be chosen from
       case when hr.id is not null and t.parent_id is not null then mneme.path_days(t.parent_id) end as parent_days,
       case when hr.id is not null then coalesce((select k.value from mneme.task_checkins k
              where k.task_id = t.id and k.day = mneme.user_today(t.user_id)), 0) end as value_today
from mneme.tasks t
left join mneme.notes n on n.id = t.note_id
left join mneme.tasks p on p.id = t.parent_id
left join mneme.tasks hr on hr.id = case when t.parent_id is null then t.id else mneme.task_root_id(t.id) end
                        and hr.rhythm_days is not null
where t.removed_at is null
  and (t.note_id is null or n.deleted_at is null)
  and mneme.task_ancestors_live(t.parent_id);
grant select on mneme.tasks_active to authenticated;

-- habits live in the strip / Habits page, not in the task lists
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
    return query select * from mneme.tasks_active t where t.status = 'done' and t.parent_id is null and t.rhythm_days is null
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
                 where t.status = 'open' and t.due_date is null and t.parent_id is null and not t.snoozed and t.rhythm_days is null
                 order by t.created_at desc limit p_limit;
  else
    raise exception 'unknown bucket %', p_bucket using errcode = '22023';
  end if;
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
  for r in
    select t.id from mneme.tasks t
    where t.user_id = (select auth.uid()) and t.status = 'done' and t.removed_at is null
      and t.parent_id is null and t.rhythm_days is null   -- a graduated habit keeps its history
      and (t.note_id is null or exists (
            select 1 from mneme.notes n where n.id = t.note_id and n.deleted_at is null))
    order by t.note_id nulls first, t.position desc
  loop
    perform mneme.delete_task(r.id);
    v_n := v_n + 1;
  end loop;
  return v_n;
end
$$;

-- ---------------------------------------------------------------- check-ins --
create or replace function mneme.check_in(p_task uuid, p_day date, p_delta integer)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_uid   uuid := (select auth.uid());
  t       mneme.tasks;
  h       mneme.tasks;
  v_habit uuid;
  v_value integer;
  r       record;
begin
  if v_uid is null then raise exception 'not signed in' using errcode = '28000'; end if;
  if p_day is null or p_day > mneme.user_today(v_uid) + 1 then
    raise exception 'cannot log a future day' using errcode = '22023';
  end if;
  select * into t from mneme.tasks x where x.id = p_task and x.user_id = v_uid and x.removed_at is null;
  if not found then raise exception 'task not found' using errcode = 'P0002'; end if;
  v_habit := mneme.task_habit_of(t.id);
  if v_habit is null then raise exception 'That task doesn’t repeat.'; end if;
  select * into h from mneme.tasks x where x.id = v_habit;
  if h.state not in ('open', 'in_progress') then
    raise exception 'This habit is set aside — set it to Open to tick it.';
  end if;
  if t.id <> h.id and t.state in ('cancelled', 'on_hold', 'done') then
    raise exception 'That step is out of the routine right now.';
  end if;
  if t.id <> h.id and not mneme.habit_due(mneme.path_days(t.id) & mneme.routine_days(t.id), p_day) then
    raise exception 'That step isn’t on that day.';
  end if;
  p_delta := coalesce(p_delta, 0);

  if exists (select 1 from mneme.tasks c where c.parent_id = t.id and c.removed_at is null
               and c.state not in ('cancelled', 'on_hold', 'done')) then
    -- a routine (or a group of steps): tick or untick every live step below it that is on that day
    if p_delta <> 0 then
      for r in
        with recursive down as (
          select c.id, c.rhythm_target, 1 as d from mneme.tasks c
          where c.parent_id = t.id and c.removed_at is null and c.state not in ('cancelled', 'on_hold', 'done')
            and mneme.habit_due(mneme.routine_days(c.id), p_day)
          union all
          select c.id, c.rhythm_target, down.d + 1 from mneme.tasks c join down on c.parent_id = down.id
          where c.removed_at is null and c.state not in ('cancelled', 'on_hold', 'done')
            and mneme.habit_due(mneme.routine_days(c.id), p_day)
        )
        select down.id, down.rhythm_target,
               exists (select 1 from mneme.tasks c where c.parent_id = down.id and c.removed_at is null
                         and c.state not in ('cancelled', 'on_hold', 'done')) as grp
        from down order by down.d desc
      loop
        if r.grp then
          perform mneme.checkin_put(r.id, v_uid, p_day, mneme.routine_met(r.id, p_day)::int);
        else
          perform mneme.checkin_put(r.id, v_uid, p_day, case when p_delta > 0 then r.rhythm_target else 0 end);
        end if;
      end loop;
    end if;
    perform mneme.routine_refresh(t.id, p_day);
    return mneme.routine_met(t.id, p_day)::int;
  end if;

  -- a step counts up to its target ("3 sets"); a habit up to whatever was logged
  insert into mneme.task_checkins as k (task_id, user_id, day, value)
  values (t.id, v_uid, p_day, greatest(0, least(case when t.id = h.id then 100000 else t.rhythm_target end, p_delta)))
  on conflict (task_id, day) do update
    set value = greatest(0, least(case when t.id = h.id then 100000 else t.rhythm_target end, k.value + p_delta)), skipped = false
  returning k.value into v_value;
  delete from mneme.task_checkins k
   where k.task_id = t.id and k.day = p_day and k.value = 0 and k.note is null and not k.skipped;
  perform mneme.routine_refresh(t.parent_id, p_day);
  return v_value;
end
$$;

-- one line about the day ("what stuck"); empty clears it
create or replace function mneme.set_checkin_note(p_task uuid, p_day date, p_note text)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_uid  uuid := (select auth.uid());
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if v_uid is null then raise exception 'not signed in' using errcode = '28000'; end if;
  if p_day is null or p_day > mneme.user_today(v_uid) + 1 then
    raise exception 'cannot log a future day' using errcode = '22023';
  end if;
  if not exists (select 1 from mneme.tasks x where x.id = p_task and x.user_id = v_uid and x.rhythm_days is not null) then
    raise exception 'That task doesn’t repeat.';
  end if;
  insert into mneme.task_checkins as k (task_id, user_id, day, note)
  values (p_task, v_uid, p_day, left(v_note, 500))
  on conflict (task_id, day) do update set note = excluded.note;
  delete from mneme.task_checkins k
   where k.task_id = p_task and k.day = p_day and k.value = 0 and k.note is null and not k.skipped;
end
$$;

-- A habit's (or step's) live steps that are on `day`, nested, for the strip
create or replace function mneme.routine_json(p_id uuid, p_day date)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', c.id, 'title', c.title, 'done', mneme.routine_met(c.id, p_day),
             'value', coalesce(k.value, 0), 'target', c.rhythm_target, 'unit', c.rhythm_unit,
             'days', c.step_days, 'steps', mneme.routine_json(c.id, p_day))
           order by coalesce(sq.sort_order, 1e9), c.sort_order, c.created_at, c.id)
    from mneme.tasks c
    left join mneme.task_sequences sq on sq.id = c.sequence_id
    left join mneme.task_checkins k on k.task_id = c.id and k.day = p_day
    where c.parent_id = p_id and c.removed_at is null and c.state not in ('cancelled', 'on_hold', 'done')
      and mneme.habit_due(mneme.routine_days(c.id), p_day)
  ), '[]'::jsonb);
end
$$;

-- The day's habits (open / in progress, existing by then) for the strip. A
-- routine's value/target are its steps done/total for that day; `steps` are
-- the ones on that day, nested; `days` are the weekdays it is on at all.
drop function if exists mneme.habits_for_day(date);
create function mneme.habits_for_day(p_day date)
returns table (
  id uuid, name text, target integer, unit text, days smallint, state text, created_at timestamptz,
  due boolean, blocked boolean, value integer, streak integer, note text, steps jsonb
)
language sql
stable
set search_path = ''
as $$
  with hs as (
    select t.*,
           mneme.routine_json(t.id, p_day) as st, mneme.routine_days(t.id) as due_mask
    from mneme.tasks t
    where t.user_id = (select auth.uid()) and t.rhythm_days is not null and t.removed_at is null
      and t.state in ('open', 'in_progress')
      -- hidden on days before it existed (unless progress was backfilled there)
      and least((t.created_at at time zone coalesce((select s.timezone from mneme.settings s where s.user_id = t.user_id), 'UTC'))::date,
                coalesce((select min(k.day) from mneme.task_checkins k where k.task_id = t.id), p_day)) <= p_day
  )
  select hs.id, hs.title,
         case when jsonb_array_length(hs.st) > 0 then jsonb_array_length(hs.st) else hs.rhythm_target end,
         hs.rhythm_unit, hs.due_mask, hs.state, hs.created_at,
         mneme.habit_due(hs.due_mask, p_day) and not mneme.task_blocked(hs.id),
         mneme.task_blocked(hs.id),
         case when jsonb_array_length(hs.st) > 0
              then (select count(*)::int from jsonb_array_elements(hs.st) e where (e->>'done')::boolean)
              else coalesce(k.value, 0) end,
         mneme.rhythm_streak(hs.id, p_day),
         k.note,
         hs.st
  from hs
  left join mneme.task_checkins k on k.task_id = hs.id and k.day = p_day
  order by hs.created_at, hs.id
$$;

-- ------------------------------------------------------------- calendar --
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
    -- each live habit on each of its due days that it already existed on and wasn't set aside
    select g::date as d,
           count(*)::int as habits_due,
           count(*) filter (where coalesce(l.value, 0) >= case
             when exists (select 1 from mneme.tasks c where c.parent_id = hb.id and c.removed_at is null
                            and c.state not in ('cancelled', 'on_hold', 'done')) then 1
             else hb.rhythm_target end)::int as habits_met
    from generate_series(p_from::timestamp, least(p_to, v_today)::timestamp, interval '1 day') g
    join mneme.tasks hb
      on hb.user_id = (select auth.uid())
     and hb.rhythm_days is not null and hb.removed_at is null
     and hb.state in ('open', 'in_progress')
     and mneme.habit_due(mneme.routine_days(hb.id), g::date)
     and (hb.created_at at time zone v_tz)::date <= g::date
    left join mneme.task_checkins l on l.task_id = hb.id and l.day = g::date
    where l.skipped is not true
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

-- --------------------------------------------------------------- backup --
create or replace function mneme.backup_data(p_user uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'format', 'mneme-backup', 'version', 2, 'exported_at', now(),
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
    'task_checkins', coalesce((select jsonb_agg(to_jsonb(rw) - 'user_id') from mneme.task_checkins rw where rw.user_id = p_user), '[]'::jsonb),
    'saved_searches', coalesce((select jsonb_agg(to_jsonb(rw) - 'user_id' - 'id') from mneme.saved_searches rw where rw.user_id = p_user), '[]'::jsonb)
  )
$$;

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
                               created_at, completed_at, snoozed_until, cascade_cancelled,
                               rhythm_days, rhythm_target, rhythm_unit, rhythm_paused_on, step_days)
      values ('standalone', r->>'title', coalesce(r->>'state', 'open'), r->>'priority', (r->>'due_date')::date, (r->>'due_time')::time,
              (select m.new from imp_map m where m.kind = 'task' and m.old = (r->>'parent_id')::uuid),
              coalesce((r->>'sort_order')::double precision, 0), coalesce((r->>'created_at')::timestamptz, now()),
              (r->>'completed_at')::timestamptz, (r->>'snoozed_until')::date, coalesce((r->>'cascade_cancelled')::boolean, false),
              (r->>'rhythm_days')::smallint, coalesce((r->>'rhythm_target')::int, 1), r->>'rhythm_unit', (r->>'rhythm_paused_on')::date,
              (r->>'step_days')::smallint)
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

  -- habit check-ins
  insert into mneme.task_checkins (task_id, day, value, note, skipped)
  select m.new, (x->>'day')::date, coalesce((x->>'value')::int, 0), x->>'note', coalesce((x->>'skipped')::boolean, false)
  from jsonb_array_elements(coalesce(p->'task_checkins', '[]')) x
  join imp_map m on m.kind = 'task' and m.old = (x->>'task_id')::uuid
  on conflict do nothing;
  -- a version-1 backup: its habits become habit tasks (removed ones retired)
  for r in select value from jsonb_array_elements(coalesce(p->'habits', '[]')) loop
    insert into mneme.tasks (source, title, state, rhythm_days, rhythm_target, rhythm_unit, rhythm_paused_on, created_at, completed_at)
    values ('standalone', left(r->>'name', 500), case when r->>'archived_at' is null then 'open' else 'cancelled' end,
            coalesce((r->>'days')::smallint, 127), coalesce((r->>'target')::int, 1), r->>'unit',
            ((r->>'archived_at')::timestamptz)::date,
            coalesce((r->>'created_at')::timestamptz, now()), (r->>'archived_at')::timestamptz)
    returning id into v_new;
    insert into imp_map values ('habit', (r->>'id')::uuid, v_new);
    n_tasks := n_tasks + 1;
  end loop;
  insert into mneme.task_checkins (task_id, day, value)
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

-- ------------------------------------------------- move the old habits over --
do $$
declare
  h     record;
  v_new uuid;
begin
  if to_regclass('mneme.habits') is null then return; end if;
  perform set_config('mneme.import', 'on', true);   -- plain rows: no typed-date reading, no pushes
  create temp table habit_map (old uuid primary key, new uuid not null) on commit drop;
  for h in execute 'select * from mneme.habits order by created_at, id' loop
    insert into mneme.tasks (user_id, source, title, state, rhythm_days, rhythm_target, rhythm_unit,
                             rhythm_paused_on, created_at, completed_at)
    values (h.user_id, 'standalone', left(h.name, 500),
            case when h.archived_at is null then 'open' else 'cancelled' end,
            h.days, h.target, h.unit, (h.archived_at at time zone 'UTC')::date, h.created_at, h.archived_at)
    returning id into v_new;
    insert into habit_map values (h.id, v_new);
  end loop;
  execute 'insert into mneme.task_checkins (task_id, user_id, day, value)
           select m.new, l.user_id, l.day, l.value
           from mneme.habit_logs l join habit_map m on m.old = l.habit_id
           on conflict do nothing';
  perform set_config('mneme.import', '', true);
end $$;

drop function if exists mneme.bump_habit(uuid, date, integer);
drop table if exists mneme.habit_logs;
drop table if exists mneme.habits;

-- ------------------------------------------------------------------ grants --
revoke all on function mneme.task_habit_of(uuid)                   from public, anon;
revoke all on function mneme.routine_days(uuid)                    from public, anon;
revoke all on function mneme.path_days(uuid)                       from public, anon;
revoke all on function mneme.routine_json(uuid, date)              from public, anon;
revoke all on function mneme.routine_met(uuid, date)               from public, anon;
revoke all on function mneme.checkin_put(uuid, uuid, date, integer) from public, anon;
revoke all on function mneme.routine_refresh(uuid, date)           from public, anon;
revoke all on function mneme.rhythm_streak(uuid, date)             from public, anon;
revoke all on function mneme.parse_rhythm(text)                    from public, anon;
revoke all on function mneme.check_in(uuid, date, integer)         from public, anon;
revoke all on function mneme.set_checkin_note(uuid, date, text)    from public, anon;
revoke all on function mneme.habits_for_day(date)                  from public, anon;
revoke all on function mneme.calendar_month(date, date)            from public, anon;
grant execute on function mneme.task_habit_of(uuid)                to authenticated;
grant execute on function mneme.routine_days(uuid)                 to authenticated;
grant execute on function mneme.path_days(uuid)                    to authenticated;
grant execute on function mneme.routine_json(uuid, date)           to authenticated;
grant execute on function mneme.routine_met(uuid, date)            to authenticated;
grant execute on function mneme.checkin_put(uuid, uuid, date, integer) to authenticated;
grant execute on function mneme.routine_refresh(uuid, date)        to authenticated;
grant execute on function mneme.rhythm_streak(uuid, date)          to authenticated;
grant execute on function mneme.parse_rhythm(text)                 to authenticated;
grant execute on function mneme.check_in(uuid, date, integer)      to authenticated;
grant execute on function mneme.set_checkin_note(uuid, date, text) to authenticated;
grant execute on function mneme.habits_for_day(date)               to authenticated;
grant execute on function mneme.calendar_month(date, date)         to authenticated;

commit;
