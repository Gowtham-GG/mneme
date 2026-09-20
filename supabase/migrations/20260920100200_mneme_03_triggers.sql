-- =============================================================================
-- Mneme 03 — text parsing helpers, ID assignment, triggers
-- All functions use `set search_path = ''` and schema-qualified names.
-- Only mneme.next_public_id is SECURITY DEFINER (it must reach note_counters).
-- =============================================================================
begin;

-- ======================================================== text parsing ======
-- Lines of a note that are NOT inside a ``` / ~~~ fenced block. Line numbers
-- (n) refer to the original text so a line can be rewritten in place later.
create or replace function mneme.note_lines(p_content text)
returns table (n integer, line text)
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_line     text;
  v_n        integer := 0;
  v_in_fence boolean := false;
begin
  foreach v_line in array string_to_array(coalesce(p_content, ''), E'\n') loop
    v_n := v_n + 1;
    if v_line ~ '^\s{0,3}(```|~~~)' then
      v_in_fence := not v_in_fence;
      continue;
    end if;
    if v_in_fence then
      continue;
    end if;
    n := v_n;
    line := v_line;
    return next;
  end loop;
end
$$;

-- #tags (a letter first, so "#123" issue numbers and "# Heading" are ignored;
-- not preceded by a word char, "/" "#" "&" so URLs/anchors/entities are ignored).
create or replace function mneme.note_tag_names(p_content text)
returns setof text
language sql
immutable
set search_path = ''
as $$
  select distinct t
  from (
    select rtrim(lower(m.g[1]), '/-') as t
    from mneme.note_lines(p_content) l,
         lateral regexp_matches(
           -- ignore `code` and [[link|labels]] (a label may contain "#words")
           regexp_replace(regexp_replace(l.line, '`[^`]*`', ' ', 'g'), '\[\[[^\]]*\]\]', ' ', 'g'),
           '(?<![[:alnum:]_&/#])#([[:alpha:]][[:alnum:]_/-]*)', 'g'
         ) as m(g)
  ) x
  where mneme.is_valid_tag(t)
$$;

-- [[N-260920-042]], [[N-260920-042|label]], [[Some title]], or a bare
-- N-260920-042. Returns the raw reference (IDs upper-cased).
create or replace function mneme.note_link_refs(p_content text)
returns setof text
language sql
immutable
set search_path = ''
as $$
  with l as (
    select regexp_replace(line, '`[^`]*`', ' ', 'g') as line
    from mneme.note_lines(p_content)
  )
  select btrim(m.g[1]) as ref
  from l, lateral regexp_matches(l.line, '\[\[([^\]|]+)(?:\|[^\]]*)?\]\]', 'g') as m(g)
  where btrim(m.g[1]) <> ''
  union
  select upper(m.g[1])
  from l, lateral regexp_matches(
         l.line, '(?<![[:alnum:]-])([Nn]-[0-9]{6}-[0-9]{3,})(?![[:alnum:]-])', 'g') as m(g)
$$;

-- "- [ ] text", "* [x] text", "1. [ ] text" → (line, done, title, key)
create or replace function mneme.note_task_lines(p_content text)
returns table (n integer, done boolean, title text, key text)
language sql
immutable
set search_path = ''
as $$
  select l.n,
         lower(m.g[1]) = 'x',
         left(regexp_replace(m.g[2], '\s+$', ''), 500),
         left(lower(regexp_replace(regexp_replace(m.g[2], '\s+$', ''), '\s+', ' ', 'g')), 500)
  from mneme.note_lines(p_content) l,
       lateral regexp_matches(
         l.line, '^\s*(?:[-*+]|[0-9]+[.)])\s+\[([ xX])\]\s+(\S.*)$'
       ) as m(g)
$$;

-- Resolve a [[reference]] to one of the caller's notes:
-- an ID matches public_id; anything else matches an exact title (case-insensitive,
-- newest note wins). Trashed notes never resolve.
create or replace function mneme.resolve_note_ref(p_ref text, p_user uuid)
returns uuid
language sql
stable
set search_path = ''
as $$
  select n.id
  from mneme.notes n
  where n.user_id = p_user
    and n.deleted_at is null
    and case
          when upper(p_ref) ~ '^N-[0-9]{6}-[0-9]{3,}$' then n.public_id = upper(p_ref)
          else lower(n.title) = lower(p_ref)
        end
  order by n.created_at desc
  limit 1
$$;

