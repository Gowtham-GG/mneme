-- =============================================================================
-- Mneme 22 — task trees: subtasks, sequences, statuses, "must happen first"
-- links, chronological due dates, and canvases (categories for main tasks).
--
--   tasks.state        open | in_progress | on_hold | done | cancelled.
--                      The old `status` column stays and is kept in step by
--                      the trigger (open/in_progress/on_hold -> 'open',
--                      done/cancelled -> 'done'), so every existing query that
--                      means "unfinished" / "finished" keeps working. Writing
--                      either column works; state wins when both change.
--   tasks.parent_id    subtask of another task; any depth, no cycles.
--   task_sequences     ordered chains under a parent. A step is BLOCKED until
--                      every earlier step is done or cancelled. Several
--                      sequences under one parent run in parallel; subtasks with
--                      no sequence are loose (any order).
--   task_links         'blocks' = from must finish before to can start (so `to`
--                      shows blocked); 'related' = a plain dotted connection.
--   blocked            derived, never stored: waiting on an earlier step, an
--                      unfinished 'blocks' link, or an ancestor that is blocked.
--                      A blocked task can't be started or completed; it can
--                      always be cancelled or put on hold.
--   roll-up            a parent with subtasks becomes done when all of them are
--                      done/cancelled, in progress when any has progress, and
--                      reopens when a subtask is added or reopened. A parent
--                      set on hold / cancelled by hand is left alone. A parent
--                      can't be marked done while a subtask is unfinished.
--   cancel cascade     cancelling a task cancels its unfinished descendants;
--                      un-cancelling it reopens exactly those again.
--   due dates          a task is never due before its subtasks: a later
--                      subtask due date pushes the parent (and an undated
--                      parent gets one); moving a parent earlier than its
--                      latest subtask is rejected. Steps are chronological: a
--                      step can't be due before the dated step before it, and a
--                      later date pushes the dated step after it. Date-only
--                      counts as the end of that day. Cancelled items don't
--                      take part.
--   canvases           named categories; a main (top-level) task can be on any
--                      number of them. One on none is in the board's Inbox.
--                      Subtasks follow their main task.
--   Today / due badge  only actionable items: not blocked, not on hold, and
--                      not a parent still waiting on its subtasks.
--
-- Phase 1 limit: tasks written in a note can't be moved under another task or
-- be given subtasks yet (the note text decides their place — a later
-- migration adds note indentation). They can be linked, dated and have any
-- status. Additive; nothing in `public` (Argus) is touched.
-- =============================================================================
begin;

-- ------------------------------------------------------------------ columns --
alter table mneme.tasks
  add column if not exists state text not null default 'open'
    check (state in ('open', 'in_progress', 'on_hold', 'done', 'cancelled')),
  add column if not exists parent_id uuid,
  add column if not exists sequence_id uuid,
  add column if not exists sort_order double precision not null default 0,
  add column if not exists cascade_cancelled boolean not null default false;

-- backfill without the write trigger (it would bump updated_at on every row)
alter table mneme.tasks disable trigger tasks_before_write;
update mneme.tasks set state = 'done' where status = 'done' and state = 'open';
alter table mneme.tasks enable trigger tasks_before_write;

do $$ begin
  alter table mneme.tasks add constraint tasks_id_user_key unique (id, user_id);
exception when duplicate_object or duplicate_table then null; end $$;

do $$ begin
  alter table mneme.tasks add constraint tasks_parent_fk
    foreign key (parent_id, user_id) references mneme.tasks (id, user_id) on delete cascade;
exception when duplicate_object then null; end $$;

do $$ begin
  alter table mneme.tasks add constraint tasks_not_own_parent check (parent_id is distinct from id);
exception when duplicate_object then null; end $$;

-- ------------------------------------------------------------------- tables --
create table if not exists mneme.task_sequences (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  task_id    uuid not null,                       -- the parent task
  title      text check (title is null or char_length(title) <= 200),
  sort_order double precision not null default 0,
  created_at timestamptz not null default now(),
  constraint task_sequences_id_user_key unique (id, user_id),
  foreign key (task_id, user_id) references mneme.tasks (id, user_id) on delete cascade
);

do $$ begin
  alter table mneme.tasks add constraint tasks_sequence_fk
    foreign key (sequence_id, user_id) references mneme.task_sequences (id, user_id) on delete cascade;
exception when duplicate_object then null; end $$;

