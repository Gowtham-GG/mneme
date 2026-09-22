-- =============================================================================
-- Mneme 10 — tasks get an optional due TIME (in addition to the existing due
-- DATE), and a due_task_count() RPC for a dock badge.
-- due_time is a plain `time`, never a timestamptz: it composes with the
-- existing date-only timezone-bucketing in list_tasks/next_public_id without
-- touching that math, and — like due_date/priority already do — it is never
-- referenced by mneme.sync_note_derived, so a text-only edit of a task's
-- checkbox line leaves it untouched (see the trigger's own update list in
-- 03_triggers.sql). Additive; nothing in `public` (Argus) is touched.
-- =============================================================================
begin;

alter table mneme.tasks add column if not exists due_time time;

-- tasks_active view: CREATE OR REPLACE VIEW may only append columns, so
-- due_time goes at the end.
create or replace view mneme.tasks_active
with (security_invoker = true) as
select t.id, t.user_id, t.note_id, t.source, t.title, t.status, t.priority,
       t.due_date, t.position, t.created_at, t.completed_at,
       n.public_id as note_public_id,
       n.title     as note_title,
       t.due_time
from mneme.tasks t
left join mneme.notes n on n.id = t.note_id
where t.removed_at is null
  and (t.note_id is null or n.deleted_at is null);
grant select on mneme.tasks_active to authenticated;

-- note_context: add due_time next to the other per-task fields.
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
               'due_time', t.due_time, 'priority', t.priority, 'position', t.position)
               order by t.position)
      from mneme.tasks t
      where t.note_id = p_note_id and t.removed_at is null), '[]'::jsonb)
  )
$$;

-- list_tasks: same buckets, now tie-broken by due_time within a day.
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

-- Count of open, due-today-or-earlier tasks — same shape as inbox_count(),
-- for a dock badge on the Tasks icon.
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
  );
end
$$;

revoke all on function mneme.due_task_count() from public, anon;
grant execute on function mneme.due_task_count() to authenticated;

commit;
