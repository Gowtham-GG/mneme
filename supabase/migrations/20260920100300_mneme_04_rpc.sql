-- =============================================================================
-- Mneme 04 — read model: view + RPCs (all SECURITY INVOKER, RLS applies)
-- =============================================================================
begin;

-- Open/done tasks that are still visible: not removed from their note, and the
-- note (if any) is not in the trash.
create or replace view mneme.tasks_active
with (security_invoker = true) as
select t.id, t.user_id, t.note_id, t.source, t.title, t.status, t.priority,
       t.due_date, t.position, t.created_at, t.completed_at,
       n.public_id as note_public_id,
       n.title     as note_title
from mneme.tasks t
left join mneme.notes n on n.id = t.note_id
where t.removed_at is null
  and (t.note_id is null or n.deleted_at is null);
grant select on mneme.tasks_active to authenticated;

-- ------------------------------------------------------------------ search --
-- Query grammar (all optional, combinable):
--   free words          full-text (websearch syntax) + title / paper-ref substring
--   #tag                tag or any nested tag (#jvm matches jvm/memory)
--   type:question       note_type
--   after:YYYY-MM-DD    created on/after (in the user's timezone)
--   before:YYYY-MM-DD   created before
--   is:starred|archived|inbox|task|trash
--   N-260920-042 / N-2609   ID (exact or prefix)
-- Archived notes are included by default; trashed ones only with is:trash.
create or replace function mneme.search_notes(
  p_query  text    default '',
  p_limit  integer default 30,
  p_offset integer default 0
)
returns table (
  id uuid, public_id text, title text, snippet text, note_type text,
  is_starred boolean, created_at timestamptz, updated_at timestamptz,
  archived_at timestamptz, deleted_at timestamptz, rank real, tags text[],
  preview text   -- start of the body, WITHOUT highlight markers (for deriving a title)
)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_uid    uuid := (select auth.uid());
  v_q      text := coalesce(p_query, '');
  v_tz     text := 'UTC';
  v_tags   text[] := '{}';
  v_ids    text[] := '{}';
  v_type   text;
  v_after  timestamptz;
  v_before timestamptz;
  v_starred boolean := false;
  v_archived boolean := false;
  v_inbox  boolean := false;
  v_task   boolean := false;
  v_trash  boolean := false;
  v_text   text;
  v_like   text;
  v_tsq    tsquery;
  m        text[];
  d        date;
begin
  select s.timezone into v_tz from mneme.settings s where s.user_id = v_uid;
  v_tz := coalesce(v_tz, 'UTC');
  p_limit  := least(greatest(coalesce(p_limit, 30), 1), 100);
  p_offset := least(greatest(coalesce(p_offset, 0), 0), 5000);

  for m in select regexp_matches(v_q, '(?:^|\s)#([^\s#]+)', 'g') loop
    v_tags := v_tags || rtrim(lower(m[1]), '/-');
  end loop;
  for m in select regexp_matches(v_q, '(?:^|\s)(N-[0-9-]*[0-9])(?=\s|$)', 'gi') loop
    v_ids := v_ids || upper(m[1]);
  end loop;

  select (regexp_match(v_q, '(?:^|\s)type:(\w+)', 'i'))[1] into v_type;
  if v_type is not null then v_type := lower(v_type); end if;

  begin
    select (regexp_match(v_q, '(?:^|\s)after:(\d{4}-\d{2}-\d{2})', 'i'))[1]::date into d;
    if d is not null then v_after := d::timestamp at time zone v_tz; end if;
    d := null;
    select (regexp_match(v_q, '(?:^|\s)before:(\d{4}-\d{2}-\d{2})', 'i'))[1]::date into d;
    if d is not null then v_before := d::timestamp at time zone v_tz; end if;
  exception when others then
    v_after := null; v_before := null;   -- malformed date: ignore the operator
  end;

  v_starred  := v_q ~* '(?:^|\s)is:starred(?=\s|$)';
  v_archived := v_q ~* '(?:^|\s)is:archived(?=\s|$)';
  v_inbox    := v_q ~* '(?:^|\s)is:inbox(?=\s|$)';
  v_task     := v_q ~* '(?:^|\s)is:task(?=\s|$)';
  v_trash    := v_q ~* '(?:^|\s)is:trash(?=\s|$)';

  -- what is left after removing every operator token is the free text
  v_text := v_q;
  v_text := regexp_replace(v_text, '(?:^|\s)#[^\s#]+', ' ', 'g');
  v_text := regexp_replace(v_text, '(?:^|\s)(type|after|before|is):\S*', ' ', 'gi');
  v_text := regexp_replace(v_text, '(?:^|\s)N-[0-9-]*[0-9](?=\s|$)', ' ', 'gi');
  v_text := btrim(regexp_replace(v_text, '\s+', ' ', 'g'));

  if v_text <> '' then
    v_tsq  := websearch_to_tsquery('english', v_text);
    v_like := '%' || replace(replace(replace(v_text, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  return query
  with hits as (
    select n.id as nid, n.public_id as npid, n.title as ntitle, n.content as ncontent,
           n.note_type as ntype, n.is_starred as nstar, n.created_at as ncre,
           n.updated_at as nupd, n.archived_at as narch, n.deleted_at as ndel,
           case when v_text = '' then 0::real
                else (ts_rank(mneme.note_fts(n.title, n.content), v_tsq)
                      + case when n.title ilike v_like then 0.5 else 0 end)::real
           end as nrank
    from mneme.notes n
    where n.user_id = v_uid
      and (case when v_trash then n.deleted_at is not null else n.deleted_at is null end)
      and (v_text = ''
           or mneme.note_fts(n.title, n.content) @@ v_tsq
           or n.title ilike v_like
           or n.paper_ref ilike v_like)
      and (v_type is null or n.note_type = v_type)
      and (v_after  is null or n.created_at >= v_after)
      and (v_before is null or n.created_at <  v_before)
      and (not v_starred  or n.is_starred)
      and (not v_archived or n.archived_at is not null)
      and (not v_inbox    or (n.note_type = 'capture' and n.archived_at is null))
      and (not v_task or exists (
             select 1 from mneme.tasks t
             where t.note_id = n.id and t.status = 'open' and t.removed_at is null))
      and (cardinality(v_ids) = 0 or exists (
             select 1 from unnest(v_ids) p where n.public_id like p || '%'))
      and not exists (
             select 1 from unnest(v_tags) tg
             where not exists (
               select 1 from mneme.note_tags nt
               join mneme.tags g on g.id = nt.tag_id
               where nt.note_id = n.id and (g.name = tg or g.name like tg || '/%')))
    order by nrank desc, n.created_at desc, n.id desc
    limit p_limit offset p_offset
  )
  select h.nid, h.npid, h.ntitle,
         case when v_text = '' then left(h.ncontent, 200)
              else ts_headline('english', h.ncontent, v_tsq,
                     'MaxFragments=1, MinWords=6, MaxWords=26, StartSel=«, StopSel=»')
         end,
         h.ntype, h.nstar, h.ncre, h.nupd, h.narch, h.ndel, h.nrank,
         coalesce((select array_agg(g.name order by g.name)
                   from mneme.note_tags nt join mneme.tags g on g.id = nt.tag_id
                   where nt.note_id = h.nid), '{}'),
         left(h.ncontent, 300)
  from hits h
  order by h.nrank desc, h.ncre desc, h.nid desc;
end
$$;

-- ------------------------------------------------------------ note context --
-- Everything the side panel needs in one round-trip.
create or replace function mneme.note_context(p_note_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'tags', coalesce((
      select jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name, 'source', nt.source) order by g.name)
      from mneme.note_tags nt join mneme.tags g on g.id = nt.tag_id
      where nt.note_id = p_note_id), '[]'::jsonb),
    'links_to', coalesce((
      select jsonb_agg(jsonb_build_object(
               'link_id', l.id, 'id', n.id, 'public_id', n.public_id, 'title', n.title,
               'relationship_type', l.relationship_type) order by n.created_at desc)
      from mneme.note_links l join mneme.notes n on n.id = l.target_note_id
      where l.source_note_id = p_note_id and n.deleted_at is null), '[]'::jsonb),
    'linked_from', coalesce((
      select jsonb_agg(jsonb_build_object(
               'link_id', l.id, 'id', n.id, 'public_id', n.public_id, 'title', n.title,
               'relationship_type', l.relationship_type) order by n.created_at desc)
      from mneme.note_links l join mneme.notes n on n.id = l.source_note_id
      where l.target_note_id = p_note_id and n.deleted_at is null), '[]'::jsonb),
    'tasks', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', t.id, 'title', t.title, 'status', t.status, 'due_date', t.due_date,
               'priority', t.priority, 'position', t.position) order by t.position)
      from mneme.tasks t
      where t.note_id = p_note_id and t.removed_at is null), '[]'::jsonb)
  )
