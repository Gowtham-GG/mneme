-- =============================================================================
-- Mneme 09 — tag rename & merge.
-- Inline tags have no identity independent of the "#name" text in notes.content
-- (mneme.sync_note_derived re-derives note_tags from that text on every save),
-- so a bare `update tags set name = ...` would be silently undone the next
-- time any tagged note is saved. Rename/merge therefore rewrite the "#name"
-- tokens inside every affected note's content first, then let the existing
-- sync trigger re-derive tags/note_tags exactly as it already does for a
-- normal edit; manual-source note_tags (never touched by the trigger) are
-- reassigned directly. Additive; nothing in `public` (Argus) is touched.
-- =============================================================================
begin;

-- Rewrite the exact "#<old>" token (never a "#<old>xyz" continuation of a
-- longer tag) to "#<new>" inside a single line, without touching inline code
-- spans or [[link|labels]] — the same regions mneme.note_tag_names ignores.
-- Both names are always caller-validated mneme.is_valid_tag names, so they
-- contain no regex metacharacters and need no escaping.
create or replace function mneme.rewrite_tag_line(p_line text, p_old text, p_new text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_line      text := p_line;
  v_protected text[] := '{}';
  v_span      text;
  v_span_re   constant text := '`[^`]*`|\[\[[^\]]*\]\]';
  v_tag_re    text := '(?<![[:alnum:]_&/#])#' || p_old || '(?![[:alnum:]_/-])';
  i           integer;
begin
  -- stash code spans / link labels behind opaque placeholders so the tag
  -- substitution below can never reach inside them
  while v_line ~ v_span_re loop
    v_span := substring(v_line from v_span_re);
    v_protected := v_protected || v_span;
    v_line := regexp_replace(
      v_line, v_span_re, chr(1) || (array_length(v_protected, 1) - 1)::text || chr(2), '');
  end loop;

  v_line := regexp_replace(v_line, v_tag_re, '#' || p_new, 'g');

  if array_length(v_protected, 1) > 0 then
    for i in 0 .. array_length(v_protected, 1) - 1 loop
      v_line := replace(v_line, chr(1) || i::text || chr(2), v_protected[i + 1]);
    end loop;
  end if;
  return v_line;
end
$$;

-- Same fenced-code-block skip as mneme.note_lines (those lines are left
-- completely untouched), applied over the whole note.
create or replace function mneme.rewrite_tag_in_content(p_content text, p_old text, p_new text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_lines    text[] := string_to_array(coalesce(p_content, ''), E'\n');
  v_in_fence boolean := false;
  i          integer;
begin
  for i in 1 .. coalesce(array_length(v_lines, 1), 0) loop
    if v_lines[i] ~ '^\s{0,3}(```|~~~)' then
      v_in_fence := not v_in_fence;
      continue;
    end if;
    if v_in_fence then
      continue;
    end if;
    v_lines[i] := mneme.rewrite_tag_line(v_lines[i], p_old, p_new);
  end loop;
  return array_to_string(v_lines, E'\n');
end
$$;

-- Rename a tag (and, if it has nested children, the whole subtree: "jvm" ->
-- "jvm2" also moves "jvm/memory" -> "jvm2/memory"). Refuses if the target
-- name is already taken at any affected level — an ambiguous rename must go
-- through merge_tags instead.
create or replace function mneme.rename_tag(p_old_name text, p_new_name text)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_uid        uuid := (select auth.uid());
  v_old        text := lower(btrim(p_old_name));
  v_new        text := lower(btrim(p_new_name));
  r            record;
  v_new_tag_id uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if not mneme.is_valid_tag(v_new) then
    raise exception 'invalid tag name %', p_new_name using errcode = '22023';
  end if;
  if not exists (
    select 1 from mneme.tags where user_id = v_uid and (name = v_old or name like v_old || '/%')
  ) then
    raise exception 'tag not found' using errcode = 'P0002';
  end if;

  -- every affected level, most-specific (deepest child) first
  for r in
    select name as old_full, v_new || substring(name from char_length(v_old) + 1) as new_full
    from mneme.tags
    where user_id = v_uid and (name = v_old or name like v_old || '/%')
    order by char_length(name) desc
  loop
    if exists (select 1 from mneme.tags where user_id = v_uid and name = r.new_full) then
      raise exception 'a tag named % already exists — use merge instead', r.new_full
        using errcode = '23505';
    end if;

    -- inline occurrences: rewrite the text, then the existing sync trigger
    -- re-derives note_tags/tags under the new name with no extra bookkeeping
    update mneme.notes n
       set content = mneme.rewrite_tag_in_content(n.content, r.old_full, r.new_full)
      from mneme.tags g
      join mneme.note_tags nt on nt.tag_id = g.id
     where g.user_id = v_uid and g.name = r.old_full
       and nt.source = 'inline' and nt.note_id = n.id;

    -- manual-source note_tags never appear in the text and are never touched
    -- by the trigger, so they're reassigned directly
    insert into mneme.tags (user_id, name) values (v_uid, r.new_full)
    on conflict (user_id, name) do nothing;
    select id into v_new_tag_id from mneme.tags where user_id = v_uid and name = r.new_full;

    insert into mneme.note_tags (note_id, tag_id, user_id, source)
    select nt.note_id, v_new_tag_id, v_uid, 'manual'
    from mneme.note_tags nt
    join mneme.tags g on g.id = nt.tag_id
    where g.user_id = v_uid and g.name = r.old_full and nt.source = 'manual'
    on conflict (note_id, tag_id) do nothing;

    delete from mneme.note_tags nt
    using mneme.tags g
    where g.user_id = v_uid and g.name = r.old_full and nt.tag_id = g.id and nt.source = 'manual';

    -- orphan sweep (idempotent with the trigger's own cleanup)
    delete from mneme.tags g
    where g.user_id = v_uid and g.name = r.old_full
      and not exists (select 1 from mneme.note_tags x where x.tag_id = g.id);
  end loop;
end
$$;

-- Merge one or more source tags into a target tag (exact names only, no
-- nested-children cascade — that's what rename_tag is for).
create or replace function mneme.merge_tags(p_source_names text[], p_target_name text)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_uid       uuid := (select auth.uid());
  v_target    text := lower(btrim(p_target_name));
  v_source    text;
  v_target_id uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if not mneme.is_valid_tag(v_target) then
    raise exception 'invalid tag name %', p_target_name using errcode = '22023';
  end if;

  insert into mneme.tags (user_id, name) values (v_uid, v_target)
  on conflict (user_id, name) do nothing;
  select id into v_target_id from mneme.tags where user_id = v_uid and name = v_target;

  foreach v_source in array coalesce(p_source_names, '{}') loop
    v_source := lower(btrim(v_source));
    if v_source = '' or v_source = v_target then
      continue;
    end if;
    if not exists (select 1 from mneme.tags where user_id = v_uid and name = v_source) then
      continue;
    end if;

    update mneme.notes n
       set content = mneme.rewrite_tag_in_content(n.content, v_source, v_target)
      from mneme.tags g
      join mneme.note_tags nt on nt.tag_id = g.id
     where g.user_id = v_uid and g.name = v_source
       and nt.source = 'inline' and nt.note_id = n.id;

    insert into mneme.note_tags (note_id, tag_id, user_id, source)
    select nt.note_id, v_target_id, v_uid, 'manual'
    from mneme.note_tags nt
    join mneme.tags g on g.id = nt.tag_id
    where g.user_id = v_uid and g.name = v_source and nt.source = 'manual'
    on conflict (note_id, tag_id) do nothing;

    delete from mneme.note_tags nt
    using mneme.tags g
    where g.user_id = v_uid and g.name = v_source and nt.tag_id = g.id and nt.source = 'manual';

    delete from mneme.tags g
    where g.user_id = v_uid and g.name = v_source
      and not exists (select 1 from mneme.note_tags x where x.tag_id = g.id);
  end loop;
end
$$;

revoke all on function mneme.rename_tag(text, text)        from public, anon;
revoke all on function mneme.merge_tags(text[], text)       from public, anon;
grant execute on function mneme.rename_tag(text, text)      to authenticated;
grant execute on function mneme.merge_tags(text[], text)    to authenticated;

commit;
