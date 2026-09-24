-- =============================================================================
-- Mneme 24 — tasks written in notes join the task tree.
--   markers       - [ ] open  - [x] done  - [/] in progress  - [-] cancelled  - [h] on hold
--   structure     indentation = subtask; numbered checkbox siblings = a
--                 sequence, named by a plain "Name:" line right above them
--                 (a top-level numbered run is a sequence without a parent)
--   note -> task  a note save derives states (only from markers that
--                 changed), parents, sequences and order. It is never refused
--                 and never rewrites the note being saved.
--   task -> note  a change made elsewhere writes into the note: status
--                 markers (also from roll-ups), add_subtask / add_sequence add
--                 lines, move_task moves lines — into another note or out of
--                 notes it leaves a "↗ title → [[N-…]]" / "[[T-…]]" link line —
--                 and delete_task removes the task's whole indented block.
--   tasks_active  + code ("T-1A2B3C4D", what a [[T-…]] link uses); find_task(code)
-- Existing notes are re-derived once below (their text is not changed).
-- Additive; nothing in `public` (Argus) is touched.
-- =============================================================================
begin;

-- ------------------------------------------------------------------ columns --
-- the checkbox marker last seen in the note: a note edit only changes the
-- task's state when the marker itself changed, so a state set elsewhere (and
-- not yet written into the text) survives unrelated edits of the note
alter table mneme.tasks add column if not exists line_marker text;
update mneme.tasks set line_marker = case when status = 'done' then 'x' else ' ' end
 where source = 'note' and line_marker is null;

alter table mneme.task_sequences
  alter column task_id drop not null,
  add column if not exists note_id uuid,
  add column if not exists note_key text;
do $$ begin
  alter table mneme.task_sequences add constraint task_sequences_owner_check check (task_id is not null or note_id is not null);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table mneme.task_sequences add constraint task_sequences_note_fk
    foreign key (note_id, user_id) references mneme.notes (id, user_id) on delete cascade;
exception when duplicate_object then null; end $$;
create unique index if not exists task_sequences_note_key_idx on mneme.task_sequences (note_id, note_key) where note_id is not null;

-- ------------------------------------------------------------------ helpers --
create or replace function mneme.marker_state(p_marker text)
returns text language sql immutable set search_path = '' as $$
  select case lower(p_marker) when 'x' then 'done' when '/' then 'in_progress' when '-' then 'cancelled' when 'h' then 'on_hold' else 'open' end
$$;

create or replace function mneme.state_marker(p_state text)
returns text language sql immutable set search_path = '' as $$
  select case p_state when 'done' then 'x' when 'in_progress' then '/' when 'cancelled' then '-' when 'on_hold' then 'h' else ' ' end
$$;

create or replace function mneme.line_indent(p_line text)
returns integer language sql immutable set search_path = '' as $$
  select length(replace(coalesce(substring(p_line from '^[ \t]*'), ''), E'\t', '    '))
$$;

-- "T-1A2B3C4D": the short code a [[T-…]] link uses (first 8 hex digits of the id)
create or replace function mneme.task_code(p_id uuid)
returns text language sql immutable set search_path = '' as $$
  select 'T-' || upper(left(replace(p_id::text, '-', ''), 8))
$$;

-- Every checkbox line: "- [ ] x", "* [/] x", "1. [-] x", "2) [h] x".
--   marker   ' ' x / - h   (open, done, in progress, cancelled, on hold)
--   indent   leading whitespace, a tab counting 4
--   ordered  a numbered item (numbered siblings form a sequence)
create or replace function mneme.note_task_items(p_content text)
returns table (n integer, marker text, title text, key text, indent integer, ordered boolean)
language sql
immutable
set search_path = ''
as $$
  select l.n,
         lower(m.g[3]),
         left(regexp_replace(m.g[4], '\s+$', ''), 500),
         left(lower(regexp_replace(regexp_replace(m.g[4], '\s+$', ''), '\s+', ' ', 'g')), 500),
         mneme.line_indent(m.g[1]),
         m.g[2] ~ '^[0-9]'
  from mneme.note_lines(p_content) l,
       lateral regexp_matches(l.line, '^([ \t]*)([-*+]|[0-9]+[.)])\s+\[([ xX/hH-])\]\s+(\S.*)$') as m(g)
