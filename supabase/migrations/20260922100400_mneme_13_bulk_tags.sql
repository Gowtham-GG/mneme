-- =============================================================================
-- Mneme 13 — bulk tag-add for the Notes/Search list's new multi-select action
-- bar. Archive/star/trash/restore/delete-forever need no new RPC — PostgREST
-- already batches those via `.update(patch).in('id', ids)` under the existing
-- owner RLS, exactly like the single-row src/api/notes.ts helpers. Only
-- tag-add benefits from a server-side helper (one round trip for N notes,
-- matching the normalize/upsert logic already in addManualTag,
-- src/api/tags.ts). Additive; nothing in `public` (Argus) is touched.
-- =============================================================================
begin;

create or replace function mneme.bulk_add_tag(p_note_ids uuid[], p_tag_name text)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_uid    uuid := (select auth.uid());
  v_name   text;
  v_tag_id uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  v_name := regexp_replace(regexp_replace(lower(btrim(p_tag_name)), '^#', ''), '[/-]+$', '');
  if not mneme.is_valid_tag(v_name) then
    raise exception 'invalid tag name %', p_tag_name using errcode = '22023';
  end if;

  insert into mneme.tags (user_id, name) values (v_uid, v_name)
  on conflict (user_id, name) do nothing;
  select id into v_tag_id from mneme.tags where user_id = v_uid and name = v_name;

  insert into mneme.note_tags (note_id, tag_id, user_id, source)
  select n.id, v_tag_id, v_uid, 'manual'
  from mneme.notes n
  where n.id = any (coalesce(p_note_ids, '{}')) and n.user_id = v_uid
  on conflict (note_id, tag_id) do nothing;
end
$$;

revoke all on function mneme.bulk_add_tag(uuid[], text) from public, anon;
grant execute on function mneme.bulk_add_tag(uuid[], text) to authenticated;

commit;