create table if not exists mneme.task_links (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  from_task_id uuid not null,
  to_task_id   uuid not null,
  kind         text not null default 'blocks' check (kind in ('blocks', 'related')),
  created_at   timestamptz not null default now(),
  check (from_task_id <> to_task_id),
  unique (from_task_id, to_task_id, kind),
  foreign key (from_task_id, user_id) references mneme.tasks (id, user_id) on delete cascade,
  foreign key (to_task_id, user_id)   references mneme.tasks (id, user_id) on delete cascade
);

create table if not exists mneme.canvases (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name       text not null check (char_length(btrim(name)) between 1 and 80),
  sort_order double precision not null default 0,
  created_at timestamptz not null default now(),
  constraint canvases_id_user_key unique (id, user_id)
);
create unique index if not exists canvases_user_name_idx on mneme.canvases (user_id, lower(btrim(name)));

create table if not exists mneme.canvas_tasks (
  canvas_id  uuid not null,
  task_id    uuid not null,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (canvas_id, task_id),
  foreign key (canvas_id, user_id) references mneme.canvases (id, user_id) on delete cascade,
  foreign key (task_id, user_id)   references mneme.tasks (id, user_id) on delete cascade
);

create index if not exists tasks_parent_idx        on mneme.tasks (parent_id) where parent_id is not null;
create index if not exists tasks_sequence_idx      on mneme.tasks (sequence_id, sort_order) where sequence_id is not null;
create index if not exists task_sequences_task_idx on mneme.task_sequences (task_id);
create index if not exists task_links_to_idx       on mneme.task_links (to_task_id);
create index if not exists task_links_from_idx     on mneme.task_links (from_task_id);
create index if not exists canvas_tasks_task_idx   on mneme.canvas_tasks (task_id);

do $$
declare t text;
begin
  foreach t in array array['task_sequences', 'task_links', 'canvases', 'canvas_tasks'] loop
    execute format('alter table mneme.%I enable row level security', t);
    execute format('drop policy if exists %I on mneme.%I', t || '_owner', t);
    execute format(
      'create policy %I on mneme.%I for all to authenticated
         using (user_id = (select auth.uid()))
         with check (user_id = (select auth.uid()))',
      t || '_owner', t);
  end loop;
end $$;

grant select, insert, update, delete on mneme.task_sequences, mneme.task_links, mneme.canvases, mneme.canvas_tasks to authenticated;

-- ------------------------------------------------------------------ helpers --
-- Comparable due moment; a date without a time means the end of that day.
create or replace function mneme.due_key(p_date date, p_time time)
returns timestamp
language sql
immutable
set search_path = ''
as $$ select p_date + coalesce(p_time, time '23:59:59.999999') $$;

create or replace function mneme.fmt_due(p_date date, p_time time)
returns text
language sql
immutable
set search_path = ''
as $$ select to_char(p_date, 'Mon FMDD, YYYY') || coalesce(' ' || to_char(p_time, 'HH24:MI'), '') $$;

