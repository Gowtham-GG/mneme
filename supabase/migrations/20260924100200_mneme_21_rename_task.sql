-- =============================================================================
-- Mneme 21 — rename any task from the Tasks view.
--   rename_task(id, title)     standalone -> title updated; from a note -> the
--                              text after its "- [ ]" is rewritten in the note
--                              (the sync trigger keeps the same task, so its
--                              due date and priority survive). The note's
--                              revision history keeps the old text.
-- Additive; nothing in `public` (Argus) is touched.
-- =============================================================================
begin;

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
  -- same line lookup as set_task_done(): exact position first, else nearest same text
  select l.n into v_line_no from mneme.note_task_lines(v_content) l
   where l.n = t.position and l.key = t.line_key;
  if v_line_no is null then
    select l.n into v_line_no from mneme.note_task_lines(v_content) l
     where l.key = t.line_key order by abs(l.n - t.position) limit 1;
  end if;
  if v_line_no is null then
    raise exception 'task line not found in note' using errcode = 'P0002';
  end if;

  -- pre-set the key so the sync trigger re-matches this task exactly (pass 1)
  update mneme.tasks set title = v_title, line_key = lower(v_title) where id = t.id;

  v_lines  := string_to_array(v_content, E'\n');
  v_prefix := substring(v_lines[v_line_no] from '^(\s*(?:[-*+]|[0-9]+[.)])\s+\[[ xX]\]\s+)');
  v_lines[v_line_no] := v_prefix || v_title;
  update mneme.notes set content = array_to_string(v_lines, E'\n') where id = t.note_id;
end
$$;

revoke all on function mneme.rename_task(uuid, text) from public, anon;
grant execute on function mneme.rename_task(uuid, text) to authenticated;

commit;
