-- =============================================================================
-- Mneme 05 — trigram indexes for substring search on titles / paper refs.
-- pg_trgm ships with Supabase (free tier). Installed into the `extensions`
-- schema, like the other bundled extensions. Kept separate so the rest of the
-- schema works without it (search falls back to a sequential ILIKE).
-- =============================================================================
begin;
create extension if not exists pg_trgm with schema extensions;

create index if not exists notes_title_trgm_idx
  on mneme.notes using gin (title extensions.gin_trgm_ops);
create index if not exists notes_paper_ref_trgm_idx
  on mneme.notes using gin (paper_ref extensions.gin_trgm_ops);
commit;