$$;

-- kept for the line lookups in set_task_done/delete/rename: now every marker counts
create or replace function mneme.note_task_lines(p_content text)
returns table (n integer, done boolean, title text, key text)
language sql
immutable
set search_path = ''
as $$
  select i.n, i.marker in ('x', '-'), i.title, i.key from mneme.note_task_items(p_content) i
$$;

-- 1-based line of a note task inside `p_content` (exact position first, else nearest same text)
create or replace function mneme.task_line_in(p_content text, p_key text, p_pos integer)
returns integer language sql immutable set search_path = '' as $$
  select coalesce(
    (select i.n from mneme.note_task_items(p_content) i where i.n = p_pos and i.key = p_key),
    (select i.n from mneme.note_task_items(p_content) i where i.key = p_key order by abs(i.n - p_pos) limit 1))
$$;

-- last line of the block a line heads: the following lines indented deeper (blank lines inside kept)
create or replace function mneme.block_end(p_lines text[], p_n integer)
returns integer
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_base integer := mneme.line_indent(p_lines[p_n]);
  v_last integer := p_n;
begin
  for k in p_n + 1 .. coalesce(array_length(p_lines, 1), 0) loop
    if btrim(p_lines[k]) = '' then continue; end if;
    exit when mneme.line_indent(p_lines[k]) <= v_base;
    v_last := k;
  end loop;
  return v_last;
end
$$;

