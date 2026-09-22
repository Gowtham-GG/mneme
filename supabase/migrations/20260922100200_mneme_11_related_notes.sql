-- =============================================================================
-- Mneme 11 — related-note suggestions. No AI, no new heavy index: combines two
-- signals that already have index support — tag overlap (mneme.note_tags,
-- the same join idiom as mneme.tag_counts) and title trigram similarity (the
-- notes_title_trgm_idx GIN index from 05_trigram.sql). Body-content
-- similarity is intentionally skipped: no trigram index exists on `content`,
-- and adding one over a 100k-char column is exactly the cost that migration's
-- own comment warns against. Additive; nothing in `public` (Argus) is touched.
-- =============================================================================
begin;

create or replace function mneme.related_notes(p_note_id uuid, p_limit integer default 5)
returns table (id uuid, public_id text, title text, shared_tags text[], score numeric)
language sql
stable
set search_path = ''
as $$
  with mine as (
    select nt.tag_id from mneme.note_tags nt where nt.note_id = p_note_id
  ),
  src as (
    select n.title from mneme.notes n
    where n.id = p_note_id and n.user_id = (select auth.uid())
  ),
  candidates as (
    select n.id, n.public_id, n.title,
           array_agg(distinct g.name order by g.name) filter (where g.name is not null) as shared_tags,
           count(distinct nt.tag_id) as tag_overlap,
           coalesce(extensions.similarity(n.title, (select title from src)), 0) as title_sim
    from mneme.notes n
    left join mneme.note_tags nt on nt.note_id = n.id and nt.tag_id in (select tag_id from mine)
    left join mneme.tags g on g.id = nt.tag_id
    where n.user_id = (select auth.uid())
      and n.id <> p_note_id
      and n.deleted_at is null
      and exists (select 1 from src)
    group by n.id, n.public_id, n.title
  )
  select c.id, c.public_id, c.title, coalesce(c.shared_tags, '{}'),
         (3 * c.tag_overlap + 2 * c.title_sim)::numeric as score
  from candidates c
  where c.tag_overlap > 0 or c.title_sim > 0.2
  order by score desc, c.tag_overlap desc, c.title_sim desc, c.id desc
  limit least(greatest(coalesce(p_limit, 5), 1), 20)
$$;

revoke all on function mneme.related_notes(uuid, integer) from public, anon;
grant execute on function mneme.related_notes(uuid, integer) to authenticated;

commit;
