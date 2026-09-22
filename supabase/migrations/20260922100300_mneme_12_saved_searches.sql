-- =============================================================================
-- Mneme 12 — saved / pinned searches. Separate from the existing local-only
-- "recent searches" list in Search.tsx (kept as-is, purely a convenience);
-- these are explicit, named, and synced across devices like everything else.
-- Additive; nothing in `public` (Argus) is touched.
-- =============================================================================
begin;

create table if not exists mneme.saved_searches (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 80),
  query      text not null check (char_length(query) between 1 and 500),
  pinned     boolean not null default false,
  position   integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists saved_searches_user_idx
  on mneme.saved_searches (user_id, pinned desc, position, created_at);

alter table mneme.saved_searches enable row level security;
drop policy if exists saved_searches_owner on mneme.saved_searches;
create policy saved_searches_owner on mneme.saved_searches for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant select, insert, update, delete on mneme.saved_searches to authenticated;

commit;
