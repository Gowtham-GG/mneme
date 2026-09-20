-- =============================================================================
-- Mneme 01 — schema, grants, pure helper functions
-- Additive only: creates the `mneme` schema. Touches nothing in `public`
-- (Argus). Safe to re-run.
-- Manual step after applying: Dashboard -> Settings -> API -> add `mneme`
-- to "Exposed schemas" so PostgREST / supabase-js can reach it.
-- =============================================================================
begin;

create schema if not exists mneme;

-- Nobody but signed-in users may even see the schema.
revoke all on schema mneme from public;
revoke all on schema mneme from anon;
grant usage on schema mneme to authenticated;

-- Objects created later by the migration role inherit these grants.
alter default privileges in schema mneme
  grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema mneme
  grant execute on functions to authenticated;

-- ---------------------------------------------------------------------------
-- Tag-name rule (used by a CHECK constraint AND by the text parser, so a tag
-- the parser extracts can never violate the constraint).
-- ---------------------------------------------------------------------------
create or replace function mneme.is_valid_tag(p_name text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_name is not null
     and p_name = lower(p_name)
     and char_length(p_name) between 1 and 64
     and p_name ~ '^[[:alnum:]][[:alnum:]_/-]*$'
     and p_name !~ '//'
     and p_name !~ '/$'
$$;

-- ---------------------------------------------------------------------------
-- Full-text document for a note (title weight A, content weight B).
-- Used as an expression index; the search RPC calls the very same function.
-- ---------------------------------------------------------------------------
create or replace function mneme.note_fts(p_title text, p_content text)
returns tsvector
language sql
immutable
parallel safe
set search_path = ''
as $$
  select setweight(to_tsvector('english'::regconfig, coalesce(p_title, '')), 'A')
      || setweight(to_tsvector('english'::regconfig, coalesce(p_content, '')), 'B')
$$;

commit;