$$;

-- ------------------------------------------------------------------- tasks --
-- bucket: today (overdue + due today) | upcoming | no_date | completed
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
                 order by t.due_date, t.created_at limit p_limit;
  elsif p_bucket = 'upcoming' then
    return query select * from mneme.tasks_active t
                 where t.status = 'open' and t.due_date > v_today
                 order by t.due_date, t.created_at limit p_limit;
  elsif p_bucket = 'no_date' then
    return query select * from mneme.tasks_active t
                 where t.status = 'open' and t.due_date is null
                 order by t.created_at desc limit p_limit;
  else
    raise exception 'unknown bucket %', p_bucket using errcode = '22023';
  end if;
end
$$;

-- Tick / untick. For a task that mirrors a checkbox line, the LINE in the note
-- is rewritten (the sync trigger then updates the task), so note text and task
-- list can never disagree. Standalone tasks are updated directly.
create or replace function mneme.set_task_done(p_task_id uuid, p_done boolean)
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
  select * into t from mneme.tasks
   where id = p_task_id and user_id = (select auth.uid()) for update;
  if not found then
    raise exception 'task not found' using errcode = 'P0002';
  end if;

  if t.source = 'standalone' then
    update mneme.tasks set status = case when p_done then 'done' else 'open' end
     where id = t.id returning * into t;
    return t;
  end if;

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
    v_lines[v_line_no], '\[[ xX]\]', case when p_done then '[x]' else '[ ]' end);

  update mneme.notes set content = array_to_string(v_lines, E'\n') where id = t.note_id;

  select * into t from mneme.tasks where id = p_task_id;
  return t;
