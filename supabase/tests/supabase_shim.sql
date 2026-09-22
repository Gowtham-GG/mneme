-- Minimal stand-in for the Supabase pieces the migrations rely on.
create role anon nologin;
create role authenticated nologin;
-- Real Supabase's service_role has the BYPASSRLS attribute; used here only by
-- the reminder feature's two functions (granted execute to no one else).
create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text);
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
create schema extensions;
-- Real Supabase grants usage on `extensions` (where pgcrypto/pg_trgm/etc. live) to these
-- roles by default; needed for functions that call e.g. extensions.similarity().
grant usage on schema extensions to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
grant select on auth.users to authenticated;
