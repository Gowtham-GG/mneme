-- =============================================================================
-- Mneme 06 — list RPCs for the timeline, home, starred, archive, trash, inbox.
-- Returns a short preview (not the whole body) plus tags in ONE round-trip,
-- with keyset pagination on (created_at | updated_at, id).
-- =============================================================================
begin;

create or replace function mneme.list_notes(
  p_state     text        default 'active',  -- active | archived | trash | all (= not trashed)
  p_order     text        default 'created', -- created | updated
  p_type      text        default null,
  p_starred   boolean     default null,
  p_from      timestamptz default null,      -- inclusive
  p_to        timestamptz default null,      -- exclusive
  p_cursor_ts timestamptz default null,
  p_cursor_id uuid        default null,
  p_limit     integer     default 30
)
returns table (
  id uuid, public_id text, title text, snippet text, note_type text,
  is_starred boolean, created_at timestamptz, updated_at timestamptz,
  archived_at timestamptz, deleted_at timestamptz, open_tasks bigint, tags text[]
)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  p_limit := least(greatest(coalesce(p_limit, 30), 1), 100);
  if p_state not in ('active', 'archived', 'trash', 'all') then
    raise exception 'unknown state %', p_state using errcode = '22023';
  end if;
  if p_order not in ('created', 'updated') then
    raise exception 'unknown order %', p_order using errcode = '22023';
  end if;

  if p_order = 'created' then
    return query
    select n.id, n.public_id, n.title, left(n.content, 400), n.note_type, n.is_starred,
           n.created_at, n.updated_at, n.archived_at, n.deleted_at,
           (select count(*) from mneme.tasks t
             where t.note_id = n.id and t.status = 'open' and t.removed_at is null),
           coalesce((select array_agg(g.name order by g.name)
                       from mneme.note_tags nt join mneme.tags g on g.id = nt.tag_id
                      where nt.note_id = n.id), '{}')
    from mneme.notes n
    where n.user_id = v_uid
      and (case p_state
             when 'active'   then n.deleted_at is null and n.archived_at is null
             when 'archived' then n.deleted_at is null and n.archived_at is not null
             when 'trash'    then n.deleted_at is not null
             else n.deleted_at is null end)
      and (p_type    is null or n.note_type = p_type)
      and (p_starred is null or n.is_starred = p_starred)
      and (p_from    is null or n.created_at >= p_from)
      and (p_to      is null or n.created_at <  p_to)
      and (p_cursor_ts is null or (n.created_at, n.id) < (p_cursor_ts, p_cursor_id))
    order by n.created_at desc, n.id desc
    limit p_limit;
  else
    return query
    select n.id, n.public_id, n.title, left(n.content, 400), n.note_type, n.is_starred,
           n.created_at, n.updated_at, n.archived_at, n.deleted_at,
           (select count(*) from mneme.tasks t
             where t.note_id = n.id and t.status = 'open' and t.removed_at is null),
           coalesce((select array_agg(g.name order by g.name)
                       from mneme.note_tags nt join mneme.tags g on g.id = nt.tag_id
                      where nt.note_id = n.id), '{}')
    from mneme.notes n
    where n.user_id = v_uid
      and (case p_state
             when 'active'   then n.deleted_at is null and n.archived_at is null
             when 'archived' then n.deleted_at is null and n.archived_at is not null
             when 'trash'    then n.deleted_at is not null
             else n.deleted_at is null end)
      and (p_type    is null or n.note_type = p_type)
      and (p_starred is null or n.is_starred = p_starred)
      and (p_from    is null or n.updated_at >= p_from)
      and (p_to      is null or n.updated_at <  p_to)
      and (p_cursor_ts is null or (n.updated_at, n.id) < (p_cursor_ts, p_cursor_id))
    order by n.updated_at desc, n.id desc
    limit p_limit;
  end if;
end
$$;

-- Most recently opened notes (from note_views), newest first.
create or replace function mneme.recent_viewed(p_limit integer default 10)
returns table (
  id uuid, public_id text, title text, snippet text, note_type text,
  is_starred boolean, created_at timestamptz, updated_at timestamptz,
  archived_at timestamptz, deleted_at timestamptz, viewed_at timestamptz, tags text[]
)
language sql
stable
set search_path = ''
as $$
  select n.id, n.public_id, n.title, left(n.content, 200), n.note_type, n.is_starred,
         n.created_at, n.updated_at, n.archived_at, n.deleted_at, v.viewed_at,
         coalesce((select array_agg(g.name order by g.name)
                     from mneme.note_tags nt join mneme.tags g on g.id = nt.tag_id
                    where nt.note_id = n.id), '{}')
  from mneme.note_views v
  join mneme.notes n on n.id = v.note_id
  where v.user_id = (select auth.uid()) and n.deleted_at is null
  order by v.viewed_at desc
  limit least(greatest(coalesce(p_limit, 10), 1), 50)
$$;

-- Count of captures waiting to be processed (drives the quiet "N to process" hint).
create or replace function mneme.inbox_count()
returns bigint
language sql
stable
set search_path = ''
as $$
  select count(*) from mneme.notes n
  where n.user_id = (select auth.uid())
    and n.note_type = 'capture' and n.archived_at is null and n.deleted_at is null
$$;

revoke all on function mneme.list_notes(text, text, text, boolean, timestamptz, timestamptz, timestamptz, uuid, integer) from public, anon;
revoke all on function mneme.recent_viewed(integer) from public, anon;
revoke all on function mneme.inbox_count() from public, anon;
grant execute on function mneme.list_notes(text, text, text, boolean, timestamptz, timestamptz, timestamptz, uuid, integer) to authenticated;
grant execute on function mneme.recent_viewed(integer) to authenticated;
grant execute on function mneme.inbox_count() to authenticated;

commit;