end
$$;

-- -------------------------------------------------------------- tag index --
-- name, distinct notes carrying the tag or any nested child (rollup), and notes
-- carrying exactly this tag. Trashed notes are not counted.
create or replace function mneme.tag_counts()
returns table (name text, note_count bigint, direct_count bigint)
language sql
stable
set search_path = ''
as $$
  with nt as (
    select g.name, x.note_id
    from mneme.note_tags x
    join mneme.tags  g on g.id = x.tag_id
    join mneme.notes n on n.id = x.note_id and n.deleted_at is null
    where x.user_id = (select auth.uid())
  ),
  expanded as (
    select nt.name as tag_name, nt.note_id,
           array_to_string((string_to_array(nt.name, '/'))[1:i], '/') as anc
    from nt
    cross join lateral generate_series(1, cardinality(string_to_array(nt.name, '/'))) i
  )
  select anc, count(distinct note_id), count(distinct note_id) filter (where anc = tag_name)
  from expanded
  group by anc
  order by anc
$$;

-- ------------------------------------------------------------------- trash --
create or replace function mneme.empty_trash()
returns integer
language plpgsql
set search_path = ''
as $$
declare n integer;
begin
  delete from mneme.notes where user_id = (select auth.uid()) and deleted_at is not null;
  get diagnostics n = row_count;
  return n;
end
$$;

-- Explicit function grants (RPCs are for signed-in users only).
revoke all on function mneme.search_notes(text, integer, integer) from public, anon;
revoke all on function mneme.note_context(uuid)                   from public, anon;
revoke all on function mneme.list_tasks(text, integer)            from public, anon;
revoke all on function mneme.set_task_done(uuid, boolean)         from public, anon;
revoke all on function mneme.tag_counts()                         from public, anon;
revoke all on function mneme.empty_trash()                        from public, anon;
grant execute on function mneme.search_notes(text, integer, integer) to authenticated;
grant execute on function mneme.note_context(uuid)                   to authenticated;
grant execute on function mneme.list_tasks(text, integer)            to authenticated;
grant execute on function mneme.set_task_done(uuid, boolean)         to authenticated;
grant execute on function mneme.tag_counts()                         to authenticated;
grant execute on function mneme.empty_trash()                        to authenticated;

commit;
