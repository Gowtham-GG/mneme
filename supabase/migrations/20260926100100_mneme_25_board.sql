-- =============================================================================
-- Mneme 25 — the task board.
--   board_positions     where a box sits on a board ('inbox' or a canvas id);
--                       boxes without one are laid out automatically
--   board_data(canvas)  everything one board draws: its main tasks (a canvas's,
--                       or — for the Inbox, canvas = null — those on no canvas)
--                       with their whole trees, sequences, links (the far end
--                       carries its tree and canvases, for cross-canvas link
--                       boxes) and saved positions. Finished main tasks only
--                       with p_done.
-- Additive; nothing in `public` (Argus) is touched.
-- =============================================================================
begin;

create table if not exists mneme.board_positions (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  board   text not null check (board = 'inbox' or board ~ '^[0-9a-f-]{36}$'),
  task_id uuid not null,
  x       real not null check (x between -1000000 and 1000000),
  y       real not null check (y between -1000000 and 1000000),
  primary key (user_id, board, task_id),
  foreign key (task_id, user_id) references mneme.tasks (id, user_id) on delete cascade
);
create index if not exists board_positions_task_idx on mneme.board_positions (task_id);

alter table mneme.board_positions enable row level security;
drop policy if exists board_positions_owner on mneme.board_positions;
create policy board_positions_owner on mneme.board_positions for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant select, insert, update, delete on mneme.board_positions to authenticated;

-- a deleted canvas takes its layout with it
create or replace function mneme.canvases_after_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  delete from mneme.board_positions where board = old.id::text and user_id = old.user_id;
  return null;
end
$$;
drop trigger if exists canvases_after_delete on mneme.canvases;
create trigger canvases_after_delete after delete on mneme.canvases
  for each row execute function mneme.canvases_after_delete();

create or replace function mneme.board_data(p_canvas uuid default null, p_done boolean default false)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with recursive roots as (
    select a.id from mneme.tasks_active a
    where a.parent_id is null
      and (p_done or a.status = 'open')
      and case when p_canvas is null
               then not exists (select 1 from mneme.canvas_tasks ct where ct.task_id = a.id)
               else exists (select 1 from mneme.canvas_tasks ct where ct.task_id = a.id and ct.canvas_id = p_canvas) end
  ),
  tree as (
    select id from roots
    union all
    select c.id from mneme.tasks c join tree on c.parent_id = tree.id
  ),
  rows as (select a.* from mneme.tasks_active a where a.id in (select id from tree)),
  canv as (
    select ct.task_id, jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name) order by c.sort_order, c.name) as list
    from mneme.canvas_tasks ct join mneme.canvases c on c.id = ct.canvas_id
    group by ct.task_id
  )
  select jsonb_build_object(
    'tasks', coalesce((select jsonb_agg(to_jsonb(r) order by r.created_at, r.id) from rows r), '[]'::jsonb),
    'sequences', coalesce((
      select jsonb_agg(jsonb_build_object('id', s.id, 'task_id', s.task_id, 'title', s.title, 'sort_order', s.sort_order,
                                          'created_at', s.created_at, 'note_id', s.note_id)
                       order by s.sort_order, s.created_at, s.id)
      from mneme.task_sequences s
      where s.task_id in (select id from rows)
         or (s.task_id is null and exists (select 1 from rows r where r.sequence_id = s.id))), '[]'::jsonb),
    'links', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'kind', l.kind, 'from_task_id', l.from_task_id, 'to_task_id', l.to_task_id,
               'other', jsonb_build_object('id', o.id, 'title', o.title, 'state', o.state, 'root_id', o.root_id,
                                           'canvases', coalesce((select list from canv where canv.task_id = o.root_id), '[]'::jsonb)))
             order by l.created_at)
      from mneme.task_links l
      join mneme.tasks_active o
        on o.id = case when l.from_task_id in (select id from rows) then l.to_task_id else l.from_task_id end
      where l.from_task_id in (select id from rows) or l.to_task_id in (select id from rows)), '[]'::jsonb),
    'canvas_ids', '[]'::jsonb,
    'positions', coalesce((
      select jsonb_object_agg(p.task_id, jsonb_build_object('x', p.x, 'y', p.y))
      from mneme.board_positions p
      where p.board = coalesce(p_canvas::text, 'inbox') and p.task_id in (select id from rows)), '{}'::jsonb)
  )
$$;

revoke all on function mneme.board_data(uuid, boolean) from public, anon;
grant execute on function mneme.board_data(uuid, boolean) to authenticated;

commit;
