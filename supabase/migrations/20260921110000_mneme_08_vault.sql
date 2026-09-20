-- =============================================================================
-- Mneme 08 — "Passwords": an END-TO-END ENCRYPTED vault.
-- The browser derives a key from the user's master passphrase (PBKDF2-SHA256) and encrypts each credential
-- (site, username, password, notes) with AES-256-GCM BEFORE it is sent. The database only ever stores opaque
-- ciphertext ("payload") plus the public KDF parameters — never plaintext, never the key. A forgotten master
-- passphrase therefore cannot be recovered (by design). Additive; nothing in `public` (Argus) is touched.
-- =============================================================================
begin;

-- ---------------------------------------------------------------- vault_meta --
-- One row per user: the KDF parameters + a "check" ciphertext used to tell a wrong passphrase from a right one.
create table if not exists mneme.vault_meta (
  user_id       uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  kdf           text not null default 'pbkdf2-sha256' check (kdf = 'pbkdf2-sha256'),
  iterations    integer not null check (iterations between 100000 and 5000000),   -- floor stops a buggy client downgrading it
  salt          text not null check (char_length(salt) between 16 and 88),
  check_payload text not null check (char_length(check_payload) between 1 and 512),
  version       integer not null default 1,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- --------------------------------------------------------------- vault_items --
-- One row per credential. `payload` = "v1.<iv>.<ciphertext>" (opaque to the server).
create table if not exists mneme.vault_items (
  id         uuid primary key default gen_random_uuid(),   -- client-generated; bound into the ciphertext (AAD)
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  payload    text not null check (char_length(payload) between 1 and 32768),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists vault_items_user_idx on mneme.vault_items (user_id, created_at desc);

-- bound abuse on the shared free-tier project
create or replace function mneme.vault_items_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if (select count(*) from mneme.vault_items v where v.user_id = new.user_id) >= 5000 then
      raise exception 'vault is full (5000 items)' using errcode = '54000';
    end if;
  else
    if new.user_id <> old.user_id then raise exception 'user_id is immutable' using errcode = '42501'; end if;
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists vault_items_guard on mneme.vault_items;
create trigger vault_items_guard before insert or update on mneme.vault_items
  for each row execute function mneme.vault_items_guard();

create or replace function mneme.vault_meta_touch()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists vault_meta_touch on mneme.vault_meta;
create trigger vault_meta_touch before update on mneme.vault_meta
  for each row execute function mneme.vault_meta_touch();

-- ------------------------------------------------------------------------ RLS --
alter table mneme.vault_meta  enable row level security;
alter table mneme.vault_items enable row level security;
drop policy if exists vault_meta_owner  on mneme.vault_meta;
drop policy if exists vault_items_owner on mneme.vault_items;
create policy vault_meta_owner  on mneme.vault_meta  for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy vault_items_owner on mneme.vault_items for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant select, insert, update, delete on mneme.vault_meta, mneme.vault_items to authenticated;

-- ---------------------------------------------------------------------- RPCs --
-- Change the master passphrase ATOMICALLY: every item is re-encrypted by the client under the new key and
-- swapped in together with the new KDF parameters in ONE transaction. If the vault changed in the meantime
-- (another device added/removed an item) the whole thing is refused, so the vault can never end up half old-key,
-- half new-key.
create or replace function mneme.vault_rekey(p_iterations integer, p_salt text, p_check text, p_items jsonb)
returns void language plpgsql set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_count integer;
  v_done integer;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then raise exception 'items must be an array' using errcode = '22023'; end if;

  select count(*) into v_count from mneme.vault_items where user_id = v_uid;
  if jsonb_array_length(p_items) <> v_count then
    raise exception 'vault changed on another device — retry' using errcode = '40001';
  end if;

  update mneme.vault_items i set payload = x.payload
    from jsonb_to_recordset(p_items) as x(id uuid, payload text)
   where i.id = x.id and i.user_id = v_uid;
  get diagnostics v_done = row_count;
  if v_done <> v_count then
    raise exception 'vault changed on another device — retry' using errcode = '40001';
  end if;

  update mneme.vault_meta
     set iterations = p_iterations, salt = p_salt, check_payload = p_check
   where user_id = v_uid;
  if not found then raise exception 'no vault to re-key' using errcode = 'P0002'; end if;
end $$;

-- Forgotten passphrase: erase the vault so a new one can be created. Irreversible by design.
create or replace function mneme.vault_reset()
returns void language plpgsql set search_path = '' as $$
declare v_uid uuid := (select auth.uid());
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  delete from mneme.vault_items where user_id = v_uid;
  delete from mneme.vault_meta  where user_id = v_uid;
end $$;

revoke all on function mneme.vault_rekey(integer, text, text, jsonb) from public, anon;
revoke all on function mneme.vault_reset() from public, anon;
grant execute on function mneme.vault_rekey(integer, text, text, jsonb) to authenticated;
grant execute on function mneme.vault_reset() to authenticated;

commit;