-- Is the task (or any ancestor) waiting on an earlier unfinished step or an
-- unfinished 'blocks' link? Says nothing about the task's own state.
create or replace function mneme.task_blocked(p_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  with recursive up as (
    select t.id, t.parent_id, t.sequence_id, t.sort_order, t.created_at, 0 as d
    from mneme.tasks t where t.id = p_id
    union all
    select p.id, p.parent_id, p.sequence_id, p.sort_order, p.created_at, u.d + 1
    from mneme.tasks p join up u on p.id = u.parent_id
    where u.d < 100
  )
  select exists (
    select 1 from up u
    where exists (
            select 1 from mneme.tasks s
            left join mneme.notes n on n.id = s.note_id
            where u.sequence_id is not null and s.sequence_id = u.sequence_id and s.id <> u.id
              and s.removed_at is null and (s.note_id is null or n.deleted_at is null)
              and s.state not in ('done', 'cancelled')
              and (s.sort_order, s.created_at, s.id) < (u.sort_order, u.created_at, u.id))
       or exists (
            select 1 from mneme.task_links l
            join mneme.tasks s on s.id = l.from_task_id
            left join mneme.notes n on n.id = s.note_id
            where l.to_task_id = u.id and l.kind = 'blocks'
              and s.removed_at is null and (s.note_id is null or n.deleted_at is null)
              and s.state not in ('done', 'cancelled'))
  )
$$;

-- every ancestor of a task, nearest first
create or replace function mneme.task_ancestor_ids(p_id uuid)
returns setof uuid
language sql
stable
set search_path = ''
as $$
  with recursive up as (
    select t.parent_id as id, 0 as d from mneme.tasks t where t.id = p_id
    union all
    select p.parent_id, u.d + 1 from mneme.tasks p join up u on p.id = u.id where u.d < 100
  )
  select id from up where id is not null order by d
$$;

-- true when every ancestor of the task is still live (children of a removed
-- task, or of one in a trashed note, disappear with it)
create or replace function mneme.task_ancestors_live(p_parent uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  with recursive up as (
    select t.id, t.parent_id, t.removed_at, t.note_id, 0 as d from mneme.tasks t where t.id = p_parent
    union all
    select p.id, p.parent_id, p.removed_at, p.note_id, u.d + 1
    from mneme.tasks p join up u on p.id = u.parent_id where u.d < 100
  )
  select p_parent is null or not exists (
    select 1 from up u left join mneme.notes n on n.id = u.note_id
    where u.removed_at is not null or n.deleted_at is not null
  )
$$;

-- Transaction-local flag helpers. 'internal' = roll-up writing (skips the
-- blocked / unfinished-subtasks guards); 'cascade' = a cancel cascade is
-- rewriting a subtree (the after-trigger sits it out).
create or replace function mneme.task_flag(p_name text)
returns boolean
language sql
stable
set search_path = ''
as $$ select coalesce(current_setting('mneme.' || p_name, true), '') = 'on' $$;

-- Recompute a parent's state from its live subtasks (see header).
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
begin
  if p_id is null then return; end if;
  select t.state into ps from mneme.tasks t where t.id = p_id for update;
  if not found or ps in ('on_hold', 'cancelled') then return; end if;

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

-- --------------------------------------------------------- before trigger --
create or replace function mneme.tasks_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_internal     boolean := mneme.task_flag('internal') or mneme.task_flag('cascade');
  v_state_set    boolean := tg_op = 'UPDATE' and new.state is distinct from old.state;
  v_status_set   boolean := tg_op = 'UPDATE' and new.status is distinct from old.status and not (new.state is distinct from old.state);
  v_moved        boolean;
  v_due_changed  boolean;
  v_seq_parent   uuid;
  v_parent       mneme.tasks;
  k              timestamp;
  v_lim          record;
begin
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
    if new.source = 'note' then
      raise exception 'A task written in a note can’t be moved under another task yet — edit the note instead.';
    end if;
    if v_parent.source = 'note' then
      raise exception 'Tasks written in a note can’t have subtasks yet.';
    end if;
    if tg_op = 'UPDATE' and (new.parent_id = new.id or new.id in (select mneme.task_ancestor_ids(new.parent_id))) then
      raise exception 'A task can’t go under one of its own subtasks.';
    end if;
  end if;

  -- position among siblings: appended when new to the group
  if new.parent_id is not null and (
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
  if new.state <> 'cancelled' and not mneme.task_flag('cascade') then
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

-- ---------------------------------------------------------- after trigger --
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
  if mneme.task_flag('cascade') then return null; end if;

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
  return null;
end
$$;

drop trigger if exists tasks_after_write on mneme.tasks;
create trigger tasks_after_write
  after insert or update or delete on mneme.tasks
  for each row execute function mneme.tasks_after_write();

-- ------------------------------------------------------------ link guards --
create or replace function mneme.task_links_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.kind <> 'blocks' then return new; end if;
  -- a task and its own ancestors/descendants can't block each other (it would never finish)
  if new.from_task_id in (select mneme.task_ancestor_ids(new.to_task_id))
     or new.to_task_id in (select mneme.task_ancestor_ids(new.from_task_id)) then
    raise exception 'A task can’t block its own main task or subtasks.';
  end if;
  -- no loops of "must happen first"
  if exists (
    with recursive reach as (
      select l.to_task_id as id, 0 as d from mneme.task_links l
       where l.from_task_id = new.to_task_id and l.kind = 'blocks' and l.id is distinct from new.id
      union
      select l.to_task_id, r.d + 1 from mneme.task_links l join reach r on l.from_task_id = r.id
       where l.kind = 'blocks' and l.id is distinct from new.id and r.d < 1000
    )
    select 1 from reach where reach.id = new.from_task_id
  ) or new.from_task_id = new.to_task_id then
    raise exception 'That would make a loop — these tasks would wait on each other forever.';
  end if;
  return new;
end
$$;

drop trigger if exists task_links_before_write on mneme.task_links;
create trigger task_links_before_write
  before insert or update on mneme.task_links
  for each row execute function mneme.task_links_before_write();

create or replace function mneme.canvas_tasks_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (select 1 from mneme.tasks t where t.id = new.task_id and t.parent_id is not null) then
    raise exception 'Only main tasks go on canvases — subtasks follow their main task.';
  end if;
  return new;
end
$$;

drop trigger if exists canvas_tasks_before_write on mneme.canvas_tasks;
create trigger canvas_tasks_before_write
  before insert or update on mneme.canvas_tasks
  for each row execute function mneme.canvas_tasks_before_write();

-- ------------------------------------------------------------------- view --
-- CREATE OR REPLACE VIEW may only append columns.
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
       t.updated_at
from mneme.tasks t
left join mneme.notes n on n.id = t.note_id
where t.removed_at is null
  and (t.note_id is null or n.deleted_at is null)
  and mneme.task_ancestors_live(t.parent_id);
grant select on mneme.tasks_active to authenticated;

-- ------------------------------------------------------------------- RPCs --
-- Set any state. A task written in a note also gets its checkbox rewritten
-- (done/cancelled -> [x], anything else -> [ ]).
create or replace function mneme.set_task_state(p_task_id uuid, p_state text)
returns mneme.tasks
language plpgsql
set search_path = ''
as $$
declare
  t         mneme.tasks;
  v_content text;
  v_lines   text[];
  v_line_no integer;
begin
  if p_state not in ('open', 'in_progress', 'on_hold', 'done', 'cancelled') then
    raise exception 'unknown state %', p_state using errcode = '22023';
  end if;
  select * into t from mneme.tasks
   where id = p_task_id and user_id = (select auth.uid()) for update;
  if not found then
    raise exception 'task not found' using errcode = 'P0002';
  end if;

  update mneme.tasks set state = p_state where id = t.id;

  if t.source = 'note' then
    select n.content into v_content from mneme.notes n where n.id = t.note_id for update;
    select l.n into v_line_no from mneme.note_task_lines(v_content) l
     where l.n = t.position and l.key = t.line_key;
    if v_line_no is null then
      select l.n into v_line_no from mneme.note_task_lines(v_content) l
       where l.key = t.line_key order by abs(l.n - t.position) limit 1;
    end if;
    if v_line_no is null then
      raise exception 'task line not found in note' using errcode = 'P0002';
    end if;
    v_lines := string_to_array(v_content, E'\n');
    v_lines[v_line_no] := regexp_replace(
      v_lines[v_line_no], '\[[ xX]\]', case when p_state in ('done', 'cancelled') then '[x]' else '[ ]' end);
    update mneme.notes set content = array_to_string(v_lines, E'\n') where id = t.note_id;
  end if;

  select * into t from mneme.tasks where id = p_task_id;
  return t;
end
$$;

create or replace function mneme.set_task_done(p_task_id uuid, p_done boolean)
returns mneme.tasks
language sql
set search_path = ''
as $$ select mneme.set_task_state(p_task_id, case when p_done then 'done' else 'open' end) $$;

-- Today / the due badge: actionable items only.
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
    return query select * from mneme.tasks_active t where t.status = 'done'
                 order by t.completed_at desc nulls last limit p_limit;
  elsif p_bucket = 'today' then
    return query select * from mneme.tasks_active t
                 where t.status = 'open' and t.due_date <= v_today
                   and t.state <> 'on_hold' and not t.blocked and t.child_resolved = t.child_count
                 order by t.due_date, t.due_time nulls last, t.created_at limit p_limit;
  elsif p_bucket = 'upcoming' then
    return query select * from mneme.tasks_active t
                 where t.status = 'open' and t.due_date > v_today
                 order by t.due_date, t.due_time nulls last, t.created_at limit p_limit;
  elsif p_bucket = 'no_date' then
    return query select * from mneme.tasks_active t
                 where t.status = 'open' and t.due_date is null
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
      and t.state <> 'on_hold' and not t.blocked and t.child_resolved = t.child_count
  );
end
$$;

-- Clearing completed tasks takes whole finished main tasks (with their
-- subtasks); finished subtasks of an unfinished task stay part of it.
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
      and t.parent_id is null
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

revoke all on function mneme.set_task_state(uuid, text) from public, anon;
grant execute on function mneme.set_task_state(uuid, text) to authenticated;

commit;
