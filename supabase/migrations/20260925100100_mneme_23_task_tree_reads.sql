-- =============================================================================
-- Mneme 23 — reads for the task-tree UI.
--   tasks_active       + root_id (top of the task's tree) and parent_title,
--                      for "Launch site ›" breadcrumbs on subtasks
--   list_tasks()       Upcoming / No date / Done list main tasks only (their
--                      subtasks live inside the tree); Today still lists every
--                      actionable item, subtasks included
--   task_tree(root)    one main task's whole tree: tasks, sequences, links
--                      (with the other end's title/state/root, which may be in
--                      another tree) and the canvases it is on
-- Additive; nothing in `public` (Argus) is touched.
-- =============================================================================
begin;

-- top of the task's tree (itself when it has no parent)
create or replace function mneme.task_root_id(p_id uuid)
returns uuid
language sql
stable
set search_path = ''
as $$
  with recursive up as (
    select t.id, t.parent_id, 0 as d from mneme.tasks t where t.id = p_id
    union all
    select p.id, p.parent_id, u.d + 1 from mneme.tasks p join up u on p.id = u.parent_id where u.d < 100
  )
  select id from up where parent_id is null order by d desc limit 1
$$;

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
       p.title as parent_title
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
  elsif p_bucket = 'today' then
    return query select * from mneme.tasks_active t
                 where t.status = 'open' and t.due_date <= v_today
                   and t.state <> 'on_hold' and not t.blocked and t.child_resolved = t.child_count
                 order by t.due_date, t.due_time nulls last, t.created_at limit p_limit;
  elsif p_bucket = 'upcoming' then
    return query select * from mneme.tasks_active t
                 where t.status = 'open' and t.due_date > v_today and t.parent_id is null
                 order by t.due_date, t.due_time nulls last, t.created_at limit p_limit;
  elsif p_bucket = 'no_date' then
    return query select * from mneme.tasks_active t
                 where t.status = 'open' and t.due_date is null and t.parent_id is null
                 order by t.created_at desc limit p_limit;
  else
    raise exception 'unknown bucket %', p_bucket using errcode = '22023';
  end if;
end
$$;

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
      select jsonb_agg(jsonb_build_object('id', s.id, 'task_id', s.task_id, 'title', s.title, 'sort_order', s.sort_order, 'created_at', s.created_at)
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

revoke all on function mneme.task_tree(uuid) from public, anon;
grant execute on function mneme.task_tree(uuid) to authenticated;

commit;
