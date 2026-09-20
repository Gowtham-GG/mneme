-- =============================================================================
-- Mneme 07 — themes: settings.theme accepts any theme id
-- Was: check (theme in ('system','light','dark')). The list of themes now lives in the
-- app (src/lib/themes.ts), so adding a theme never needs a migration. The database only
-- guards the SHAPE of the value. Default becomes 'amethyst' (the dark violet look).
-- Legacy 'light' / 'dark' values keep working (the app maps them to slate / amethyst).
-- Additive and idempotent.
-- =============================================================================
begin;

alter table mneme.settings drop constraint if exists settings_theme_check;
alter table mneme.settings
  add constraint settings_theme_check check (theme ~ '^[a-z][a-z0-9-]{1,23}$');
alter table mneme.settings alter column theme set default 'amethyst';

commit;