-- ==================================================== note ID assignment ====
-- N-YYMMDD-NNN: date in the user's timezone, per-user per-day counter.
-- SECURITY DEFINER because note_counters has no client access. The caller is
-- always auth.uid(); p_user is honoured ONLY when there is no JWT user (admin
-- SQL), so a signed-in user can never advance someone else's counter.
create or replace function mneme.next_public_id(p_at timestamptz default now(), p_user uuid default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := coalesce(auth.uid(), p_user);
  v_tz  text;
  v_day date;
  v_seq integer;
begin
  if v_uid is null then
    raise exception 'next_public_id: no user' using errcode = '28000';
  end if;

  insert into mneme.settings (user_id) values (v_uid) on conflict (user_id) do nothing;
  select s.timezone into v_tz from mneme.settings s where s.user_id = v_uid;

  begin
    v_day := (p_at at time zone coalesce(v_tz, 'UTC'))::date;
  exception when others then
    v_day := (p_at at time zone 'UTC')::date;
  end;

  insert into mneme.note_counters as c (user_id, day, last_seq)
  values (v_uid, v_day, 1)
  on conflict (user_id, day) do update set last_seq = c.last_seq + 1
  returning c.last_seq into v_seq;

  -- lpad() would TRUNCATE past 3 digits (1000 -> '100'), so only pad below 1000
  return 'N-' || to_char(v_day, 'YYMMDD') || '-'
         || case when v_seq < 1000 then lpad(v_seq::text, 3, '0') else v_seq::text end;
end
$$;
revoke all on function mneme.next_public_id(timestamptz, uuid) from public, anon;
grant execute on function mneme.next_public_id(timestamptz, uuid) to authenticated;

-- ============================================================ settings ======
create or replace function mneme.settings_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- reject unknown timezone names up front (would otherwise break ID assignment)
  perform now() at time zone new.timezone;
  new.updated_at := now();
  return new;
end
$$;
drop trigger if exists settings_before_write on mneme.settings;
create trigger settings_before_write
  before insert or update on mneme.settings
  for each row execute function mneme.settings_before_write();

-- =============================================================== notes ======
create or replace function mneme.notes_before_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.created_at := least(new.created_at, now());   -- offline capture time, but never the future
  new.updated_at := now();
  new.title      := nullif(btrim(new.title), '');
  new.version    := 1;
  new.public_id  := mneme.next_public_id(new.created_at, new.user_id);
  return new;
end
$$;
drop trigger if exists notes_before_insert on mneme.notes;
create trigger notes_before_insert
  before insert on mneme.notes
  for each row execute function mneme.notes_before_insert();

create or replace function mneme.notes_before_update()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_edited boolean;
begin
  if new.user_id <> old.user_id then
    raise exception 'user_id is immutable' using errcode = '42501';
  end if;
  new.public_id  := old.public_id;
  new.created_at := old.created_at;
  new.title      := nullif(btrim(new.title), '');

  v_edited := new.title is distinct from old.title or new.content is distinct from old.content;
  if v_edited then
    new.version    := old.version + 1;
    new.updated_at := now();
  else
    new.version    := old.version;
    new.updated_at := old.updated_at;
  end if;

  -- Revision: snapshot the text as it was before this editing burst, at most
  -- once per 15 minutes, keeping the newest 10 per note.
  if new.content is distinct from old.content and old.content <> '' then
    if not exists (
      select 1 from mneme.note_revisions r
      where r.note_id = old.id and r.saved_at > now() - interval '15 minutes'
    ) then
      insert into mneme.note_revisions (user_id, note_id, title, content)
      values (old.user_id, old.id, old.title, old.content);

      delete from mneme.note_revisions r
      where r.note_id = old.id
        and r.id not in (
          select r2.id from mneme.note_revisions r2
          where r2.note_id = old.id
          order by r2.saved_at desc, r2.id desc
          limit 10
        );
    end if;
  end if;
  return new;
end
$$;
drop trigger if exists notes_before_update on mneme.notes;
create trigger notes_before_update
  before update on mneme.notes
  for each row execute function mneme.notes_before_update();

-- ============================= derive tags / links / tasks from the text ====
create or replace function mneme.sync_note_derived()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_uid uuid := new.user_id;
  -- tasks
  nl int[]; nd boolean[]; nt text[]; nk text[];
  eid uuid[]; ekey text[];
  n_new int; n_old int;
  t_of uuid[]; used boolean[];
  i int; j int; v_rid uuid;
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
  select coalesce(array_agg(t.n order by t.n), '{}'),
         coalesce(array_agg(t.done order by t.n), '{}'),
         coalesce(array_agg(t.title order by t.n), '{}'),
         coalesce(array_agg(t.key order by t.n), '{}')
    into nl, nd, nt, nk
    from mneme.note_task_lines(new.content) t;

  select coalesce(array_agg(x.id order by x.position, x.created_at, x.id), '{}'),
         coalesce(array_agg(x.line_key order by x.position, x.created_at, x.id), '{}')
    into eid, ekey
    from mneme.tasks x
   where x.note_id = new.id and x.source = 'note' and x.removed_at is null;

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
       where x.note_id = new.id and x.source = 'note'
         and x.removed_at is not null and x.line_key = nk[i]
       order by x.removed_at desc limit 1;
      t_of[i] := v_rid;
    end if;

    if t_of[i] is null then
      insert into mneme.tasks (user_id, note_id, source, title, status, position, line_key)
      values (v_uid, new.id, 'note', nt[i], case when nd[i] then 'done' else 'open' end, nl[i], nk[i]);
    else
      update mneme.tasks x
         set title = nt[i], line_key = nk[i], position = nl[i], removed_at = null,
             status = case when nd[i] then 'done' else 'open' end
       where x.id = t_of[i]
         and (x.title, x.line_key, x.position, x.removed_at, x.status)
             is distinct from (nt[i], nk[i], nl[i], null::timestamptz,
                               case when nd[i] then 'done' else 'open' end);
    end if;
  end loop;

  -- lines that disappeared: keep the task for history, hide it
  for j in 1..n_old loop
    if not used[j] then
      update mneme.tasks set removed_at = now() where id = eid[j];
    end if;
  end loop;

  return null;
end
$$;
drop trigger if exists notes_sync_derived_ins on mneme.notes;
create trigger notes_sync_derived_ins
  after insert on mneme.notes
  for each row execute function mneme.sync_note_derived();
drop trigger if exists notes_sync_derived_upd on mneme.notes;
create trigger notes_sync_derived_upd
  after update of content on mneme.notes
  for each row when (old.content is distinct from new.content)
  execute function mneme.sync_note_derived();

-- =============================================================== tasks ======
create or replace function mneme.tasks_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or old.status is distinct from new.status then
    new.completed_at := case when new.status = 'done' then coalesce(new.completed_at, now()) else null end;
  end if;
  new.updated_at := now();
  return new;
end
$$;
drop trigger if exists tasks_before_write on mneme.tasks;
create trigger tasks_before_write
  before insert or update on mneme.tasks
  for each row execute function mneme.tasks_before_write();

commit;
