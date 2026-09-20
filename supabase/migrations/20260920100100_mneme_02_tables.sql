-- =============================================================================
-- Mneme 02 — tables, indexes, Row Level Security
-- Every table is tenant-scoped by user_id. Child tables reference their parent
-- through composite FKs (id, user_id), so a row can never point at another
-- user's row even if someone crafts the request by hand.
-- =============================================================================
begin;

-- ---------------------------------------------------------------- settings --
create table if not exists mneme.settings (
  user_id     uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  timezone    text not null default 'UTC',
  theme       text not null default 'system' check (theme in ('system', 'light', 'dark')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ------------------------------------------------------------------- notes --
create table if not exists mneme.notes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  -- Assigned by trigger (N-YYMMDD-NNN). Clients never choose it.
  public_id   text not null default '',
  title       text check (title is null or char_length(title) <= 300),
  content     text not null default '' check (char_length(content) <= 100000),
  note_type   text not null default 'capture'
              check (note_type in ('capture','knowledge','question','idea','meeting','reference')),
  is_starred  boolean not null default false,
  paper_ref   text check (paper_ref is null or char_length(paper_ref) <= 64),
  -- Bumped only when title/content change; drives optimistic concurrency.
  version     integer not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  archived_at timestamptz,
  deleted_at  timestamptz,
  constraint notes_id_user_key unique (id, user_id)
);

-- ------------------------------------------------------------ tags / joins --
create table if not exists mneme.tags (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name        text not null check (mneme.is_valid_tag(name)),
  created_at  timestamptz not null default now(),
  constraint tags_user_name_key unique (user_id, name),
  constraint tags_id_user_key unique (id, user_id)
);

create table if not exists mneme.note_tags (
  note_id     uuid not null,
  tag_id      uuid not null,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  -- 'inline' = typed as #tag in the text (owned by the sync trigger);
  -- 'manual' = added through the chip UI (never touched by the trigger).
  source      text not null default 'manual' check (source in ('inline', 'manual')),
  created_at  timestamptz not null default now(),
  primary key (note_id, tag_id),
  foreign key (note_id, user_id) references mneme.notes (id, user_id) on delete cascade,
  foreign key (tag_id,  user_id) references mneme.tags  (id, user_id) on delete cascade
);

-- ------------------------------------------------------------------- links --
create table if not exists mneme.note_links (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null default auth.uid() references auth.users(id) on delete cascade,
  source_note_id    uuid not null,
  target_note_id    uuid not null,
  relationship_type text not null default 'related'
                    check (relationship_type in
                      ('related','derived_from','continuation','contradicts','supports','reference')),
  created_at        timestamptz not null default now(),
  check (source_note_id <> target_note_id),
  constraint note_links_pair_key unique (source_note_id, target_note_id),
  foreign key (source_note_id, user_id) references mneme.notes (id, user_id) on delete cascade,
  foreign key (target_note_id, user_id) references mneme.notes (id, user_id) on delete cascade
);

-- ------------------------------------------------------------------- tasks --
create table if not exists mneme.tasks (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  note_id      uuid,
  -- 'note' = mirrors a "- [ ]" line in a note; 'standalone' = created in the Tasks view.
  source       text not null default 'standalone' check (source in ('note', 'standalone')),
  title        text not null check (char_length(title) between 1 and 500),
  status       text not null default 'open' check (status in ('open', 'done')),
  priority     text check (priority in ('low', 'medium', 'high')),
  due_date     date,
  position     integer not null default 0,   -- 1-based line number inside the note
  line_key     text,                         -- normalised text, used to re-match after edits
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  completed_at timestamptz,
  removed_at   timestamptz,                  -- the checkbox line vanished from the note
  check ((source = 'note') = (note_id is not null)),
  foreign key (note_id, user_id) references mneme.notes (id, user_id) on delete cascade
);

-- --------------------------------------------------------------- revisions --
create table if not exists mneme.note_revisions (
  id        uuid primary key default gen_random_uuid(),
  user_id   uuid not null default auth.uid() references auth.users(id) on delete cascade,
  note_id   uuid not null,
  title     text,
  content   text not null,
  saved_at  timestamptz not null default now(),
  foreign key (note_id, user_id) references mneme.notes (id, user_id) on delete cascade
);

-- ------------------------------------------------------------ recently seen --
create table if not exists mneme.note_views (
  user_id   uuid not null default auth.uid() references auth.users(id) on delete cascade,
  note_id   uuid not null,
  viewed_at timestamptz not null default now(),
  primary key (user_id, note_id),
  foreign key (note_id, user_id) references mneme.notes (id, user_id) on delete cascade
);

-- ---------------------------------------------- per-day ID sequence (private) --
create table if not exists mneme.note_counters (
  user_id  uuid not null references auth.users(id) on delete cascade,
  day      date not null,
  last_seq integer not null default 0,
  primary key (user_id, day)
);

-- =============================================================== indexes ==
-- Timeline (keyset pagination) and "recently edited"
create index if not exists notes_timeline_idx
  on mneme.notes (user_id, created_at desc, id desc) where deleted_at is null;
create index if not exists notes_edited_idx
  on mneme.notes (user_id, updated_at desc, id desc) where deleted_at is null;
create index if not exists notes_starred_idx
  on mneme.notes (user_id, updated_at desc) where is_starred and deleted_at is null;
create index if not exists notes_trash_idx
  on mneme.notes (user_id, deleted_at desc) where deleted_at is not null;
create index if not exists notes_inbox_idx
  on mneme.notes (user_id, created_at desc)
  where note_type = 'capture' and archived_at is null and deleted_at is null;
-- ID lookup / prefix typeahead (text_pattern_ops makes LIKE 'N-2609%' indexable)
create unique index if not exists notes_public_id_key
  on mneme.notes (user_id, public_id text_pattern_ops);
-- Full text (expression index: no stored tsvector, no duplicated text)
create index if not exists notes_fts_idx
  on mneme.notes using gin (mneme.note_fts(title, content));

create index if not exists note_tags_tag_idx   on mneme.note_tags (tag_id, note_id);
create index if not exists note_tags_user_idx  on mneme.note_tags (user_id, tag_id);
create index if not exists note_links_target_idx on mneme.note_links (target_note_id);
create index if not exists note_links_user_idx   on mneme.note_links (user_id);

create index if not exists tasks_open_due_idx
  on mneme.tasks (user_id, due_date) where status = 'open' and removed_at is null;
create index if not exists tasks_done_idx
  on mneme.tasks (user_id, completed_at desc) where status = 'done' and removed_at is null;
create index if not exists tasks_note_idx on mneme.tasks (note_id);

create index if not exists note_revisions_note_idx on mneme.note_revisions (note_id, saved_at desc);
create index if not exists note_views_recent_idx   on mneme.note_views (user_id, viewed_at desc);

-- ================================================================== RLS ==
-- One policy per table: a row is visible/writable only to its owner.
-- (select auth.uid()) is evaluated once per statement, not once per row.
do $$
declare t text;
begin
  foreach t in array array[
    'settings','notes','tags','note_tags','note_links','tasks','note_revisions','note_views'
  ] loop
    execute format('alter table mneme.%I enable row level security', t);
    execute format('drop policy if exists %I on mneme.%I', t || '_owner', t);
    execute format(
      'create policy %I on mneme.%I for all to authenticated
         using (user_id = (select auth.uid()))
         with check (user_id = (select auth.uid()))',
      t || '_owner', t);
  end loop;
end $$;

-- note_counters: RLS on, NO policy, NO grant. Only the SECURITY DEFINER
-- function mneme.next_public_id() can touch it.
alter table mneme.note_counters enable row level security;
revoke all on mneme.note_counters from authenticated, anon, public;

-- Default privileges only cover tables created *after* they were set; make the
-- grants explicit so re-running against an existing schema converges.
grant select, insert, update, delete on all tables in schema mneme to authenticated;
revoke all on mneme.note_counters from authenticated;

commit;