-- shift a block left/right; the first line may also get a new list marker ("-" / "3.")
create or replace function mneme.reindent(p_lines text[], p_delta integer, p_first_marker text default null)
returns text[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  out text[] := '{}';
  l text;
  k integer := 0;
begin
  foreach l in array coalesce(p_lines, '{}') loop
    k := k + 1;
    if btrim(l) <> '' then
      l := repeat(' ', greatest(0, mneme.line_indent(l) + p_delta)) || regexp_replace(l, '^[ \t]*', '');
      if k = 1 and p_first_marker is not null then
        l := regexp_replace(l, '^(\s*)([-*+]|[0-9]+[.)])', '\1' || p_first_marker);
      end if;
    end if;
    out := out || l;
  end loop;
  return out;
end
$$;

-- a standalone task and its subtree as note lines (sequences as "Name:" + numbered steps)
create or replace function mneme.render_task_lines(p_id uuid, p_indent integer, p_marker text default '-')
returns text[]
language plpgsql
stable
set search_path = ''
as $$
declare
  t   mneme.tasks;
  out text[];
  s   record;
  c   record;
  k   integer;
begin
  select * into t from mneme.tasks where id = p_id;
  out := array[repeat(' ', p_indent) || p_marker || ' [' || mneme.state_marker(t.state) || '] ' || t.title];
  for s in select * from mneme.task_sequences where task_id = p_id order by sort_order, created_at, id loop
    out := out || (repeat(' ', p_indent + 2) || coalesce(nullif(btrim(s.title), ''), 'Steps') || ':');
    k := 0;
    for c in select id from mneme.tasks where sequence_id = s.id and removed_at is null order by sort_order, created_at, id loop
      k := k + 1;
      out := out || mneme.render_task_lines(c.id, p_indent + 2, k || '.');
    end loop;
  end loop;
  for c in select id from mneme.tasks where parent_id = p_id and sequence_id is null and removed_at is null order by sort_order, created_at, id loop
    out := out || mneme.render_task_lines(c.id, p_indent + 2, '-');
  end loop;
  return out;
end
$$;

-- the task and every task below it
create or replace function mneme.task_subtree_ids(p_id uuid)
returns setof uuid language sql stable set search_path = '' as $$
  with recursive down as (
    select p_id as id
    union all
    select c.id from mneme.tasks c join down d on c.parent_id = d.id
  ) select id from down
$$;

-- Rewrite the checkbox markers of a note so they match its tasks' states.
-- Never called during that note's own save (see the tasks after-trigger).
create or replace function mneme.write_task_markers(p_note uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  c       text;
  v_lines text[];
  r       record;
  v_want  text;
  v_dirty boolean := false;
begin
  if p_note is null then return; end if;
  select n.content into c from mneme.notes n where n.id = p_note for update;
  if not found then return; end if;
  v_lines := string_to_array(c, E'\n');
  for r in
    select i.n, i.marker, t.state
    from mneme.note_task_items(c) i
    join mneme.tasks t on t.note_id = p_note and t.source = 'note' and t.removed_at is null
                      and t.position = i.n and t.line_key = i.key
  loop
    v_want := mneme.state_marker(r.state);
    if v_want <> r.marker then
      v_lines[r.n] := regexp_replace(v_lines[r.n], '\[[ xX/hH-]\]', '[' || v_want || ']');
      v_dirty := true;
    end if;
  end loop;
  if v_dirty then
    update mneme.notes set content = array_to_string(v_lines, E'\n') where id = p_note;
  end if;
end
$$;

-- ----------------------------------------------------- note -> tasks sync --
-- The tasks part of sync_note_derived(): match checkbox lines to task rows
-- (same text first, then in order — so due dates/priorities survive edits and
-- moves), take the state from a changed marker, and derive the structure:
-- indentation = parent, numbered siblings = a sequence (named by a plain
-- "Name:" line right above them).
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

    if t_of[i] is null then
      insert into mneme.tasks (user_id, note_id, source, title, state, position, sort_order, line_key, line_marker)
      values (p_uid, p_note, 'note', nt[i], mneme.marker_state(nm[i]), nl[i], nl[i], nk[i], nm[i])
      returning id into v_rid;
      t_of[i] := v_rid;
    else
      update mneme.tasks x
         set title = nt[i], line_key = nk[i], position = nl[i], removed_at = null,
             state = case when x.line_marker is distinct from nm[i] then mneme.marker_state(nm[i]) else x.state end,
             line_marker = nm[i]
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

-- --------------------------------------------------------- task triggers --
create or replace function mneme.tasks_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_sync         boolean := mneme.task_flag('note_sync');
  v_move         boolean := mneme.task_flag('move');
  v_internal     boolean := mneme.task_flag('internal') or mneme.task_flag('cascade') or v_sync;
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
    -- a note decides the structure of its own tasks; everything else goes through move_task()
    if not (v_sync or v_move) and (new.source = 'note' or v_parent.source = 'note') then
      raise exception 'Tasks written in a note are arranged in the note — use Move under… or edit the note.';
    end if;
    if tg_op = 'UPDATE' and (new.parent_id = new.id or new.id in (select mneme.task_ancestor_ids(new.parent_id))) then
      raise exception 'A task can’t go under one of its own subtasks.';
    end if;
  end if;

  if new.sequence_id is not null and new.source = 'standalone' and not (v_sync or v_move)
     and exists (select 1 from mneme.task_sequences s where s.id = new.sequence_id and s.note_id is not null) then
    raise exception 'That sequence is written in a note — add the step there.';
  end if;
  if tg_op = 'UPDATE' and new.source = 'note' and not (v_sync or v_move)
     and new.sequence_id is distinct from old.sequence_id then
    raise exception 'Tasks written in a note are arranged in the note — edit the note instead.';
  end if;

  -- position among siblings: appended when new to the group (a note sets line numbers itself)
  if not v_sync and new.parent_id is not null and (
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
  if new.state <> 'cancelled' and not mneme.task_flag('cascade') and not v_sync then
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

  -- a note task changed outside its note (Tasks page, board, roll-up): write the
  -- status markers back into the note. Never during that note's own save.
  if new.source = 'note' and (tg_op = 'INSERT' or new.state is distinct from old.state)
     and not mneme.task_flag('note_sync') and not mneme.task_flag('move') then
    perform mneme.write_task_markers(new.note_id);
  end if;
  return null;
end
$$;


-- ------------------------------------------------------ note sync trigger --
create or replace function mneme.sync_note_derived()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_uid uuid := new.user_id;
begin
  ---------------------------------------------------------------- tags -----
  insert into mneme.tags (user_id, name)
  select v_uid, t from mneme.note_tag_names(new.content) t
  on conflict (user_id, name) do nothing;

  insert into mneme.note_tags (note_id, tag_id, user_id, source)
  select new.id, g.id, v_uid, 'inline'
  from mneme.tags g
  where g.user_id = v_uid
    and g.name in (select t from mneme.note_tag_names(new.content) t)
  on conflict (note_id, tag_id) do nothing;

  with gone as (
    delete from mneme.note_tags nt
    using mneme.tags g
    where nt.note_id = new.id
      and nt.source = 'inline'
      and g.id = nt.tag_id
      and g.name not in (select t from mneme.note_tag_names(new.content) t)
    returning nt.tag_id
  )
  -- (a data-modifying CTE is invisible to its own main query, so "still used"
  --  means: used by some OTHER note)
  delete from mneme.tags g
  where g.id in (select tag_id from gone)
    and not exists (
      select 1 from mneme.note_tags x where x.tag_id = g.id and x.note_id <> new.id);

  ---------------------------------------------------------------- links -----
  insert into mneme.note_links (user_id, source_note_id, target_note_id)
  select distinct v_uid, new.id, x.target
  from (
    select mneme.resolve_note_ref(r, v_uid) as target
    from mneme.note_link_refs(new.content) r
  ) x
  where x.target is not null and x.target <> new.id
  on conflict (source_note_id, target_note_id) do nothing;

  delete from mneme.note_links l
  where l.source_note_id = new.id
    and l.target_note_id not in (
      select x.target
      from (
        select mneme.resolve_note_ref(r, v_uid) as target
        from mneme.note_link_refs(new.content) r
      ) x
      where x.target is not null
    );

  ---------------------------------------------------------------- tasks -----
  perform mneme.sync_note_tasks(new.id, v_uid, new.content);

  return null;
end
$$;


-- ------------------------------------------------------------------- RPCs --
-- Any state. A note task gets its marker written by the after-trigger.
create or replace function mneme.set_task_state(p_task_id uuid, p_state text)
returns mneme.tasks
language plpgsql
set search_path = ''
as $$
declare
  t mneme.tasks;
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
  select * into t from mneme.tasks where id = p_task_id;
  return t;
end
$$;

-- Deletes any task with its subtasks. A note task has its line — and the
-- indented lines under it — removed from the note (History keeps the text).
create or replace function mneme.delete_task(p_task_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  t         mneme.tasks;
  v_content text;
  v_lines   text[];
  v_n       integer;
  v_end     integer;
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
  v_n := mneme.task_line_in(v_content, t.line_key, t.position);
  if v_n is null then
    update mneme.tasks set removed_at = now() where id = t.id;
    return;
  end if;
  v_lines := string_to_array(v_content, E'\n');
  v_end := mneme.block_end(v_lines, v_n);
  v_lines := v_lines[1:v_n - 1] || v_lines[v_end + 1:];
  update mneme.notes set content = array_to_string(v_lines, E'\n') where id = t.note_id;
end
$$;

create or replace function mneme.rename_task(p_task_id uuid, p_title text)
returns void
language plpgsql
set search_path = ''
as $$
declare
  t         mneme.tasks;
  v_title   text := left(btrim(regexp_replace(coalesce(p_title, ''), '\s+', ' ', 'g')), 500);
  v_content text;
  v_lines   text[];
  v_line_no integer;
  v_prefix  text;
begin
  if v_title = '' then
    raise exception 'task title is empty' using errcode = '22023';
  end if;
  select * into t from mneme.tasks
   where id = p_task_id and user_id = (select auth.uid()) for update;
  if not found then
    raise exception 'task not found' using errcode = 'P0002';
  end if;

  if t.source = 'standalone' then
    update mneme.tasks set title = v_title where id = t.id;
    return;
  end if;

  select n.content into v_content from mneme.notes n where n.id = t.note_id for update;
  v_line_no := mneme.task_line_in(v_content, t.line_key, t.position);
  if v_line_no is null then
    raise exception 'task line not found in note' using errcode = 'P0002';
  end if;

  -- pre-set the key so the sync trigger re-matches this task exactly (pass 1)
  update mneme.tasks set title = v_title, line_key = lower(v_title) where id = t.id;

  v_lines  := string_to_array(v_content, E'\n');
  v_prefix := substring(v_lines[v_line_no] from '^(\s*(?:[-*+]|[0-9]+[.)])\s+\[[ xX/hH-]\]\s+)');
  v_lines[v_line_no] := v_prefix || v_title;
  update mneme.notes set content = array_to_string(v_lines, E'\n') where id = t.note_id;
end
$$;

-- where a new child line goes under note line p_n: after its block, at its children's indent
create or replace function mneme.child_slot(p_lines text[], p_n integer, out v_after integer, out v_indent integer)
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_base integer := mneme.line_indent(p_lines[p_n]);
begin
  v_after := mneme.block_end(p_lines, p_n);
  v_indent := v_base + 2;
  for k in p_n + 1 .. v_after loop
    if btrim(p_lines[k]) <> '' then v_indent := mneme.line_indent(p_lines[k]); exit; end if;
  end loop;
end
$$;

-- where a new step of a note sequence goes: after the last step's block, same indent, next number
create or replace function mneme.step_slot(p_lines text[], p_seq uuid, p_content text,
                                          out v_after integer, out v_indent integer, out v_number integer)
language plpgsql
stable
set search_path = ''
as $$
declare
  r record;
  v_last integer;
begin
  v_number := 0;
  for r in select t.line_key, t.position from mneme.tasks t
            where t.sequence_id = p_seq and t.removed_at is null order by t.sort_order, t.created_at loop
    v_last := mneme.task_line_in(p_content, r.line_key, r.position);
    v_number := v_number + 1;
  end loop;
  if v_last is null then raise exception 'sequence not found in the note' using errcode = 'P0002'; end if;
  v_after := mneme.block_end(p_lines, v_last);
  v_indent := mneme.line_indent(p_lines[v_last]);
  v_number := v_number + 1;
end
$$;

-- A subtask (or, with p_sequence, the next step). Under a task written in a
-- note, the line is added to the note under it.
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
end
$$;

-- A sequence with its first step. Under a note task it is written into the
-- note as "Name:" followed by "1. [ ] step".
create or replace function mneme.add_sequence(p_parent uuid, p_title text, p_first_step text)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  p         mneme.tasks;
  v_title   text := nullif(left(btrim(coalesce(p_title, '')), 200), '');
  v_step    text := left(btrim(regexp_replace(coalesce(p_first_step, ''), '\s+', ' ', 'g')), 500);
  v_id      uuid;
  v_content text;
  v_lines   text[];
  v_n       integer;
  v_slot    record;
begin
  if v_step = '' then raise exception 'task title is empty' using errcode = '22023'; end if;
  select * into p from mneme.tasks where id = p_parent and user_id = (select auth.uid()) for update;
  if not found then raise exception 'task not found' using errcode = 'P0002'; end if;

  if p.source = 'standalone' then
    insert into mneme.task_sequences (task_id, title, sort_order)
    values (p_parent, v_title, coalesce((select max(sort_order) from mneme.task_sequences where task_id = p_parent), 0) + 1)
    returning id into v_id;
    insert into mneme.tasks (source, title, sequence_id) values ('standalone', v_step, v_id);
    return v_id;
  end if;

  select n.content into v_content from mneme.notes n where n.id = p.note_id for update;
  v_lines := string_to_array(v_content, E'\n');
  v_n := mneme.task_line_in(v_content, p.line_key, p.position);
  if v_n is null then raise exception 'task line not found in note' using errcode = 'P0002'; end if;
  select * into v_slot from mneme.child_slot(v_lines, v_n);
  v_lines := v_lines[1:v_slot.v_after]
          || (repeat(' ', v_slot.v_indent) || coalesce(v_title, 'Steps') || ':')
          || (repeat(' ', v_slot.v_indent) || '1. [ ] ' || v_step)
          || v_lines[v_slot.v_after + 1:];
  update mneme.notes set content = array_to_string(v_lines, E'\n') where id = p.note_id;
  select s.id into v_id from mneme.task_sequences s where s.task_id = p_parent and s.note_id = p.note_id
   order by s.sort_order desc limit 1;
  return v_id;
end
$$;

-- Move a task (with its subtasks) under another task, into one of its
-- sequences, or to the top (p_parent null). Note text follows:
--   within one note          the lines move and re-indent
--   into another note        the lines move there; the old spot keeps a link line
--   out of a note            the lines become standalone tasks; the old spot keeps a [[T-…]] link line
--   standalone into a note   the tasks are written into the note
--   a note task to the top   it is outdented to the top of its note
-- A task that leaves a parent in another place keeps a dotted "related" link to it.
create or replace function mneme.move_task(p_task uuid, p_parent uuid, p_sequence uuid default null)
returns void
language plpgsql
set search_path = ''
as $$
declare
  t        mneme.tasks;
  np       mneme.tasks;
  v_seq    mneme.task_sequences;
  v_prev   text;
  v_old    uuid;
  v_ids    uuid[];
  src      text; dst text;
  sl       text[]; dl text[];
  v_n      integer; v_end integer;
  v_block  text[];
  v_slot   record;
  v_marker text;
  v_link   text;
  v_root   mneme.tasks;
  v_rn     integer;
  v_target text;
begin
  select * into t from mneme.tasks where id = p_task and user_id = (select auth.uid()) for update;
  if not found then raise exception 'task not found' using errcode = 'P0002'; end if;
  if p_parent is not null then
    select * into np from mneme.tasks where id = p_parent and user_id = (select auth.uid());
    if not found then raise exception 'task not found' using errcode = 'P0002'; end if;
  end if;
  v_ids := array(select mneme.task_subtree_ids(t.id));
  if p_parent is not null and p_parent = any (v_ids) then
    raise exception 'A task can’t go under one of its own subtasks.';
  end if;
  if p_sequence is not null then
    select * into v_seq from mneme.task_sequences where id = p_sequence;
    if not found or v_seq.task_id is distinct from p_parent then
      raise exception 'That sequence belongs to another task.';
    end if;
  end if;
  v_old := t.parent_id;
  if v_old is not distinct from p_parent and t.sequence_id is not distinct from p_sequence then return; end if;

  v_prev := coalesce(current_setting('mneme.move', true), '');
  perform set_config('mneme.move', 'on', true);

  -- the block of note lines the task heads
  if t.source = 'note' then
    select n.content into src from mneme.notes n where n.id = t.note_id for update;
    sl := string_to_array(src, E'\n');
    v_n := mneme.task_line_in(src, t.line_key, t.position);
    if v_n is null then raise exception 'task line not found in note' using errcode = 'P0002'; end if;
    v_end := mneme.block_end(sl, v_n);
    v_block := sl[v_n:v_end];
  end if;

  if t.source = 'standalone' and (p_parent is null or np.source = 'standalone') then
    ------------------------------------------------ standalone -> standalone
    update mneme.tasks set parent_id = p_parent, sequence_id = p_sequence where id = t.id;

  elsif t.source = 'standalone' then
    ------------------------------------------------ standalone -> into a note
    select n.content into dst from mneme.notes n where n.id = np.note_id for update;
    dl := string_to_array(dst, E'\n');
    if p_sequence is not null then
      select * into v_slot from mneme.step_slot(dl, p_sequence, dst);
      v_marker := v_slot.v_number || '.';
    else
      select * into v_slot from mneme.child_slot(dl, mneme.task_line_in(dst, np.line_key, np.position));
      v_marker := '-';
    end if;
    v_block := mneme.render_task_lines(t.id, v_slot.v_indent, v_marker);
    -- the rows become the note's (pre-keyed so the sync re-matches them, not new rows)
    update mneme.tasks x set sequence_id = null where x.id = any (v_ids);
    delete from mneme.task_sequences s where s.task_id = any (v_ids);
    update mneme.tasks x
       set source = 'note', note_id = np.note_id, parent_id = null, position = 0,
           line_key = left(lower(regexp_replace(btrim(x.title), '\s+', ' ', 'g')), 500),
           line_marker = mneme.state_marker(x.state)
     where x.id = any (v_ids);
    dl := dl[1:v_slot.v_after] || v_block || dl[v_slot.v_after + 1:];
    update mneme.notes set content = array_to_string(dl, E'\n') where id = np.note_id;

  elsif p_parent is not null and np.source = 'note' and np.note_id = t.note_id then
    ------------------------------------------------ within one note
    sl := sl[1:v_n - 1] || sl[v_end + 1:];
    src := array_to_string(sl, E'\n');
    if p_sequence is not null then
      select * into v_slot from mneme.step_slot(sl, p_sequence, src);
      v_marker := v_slot.v_number || '.';
    else
      select * into v_slot from mneme.child_slot(sl, mneme.task_line_in(src, np.line_key, np.position));
      v_marker := '-';
    end if;
    v_block := mneme.reindent(v_block, v_slot.v_indent - mneme.line_indent(v_block[1]), v_marker);
    sl := sl[1:v_slot.v_after] || v_block || sl[v_slot.v_after + 1:];
    update mneme.tasks x set sequence_id = null where x.id = any (v_ids);
    update mneme.notes set content = array_to_string(sl, E'\n') where id = t.note_id;

  elsif p_parent is not null and np.source = 'note' then
    ------------------------------------------------ into another note
    select n.public_id into v_target from mneme.notes n where n.id = np.note_id;
    v_link := repeat(' ', mneme.line_indent(sl[v_n])) || '- ↗ ' || t.title || ' → [[' || v_target || ']]';
    sl := sl[1:v_n - 1] || v_link || sl[v_end + 1:];
    update mneme.tasks x set sequence_id = null, note_id = np.note_id, position = 0 where x.id = any (v_ids);
    update mneme.notes set content = array_to_string(sl, E'\n') where id = t.note_id;
    select n.content into dst from mneme.notes n where n.id = np.note_id for update;
    dl := string_to_array(dst, E'\n');
    if p_sequence is not null then
      select * into v_slot from mneme.step_slot(dl, p_sequence, dst);
      v_marker := v_slot.v_number || '.';
    else
      select * into v_slot from mneme.child_slot(dl, mneme.task_line_in(dst, np.line_key, np.position));
      v_marker := '-';
    end if;
    v_block := mneme.reindent(v_block, v_slot.v_indent - mneme.line_indent(v_block[1]), v_marker);
    dl := dl[1:v_slot.v_after] || v_block || dl[v_slot.v_after + 1:];
    update mneme.notes set content = array_to_string(dl, E'\n') where id = np.note_id;

  elsif p_parent is null then
    ------------------------------------------------ a note task to the top of its note
    select * into v_root from mneme.tasks where id = mneme.task_root_id(t.id);
    sl := sl[1:v_n - 1] || sl[v_end + 1:];
    src := array_to_string(sl, E'\n');
    v_rn := mneme.task_line_in(src, v_root.line_key, v_root.position);
    v_block := mneme.reindent(v_block, -mneme.line_indent(v_block[1]), '-');
    if v_rn is null then
      sl := sl || v_block;
    else
      v_rn := mneme.block_end(sl, v_rn);
      sl := sl[1:v_rn] || v_block || sl[v_rn + 1:];
    end if;
    update mneme.tasks x set sequence_id = null where x.id = t.id;
    update mneme.notes set content = array_to_string(sl, E'\n') where id = t.note_id;

  else
    ------------------------------------------------ out of a note, under a standalone task
    v_link := repeat(' ', mneme.line_indent(sl[v_n])) || '- ↗ ' || t.title || ' → [[' || mneme.task_code(t.id) || ']]';
    sl := sl[1:v_n - 1] || v_link || sl[v_end + 1:];
    -- sequences inside the moved subtree come along as standalone ones
    update mneme.task_sequences s set note_id = null, note_key = null where s.task_id = any (v_ids);
    update mneme.tasks x
       set source = 'standalone', note_id = null, line_key = null, line_marker = null, position = 0
     where x.id = any (v_ids);
    update mneme.tasks set parent_id = p_parent, sequence_id = p_sequence where id = t.id;
    update mneme.notes set content = array_to_string(sl, E'\n') where id = t.note_id;
  end if;

  perform set_config('mneme.move', v_prev, true);

  -- a note task leaving for another place keeps a dotted connection to its old parent
  if v_old is not null and t.source = 'note' and p_parent is not null
     and (np.source = 'standalone' or np.note_id <> t.note_id) then
    insert into mneme.task_links (from_task_id, to_task_id, kind) values (v_old, t.id, 'related')
    on conflict do nothing;
  end if;

  -- states may have rolled up while moving
  perform mneme.write_task_markers(t.note_id);
  if p_parent is not null and np.source = 'note' then perform mneme.write_task_markers(np.note_id); end if;
end
$$;

-- a [[T-…]] code -> the task and its tree
create or replace function mneme.find_task(p_code text)
returns table (id uuid, root_id uuid)
language sql
stable
set search_path = ''
as $$
  select a.id, a.root_id from mneme.tasks_active a
  where mneme.task_code(a.id) = upper(btrim(p_code))
  limit 1
$$;

revoke all on function mneme.add_subtask(uuid, text, uuid) from public, anon;
revoke all on function mneme.add_sequence(uuid, text, text) from public, anon;
revoke all on function mneme.move_task(uuid, uuid, uuid) from public, anon;
revoke all on function mneme.find_task(text) from public, anon;
grant execute on function mneme.add_subtask(uuid, text, uuid) to authenticated;
grant execute on function mneme.add_sequence(uuid, text, text) to authenticated;
grant execute on function mneme.move_task(uuid, uuid, uuid) to authenticated;
grant execute on function mneme.find_task(text) to authenticated;

-- ------------------------------------------------------------------- view --
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
       mneme.task_code(t.id) as code
from mneme.tasks t
left join mneme.notes n on n.id = t.note_id
left join mneme.tasks p on p.id = t.parent_id
where t.removed_at is null
  and (t.note_id is null or n.deleted_at is null)
  and mneme.task_ancestors_live(t.parent_id);
grant select on mneme.tasks_active to authenticated;

create or replace function mneme.task_tree(p_root uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with recursive tree as (
    select t.id from mneme.tasks t where t.id = p_root
    union all
    select c.id from mneme.tasks c join tree on c.parent_id = tree.id
  ),
  rows as (select a.* from mneme.tasks_active a where a.id in (select id from tree))
  select jsonb_build_object(
    'tasks', coalesce((select jsonb_agg(to_jsonb(r) order by r.sort_order, r.created_at, r.id) from rows r), '[]'::jsonb),
    'sequences', coalesce((
      select jsonb_agg(jsonb_build_object('id', s.id, 'task_id', s.task_id, 'title', s.title, 'sort_order', s.sort_order, 'created_at', s.created_at, 'note_id', s.note_id)
                       order by s.sort_order, s.created_at, s.id)
      from mneme.task_sequences s where s.task_id in (select id from rows)), '[]'::jsonb),
    'links', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'kind', l.kind, 'from_task_id', l.from_task_id, 'to_task_id', l.to_task_id,
               'other', jsonb_build_object('id', o.id, 'title', o.title, 'state', o.state, 'root_id', o.root_id))
             order by l.created_at)
      from mneme.task_links l
      join mneme.tasks_active o
        on o.id = case when l.from_task_id in (select id from rows) then l.to_task_id else l.from_task_id end
      where l.from_task_id in (select id from rows) or l.to_task_id in (select id from rows)), '[]'::jsonb),
    'canvas_ids', coalesce((
      select jsonb_agg(ct.canvas_id) from mneme.canvas_tasks ct where ct.task_id = p_root), '[]'::jsonb)
  )
$$;


-- ---------------------------------------------------------------- backfill --
do $$
declare r record;
begin
  for r in select n.id, n.user_id, n.content from mneme.notes n where n.content ~ '\[[ xX/hH-]\]' loop
    perform mneme.sync_note_tasks(r.id, r.user_id, r.content);
  end loop;
end $$;

commit;
