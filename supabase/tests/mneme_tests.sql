-- =============================================================================
-- Mneme SQL test-suite.  Run against a THROWAWAY database only (it creates
-- auth.users rows), never against the production project:
--     psql -v ON_ERROR_STOP=1 -f supabase/tests/mneme_tests.sql
-- Everything runs in one transaction that is rolled back at the end.
-- =============================================================================
\set ON_ERROR_STOP on
begin;

create schema t;
-- service_role only needed from section 9 on (reminders), but harmless to grant up front
grant usage on schema t to authenticated, anon, service_role;

create function t.ok(c boolean, msg text) returns void language plpgsql as $$
begin
  if c is not true then raise exception 'FAIL: %', msg; end if;
  raise notice 'ok   - %', msg;
end $$;

create function t.login(u uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
end $$;

create function t.anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
  execute 'set local role anon';
end $$;

create function t.logout() returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
end $$;

-- true when running the statement raises any error
create function t.throws(q text) returns boolean language plpgsql as $$
begin execute q; return false; exception when others then return true; end $$;

create function t.n(q text) returns bigint language plpgsql as $$
declare r bigint; begin execute q into r; return r; end $$;

grant execute on all functions in schema t to authenticated, anon, service_role;

-- scratch key/value store for ids shared between DO blocks
create table t.kv (k text primary key, v text);
grant all on t.kv to authenticated;

insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'a@test'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'b@test');

-- ============================================================ 1. note IDs ===
do $$
declare a uuid := 'aaaaaaaa-0000-0000-0000-000000000001'; b uuid := 'bbbbbbbb-0000-0000-0000-000000000002';
        r text;
begin
  perform t.login(a);
  insert into mneme.settings (timezone) values ('Asia/Kolkata');
  perform t.ok(t.throws($q$ update mneme.settings set timezone = 'Mars/Olympus' $q$), 'invalid timezone rejected');
  update mneme.settings set theme = 'jade';
  perform t.ok((select theme from mneme.settings) = 'jade', 'any well-formed theme id is accepted (themes live in the app)');
  perform t.ok(t.throws($q$ update mneme.settings set theme = 'Robert''); drop table x;--' $q$), 'malformed theme values are rejected');
  perform t.ok(t.throws($q$ update mneme.settings set theme = '' $q$), 'empty theme rejected');

  -- 20:00Z on 10 Sep is 01:30 on 11 Sep in Kolkata -> ID uses the LOCAL day
  insert into mneme.notes (content, created_at) values ('first', '2026-09-10 20:00:00+00');
  insert into mneme.notes (content, created_at) values ('second', '2026-09-10 20:05:00+00');
  insert into mneme.notes (content, created_at) values ('other day', '2026-09-10 10:00:00+00');
  select string_agg(public_id, ',' order by created_at) into r from mneme.notes;
  perform t.ok(r = 'N-260910-001,N-260911-001,N-260911-002', 'IDs follow user timezone + per-day counter: ' || r);

  perform t.ok((select public_id from mneme.notes where content='first') ~ '^N-\d{6}-\d{3}$', 'ID format N-YYMMDD-NNN');
  update mneme.notes set public_id = 'N-000000-999' where content = 'first';
  perform t.ok((select public_id from mneme.notes where content='first') = 'N-260911-001', 'public_id is immutable');
  perform t.ok(t.throws($q$ update mneme.notes set user_id = 'bbbbbbbb-0000-0000-0000-000000000002' $q$), 'user_id is immutable');

  perform t.logout();
  perform t.login(b);
  insert into mneme.notes (content, created_at) values ('bee', '2026-09-10 20:00:00+00');
  perform t.ok((select public_id from mneme.notes) = 'N-260910-001', 'other user has an independent counter (UTC default)');
  insert into mneme.notes (content, created_at) values ('future', now() + interval '3 days');
  perform t.ok((select max(created_at) from mneme.notes) <= now(), 'created_at is clamped to now (no future notes)');
  perform t.logout();
end $$;

-- IDs keep growing past 999 in one day without colliding
do $$
declare a uuid := 'aaaaaaaa-0000-0000-0000-000000000001'; n int; d int; mx text;
begin
  perform t.login(a);
  insert into mneme.notes (content, created_at)
    select 'bulk ' || g, '2026-08-01 10:00:00+00' from generate_series(1, 1005) g;
  select count(*), count(distinct public_id), max(public_id) into n, d, mx from mneme.notes where content like 'bulk %';
  perform t.ok(n = 1005 and d = 1005, 'bulk insert of 1005 notes on one day: all IDs distinct');
  perform t.ok(exists (select 1 from mneme.notes where public_id = 'N-260801-1000'), 'IDs widen past 999 (N-260801-1000)');
  perform t.ok(exists (select 1 from mneme.notes where public_id = 'N-260801-100'), 'N-260801-100 still exists separately');
  perform t.logout();
end $$;

-- ===================================================== 2. tags/links/tasks ==
do $$
declare a uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
        n1 uuid; n2 uuid; n3 uuid; id1 text; id2 text; r text; c int; tid uuid; tid2 uuid;
begin
  perform t.login(a);
  delete from mneme.notes;   -- start clean (cascades)

  insert into mneme.notes (title, content, note_type) values (
   'JVM Class Loading',
$c$#Java and #jvm/memory, (#spring) at http://x.com/a#frag and `#code` and &#39; and # Heading
```
fenced #nottag
- [ ] not a task in fence
```
- [ ] Read docs
- [x] Done thing
1. [ ] Numbered task
$c$, 'knowledge') returning id, public_id into n1, id1;

  select string_agg(g.name, ',' order by g.name) into r
    from mneme.note_tags nt join mneme.tags g on g.id = nt.tag_id where nt.note_id = n1;
  perform t.ok(r = 'java,jvm/memory,spring', 'inline tags extracted (not URL anchors, code, fences, headings): ' || r);
  select string_agg(title || ':' || status, ',' order by position) into r from mneme.tasks where note_id = n1;
  perform t.ok(r = 'Read docs:open,Done thing:done,Numbered task:open', 'checkbox lines become tasks (fenced ones ignored): ' || r);
  perform t.ok((select completed_at is not null from mneme.tasks where title = 'Done thing'), 'completed_at set for [x]');

  -- a #word inside a [[link|label]] is part of the label, not a tag of this note
  insert into mneme.notes (content) values ('see [[N-260801-100|Spring beans #spring]] and #real') returning id into n3;
  select string_agg(g.name, ',') into r from mneme.note_tags nt join mneme.tags g on g.id = nt.tag_id where nt.note_id = n3;
  perform t.ok(r = 'real', '#tags inside [[link labels]] are not extracted: ' || coalesce(r, ''));
  delete from mneme.notes where id = n3;

  -- links --------------------------------------------------------------
  insert into mneme.notes (title, content) values ('JVM Memory', 'heap and stack') returning id, public_id into n2, id2;
  insert into mneme.notes (title, content) values ('Java Basics',
     'See [[JVM Memory]], [[' || id1 || '|classloading]], [[Nope]], self [[Java Basics]] and bare ' || id2)
     returning id into n3;
  select string_agg(x.title, ',' order by x.title) into r
    from mneme.note_links l join mneme.notes x on x.id = l.target_note_id where l.source_note_id = n3;
  perform t.ok(r = 'JVM Class Loading,JVM Memory', 'links resolve by title and by ID; unresolved + self ignored: ' || r);
  perform t.ok(jsonb_array_length(mneme.note_context(n2) -> 'linked_from') = 1, 'backlink shown on target');
  perform t.ok(mneme.note_context(n2) -> 'linked_from' -> 0 ->> 'public_id' = (select public_id from mneme.notes where id = n3), 'backlink names the source note');

  update mneme.note_links set relationship_type = 'supports' where source_note_id = n3 and target_note_id = n2;
  update mneme.notes set content = 'See [[JVM Memory]] only' where id = n3;
  perform t.ok((select count(*) from mneme.note_links where source_note_id = n3) = 1, 'removed link is deleted');
  perform t.ok((select relationship_type from mneme.note_links where source_note_id = n3) = 'supports', 'surviving link keeps its relationship type');

  -- tag maintenance ----------------------------------------------------
  insert into mneme.tags (name) values ('manualtag');
  insert into mneme.note_tags (note_id, tag_id, source) select n1, id, 'manual' from mneme.tags where name = 'manualtag';
  update mneme.notes set content = replace(content, '(#spring)', '(gone)') where id = n1;
  select string_agg(g.name || ':' || nt.source, ',' order by g.name) into r
    from mneme.note_tags nt join mneme.tags g on g.id = nt.tag_id where nt.note_id = n1;
  perform t.ok(r = 'java:inline,jvm/memory:inline,manualtag:manual', 'inline tag removed with the text, manual tag kept: ' || r);
  perform t.ok(not exists (select 1 from mneme.tags where name = 'spring'), 'orphaned tag row cleaned up');

  -- tasks: edit keeps identity ------------------------------------------
  select id into tid from mneme.tasks where note_id = n1 and title = 'Read docs';
  update mneme.tasks set due_date = '2026-10-01', priority = 'high' where id = tid;
  update mneme.notes set content = replace(content, '- [ ] Read docs', '- [ ] Read docs carefully') where id = n1;
  perform t.ok((select title || '|' || due_date || '|' || priority from mneme.tasks where id = tid) = 'Read docs carefully|2026-10-01|high',
               'edited task text keeps the same task (due date + priority survive)');
  perform t.ok((select count(*) from mneme.tasks where note_id = n1 and removed_at is null) = 3, 'no duplicate task after edit');

  -- reorder: identical text keeps identity even when lines move
  update mneme.notes set content = regexp_replace(content, '(- \[ \] Read docs carefully)\n(- \[x\] Done thing)', E'\\2\n\\1') where id = n1;
  perform t.ok((select due_date from mneme.tasks where id = tid) = '2026-10-01', 'moving a task line keeps its metadata');

  -- removal + revival
  update mneme.notes set content = replace(content, E'- [ ] Read docs carefully\n', '') where id = n1;
  perform t.ok((select removed_at is not null from mneme.tasks where id = tid), 'deleted checkbox line hides (not deletes) the task');
  perform t.ok(not exists (select 1 from mneme.tasks_active where id = tid), 'hidden task is not in tasks_active');
  update mneme.notes set content = content || E'\n- [ ] Read docs carefully' where id = n1;
  perform t.ok((select removed_at is null and due_date = '2026-10-01' from mneme.tasks where id = tid), 'same text revives the old task');

  -- tick from the Tasks view rewrites the note text
  perform mneme.set_task_done(tid, true);
  perform t.ok((select content from mneme.notes where id = n1) like '%- [x] Read docs carefully%', 'set_task_done rewrites the checkbox line');
  perform t.ok((select status = 'done' and completed_at is not null from mneme.tasks where id = tid), 'task becomes done (via note sync)');
  perform mneme.set_task_done(tid, false);
  perform t.ok((select content from mneme.notes where id = n1) like '%- [ ] Read docs carefully%', 'untick rewrites back');
  perform t.ok((select status = 'open' and completed_at is null from mneme.tasks where id = tid), 'task reopened, completed_at cleared');

  -- fenced checkbox untouched when line numbers shift
  perform t.ok((select content from mneme.notes where id = n1) like '%- [ ] not a task in fence%', 'fenced checkbox text untouched');

  -- standalone tasks
  insert into mneme.tasks (source, title, due_date) values ('standalone', 'Buy milk', (now() at time zone 'Asia/Kolkata')::date) returning id into tid2;
  perform mneme.set_task_done(tid2, true);
  perform t.ok((select status from mneme.tasks where id = tid2) = 'done', 'standalone task ticks directly');
  perform t.ok(t.throws($q$ insert into mneme.tasks (source, title) values ('note', 'x') $q$), 'note-source task needs a note');

  -- trash hides tasks
  update mneme.notes set deleted_at = now() where id = n1;
  perform t.ok(not exists (select 1 from mneme.tasks_active where note_id = n1), 'tasks of a trashed note are hidden');
  update mneme.notes set deleted_at = null where id = n1;

  -- versions & revisions -----------------------------------------------
  select version into c from mneme.notes where id = n2;
  update mneme.notes set is_starred = true where id = n2;
  perform t.ok((select version from mneme.notes where id = n2) = c, 'star does not bump version');
  update mneme.notes set content = 'heap and stack and metaspace' where id = n2;
  perform t.ok((select version from mneme.notes where id = n2) = c + 1, 'content edit bumps version');
  perform t.ok((select count(*) from mneme.note_revisions where note_id = n2) = 1, 'first edit snapshots previous text');
  update mneme.notes set content = 'heap and stack and metaspace and gc' where id = n2;
  perform t.ok((select count(*) from mneme.note_revisions where note_id = n2) = 1, 'edits within 15 min do not add revisions');
  for c in 1..13 loop
    update mneme.note_revisions set saved_at = saved_at - interval '20 minutes' where note_id = n2;
    update mneme.notes set content = 'rev ' || c where id = n2;
  end loop;
  perform t.ok((select count(*) from mneme.note_revisions where note_id = n2) = 10, 'revisions capped at 10 per note');

  perform t.logout();
end $$;

-- =============================================================== 3. search ==
do $$
declare a uuid := 'aaaaaaaa-0000-0000-0000-000000000001'; r text; c int;
begin
  perform t.login(a);
  delete from mneme.notes;
  insert into mneme.notes (title, content, note_type, is_starred, created_at) values
    ('ClassLoader delegation', 'Parent delegation model of class loaders in the JVM #java', 'knowledge', true,  '2026-09-01 10:00+00'),
    (null,                    'Why does the JVM use classloading? #java #jvm/memory',        'question',  false, '2026-09-10 10:00+00'),
    ('Groceries',             E'- [ ] eggs\n- [ ] milk #home',                               'capture',   false, '2026-09-15 10:00+00'),
    ('Old idea',              'spring beans resolution',                                     'idea',      false, '2026-08-01 10:00+00');
  update mneme.notes set archived_at = now() where title = 'Old idea';
  insert into mneme.notes (title, content, deleted_at) values ('Trashed', 'delegation in the trash', now());

  perform t.ok((select count(*) from mneme.search_notes('delegation')) = 1, 'full text finds the live note, not the trashed one');
  perform t.ok((select count(*) from mneme.search_notes('classloading')) = 2, 'fts stems ClassLoader ~ classloading (title + content)');
  perform t.ok((select count(*) from mneme.search_notes('eggs')) = 1, 'fts match on content only');
  perform t.ok((select count(*) from mneme.search_notes('loaders')) >= 1, 'stemming: loaders ~ loader');
  perform t.ok((select count(*) from mneme.search_notes('Loader')) >= 1, 'title substring: Loader inside ClassLoader');
  perform t.ok((select count(*) from mneme.search_notes('#java')) = 2, '#tag filter');
  perform t.ok((select count(*) from mneme.search_notes('#jvm')) = 1, '#jvm matches nested #jvm/memory');
  perform t.ok((select count(*) from mneme.search_notes('#java #jvm')) = 1, 'several tags = AND');
  perform t.ok((select count(*) from mneme.search_notes('type:question')) = 1, 'type: filter');
  perform t.ok((select count(*) from mneme.search_notes('is:starred')) = 1, 'is:starred');
  perform t.ok((select count(*) from mneme.search_notes('is:inbox')) = 1, 'is:inbox = captures not archived');
  perform t.ok((select count(*) from mneme.search_notes('is:task')) = 1, 'is:task = has open task');
  perform t.ok((select count(*) from mneme.search_notes('is:archived')) = 1, 'is:archived');
  perform t.ok((select count(*) from mneme.search_notes('is:trash')) = 1, 'is:trash');
  perform t.ok((select count(*) from mneme.search_notes('spring')) = 1, 'archived notes stay searchable');
  perform t.ok((select count(*) from mneme.search_notes('after:2026-09-05')) = 2, 'after: filter');
  perform t.ok((select count(*) from mneme.search_notes('before:2026-09-05')) = 2, 'before: filter');
  perform t.ok((select count(*) from mneme.search_notes('after:2026-13-45')) = 4, 'malformed date ignored');
  perform t.ok((select count(*) from mneme.search_notes('#java type:knowledge delegation')) = 1, 'operators combine with text');
  select public_id into r from mneme.notes where title = 'Groceries';
  perform t.ok((select count(*) from mneme.search_notes(r)) = 1, 'search by exact note ID');
  perform t.ok((select count(*) from mneme.search_notes('N-2609')) = 3, 'search by ID prefix');
  perform t.ok((select count(*) from mneme.search_notes('')) = 4, 'empty query lists everything live');
  perform t.ok((select count(*) from mneme.search_notes('100%_')) = 0, 'LIKE wildcards are escaped');
  perform t.ok((select snippet from mneme.search_notes('parent delegation') limit 1) like '%«%', 'snippet highlights match');
  perform t.ok((select preview from mneme.search_notes('parent delegation') limit 1) not like '%«%', 'preview carries no highlight markers');
  perform t.ok((select left(preview, 6) from mneme.search_notes('classloading') where title is null limit 1) = 'Why do', 'preview starts at the top of the body, not at the match');
  perform t.ok((select count(*) from mneme.search_notes('', 2, 0)) = 2 and (select count(*) from mneme.search_notes('', 2, 3)) = 1, 'limit/offset pagination');

  -- tag index with rollup
  select string_agg(name || '=' || note_count || '/' || direct_count, ',' order by name) into r from mneme.tag_counts();
  perform t.ok(r = 'home=1/1,java=2/2,jvm=1/0,jvm/memory=1/1', 'tag_counts rollup counts distinct notes: ' || r);

  -- task buckets
  update mneme.tasks set due_date = (now() at time zone 'UTC')::date where title = 'eggs';
  update mneme.tasks set due_date = (now() at time zone 'UTC')::date + 3 where title = 'milk #home';
  insert into mneme.tasks (source, title) values ('standalone', 'nodate');
  perform t.ok((select count(*) from mneme.list_tasks('today')) = 1, 'bucket today');
  perform t.ok((select count(*) from mneme.list_tasks('upcoming')) = 1, 'bucket upcoming');
  perform t.ok((select count(*) from mneme.list_tasks('no_date')) = 1, 'bucket no_date');
  perform t.ok(t.throws($q$ select * from mneme.list_tasks('bogus') $q$), 'unknown bucket rejected');

  -- list RPCs ------------------------------------------------------------
  perform t.ok((select count(*) from mneme.list_notes('active')) = 3, 'list_notes active = not archived, not trashed');
  perform t.ok((select count(*) from mneme.list_notes('archived')) = 1, 'list_notes archived');
  perform t.ok((select count(*) from mneme.list_notes('trash')) = 1, 'list_notes trash');
  perform t.ok((select count(*) from mneme.list_notes('all')) = 4, 'list_notes all = everything not trashed');
  perform t.ok((select count(*) from mneme.list_notes(p_starred => true)) = 1, 'list_notes starred');
  perform t.ok((select public_id from mneme.list_notes('active', 'created') limit 1) = (select public_id from mneme.notes where title = 'Groceries'),
               'list_notes newest first');
  perform t.ok((select tags from mneme.list_notes('active') where title = 'ClassLoader delegation') = array['java'], 'list_notes returns tags');
  perform t.ok((select open_tasks from mneme.list_notes('active') where title = 'Groceries') = 2, 'list_notes counts open tasks');
  perform t.ok((select length(snippet) from mneme.list_notes('active') where title = 'Groceries') <= 400, 'snippet is a bounded preview');
  -- keyset pagination walks the whole set without gaps/duplicates
  select count(*) into c from (
    with p1 as (select * from mneme.list_notes('all', 'created', null, null, null, null, null, null, 2)),
         last as (select created_at ts, id from p1 order by created_at asc, id asc limit 1),
         p2 as (select l.* from last, lateral mneme.list_notes('all', 'created', null, null, null, null, last.ts, last.id, 2) l)
    select id from p1 union all select id from p2) z;
  perform t.ok(c = 4, 'keyset pagination: 2 pages of 2 cover all 4 notes exactly once');
  perform t.ok((select count(*) from mneme.list_notes('all', 'updated')) = 4, 'list_notes ordered by updated');
  perform t.ok(t.throws($q$ select * from mneme.list_notes('bogus') $q$), 'list_notes rejects unknown state');
  perform t.ok(mneme.inbox_count() = 1, 'inbox_count = captures not archived/trashed');
  insert into mneme.note_views (note_id) select id from mneme.notes where title = 'Groceries';
  perform t.ok((select count(*) from mneme.recent_viewed(5)) = 1, 'recent_viewed lists opened notes');

  perform t.ok(mneme.empty_trash() = 1, 'empty_trash deletes only trashed notes');
  perform t.ok((select count(*) from mneme.notes) = 4, 'live notes untouched by empty_trash');
  perform t.logout();
end $$;

-- ================================================= 4. tenant isolation (RLS) =
do $$
declare a uuid := 'aaaaaaaa-0000-0000-0000-000000000001'; b uuid := 'bbbbbbbb-0000-0000-0000-000000000002';
        na uuid; ta uuid; tga uuid; nb uuid; tgb uuid; tb text; seq_a bigint; seq_a0 bigint; pa text;
begin
  -- A owns rich data
  perform t.login(a);
  delete from mneme.notes;
  insert into mneme.notes (title, content) values ('secret A', 'topsecret #alpha - [ ] a task [[secret A]]') returning id, public_id into na, pa;
  select id into ta from mneme.tasks where note_id = na;
  select id into tga from mneme.tags where name = 'alpha';
  insert into mneme.note_views (note_id) values (na);
  update mneme.notes set content = 'topsecret v2 #alpha - [ ] a task' where id = na;   -- creates a revision
  perform t.logout();
  select coalesce(sum(last_seq), 0) into seq_a0 from mneme.note_counters where user_id = a;

  perform t.login(b);
  delete from mneme.notes;
  insert into mneme.notes (title, content) values ('mine B', 'bee') returning id into nb;
  insert into mneme.tags (name) values ('beta') returning id into tgb;

  -- B sees nothing of A ------------------------------------------------
  perform t.ok(t.n('select count(*) from mneme.notes')          = 1, 'B sees only own notes');
  perform t.ok(t.n('select count(*) from mneme.tags')           = 1, 'B sees only own tags');
  perform t.ok(t.n('select count(*) from mneme.tasks')          = 0, 'B sees no tasks of A');
  perform t.ok(t.n('select count(*) from mneme.note_tags')      = 0, 'B sees no note_tags of A');
  perform t.ok(t.n('select count(*) from mneme.note_links')     = 0, 'B sees no links of A');
  perform t.ok(t.n('select count(*) from mneme.note_revisions') = 0, 'B sees no revisions of A');
  perform t.ok(t.n('select count(*) from mneme.note_views')     = 0, 'B sees no views of A');
  perform t.ok(t.n('select count(*) from mneme.settings')       = 0 or t.n('select count(*) from mneme.settings where user_id <> auth.uid()') = 0, 'B sees no settings of A');
  perform t.ok(t.n('select count(*) from mneme.tasks_active')   = 0, 'view respects RLS (security_invoker)');
  perform t.ok(t.n($q$ select count(*) from mneme.search_notes('topsecret') $q$) = 0, 'search never leaks A''s text');
  perform t.ok(mneme.note_context(na) = '{"tags": [], "tasks": [], "links_to": [], "linked_from": []}'::jsonb, 'note_context of A''s note is empty for B');
  perform t.ok(t.n($q$ select count(*) from mneme.tag_counts() where name = 'alpha' $q$) = 0, 'tag_counts never lists A''s tags');

  -- B cannot modify A's rows --------------------------------------------
  perform t.ok(t.n(format($q$ with u as (update mneme.notes set content = 'pwned' where id = %L returning 1) select count(*) from u $q$, na)) = 0, 'B cannot update A''s note');
  perform t.ok(t.n(format($q$ with d as (delete from mneme.notes where id = %L returning 1) select count(*) from d $q$, na)) = 0, 'B cannot delete A''s note');
  perform t.ok(t.n(format($q$ with u as (update mneme.tasks set title = 'pwned' where id = %L returning 1) select count(*) from u $q$, ta)) = 0, 'B cannot update A''s task');
  perform t.ok(t.throws(format($q$ select mneme.set_task_done(%L, true) $q$, ta)), 'B cannot tick A''s task via RPC');

  -- B cannot write INTO A's account ------------------------------------
  perform t.ok(t.throws(format($q$ insert into mneme.notes (user_id, content) values (%L, 'spoof') $q$, a)), 'B cannot insert a note as A');
  perform t.ok(t.throws(format($q$ insert into mneme.tags (user_id, name) values (%L, 'spoof') $q$, a)), 'B cannot insert a tag as A');

  -- composite FKs: B cannot attach B-owned rows to A's note --------------
  perform t.ok(t.throws(format($q$ insert into mneme.note_tags (note_id, tag_id, user_id) values (%L, %L, %L) $q$, na, tgb, b)), 'B cannot tag A''s note');
  perform t.ok(t.throws(format($q$ insert into mneme.note_tags (note_id, tag_id, user_id) values (%L, %L, %L) $q$, nb, tga, b)), 'B cannot use A''s tag');
  perform t.ok(t.throws(format($q$ insert into mneme.note_links (source_note_id, target_note_id, user_id) values (%L, %L, %L) $q$, nb, na, b)), 'B cannot link to A''s note');
  perform t.ok(t.throws(format($q$ insert into mneme.tasks (source, note_id, title, user_id) values ('note', %L, 'x', %L) $q$, na, b)), 'B cannot attach a task to A''s note');
  perform t.ok(t.throws(format($q$ insert into mneme.note_views (note_id) values (%L) $q$, na)), 'B cannot record a view of A''s note');
  perform t.ok(t.throws(format($q$ insert into mneme.note_revisions (note_id, content) values (%L, 'x') $q$, na)), 'B cannot add revisions to A''s note');
  -- a note ref in B's text can never resolve to A's note
  insert into mneme.notes (content) values ('ref [[secret A]] and [[' || pa || ']] and ' || pa) returning id into nb;
  perform t.ok(t.n(format('select count(*) from mneme.note_links where source_note_id = %L', nb)) = 0, '[[title]] / [[ID]] never resolve to another user''s note');

  -- private counters ------------------------------------------------------
  perform t.ok(t.throws('select * from mneme.note_counters'), 'note_counters not readable by clients');
  perform t.ok(t.throws('update mneme.note_counters set last_seq = 0'), 'note_counters not writable by clients');
  select public_id into tb from mneme.notes where id = nb;
  perform mneme.next_public_id(now(), a);   -- try to advance A's counter
  perform t.logout();
  select coalesce(sum(last_seq), 0) into seq_a from mneme.note_counters where user_id = a;
  perform t.ok(seq_a = seq_a0, 'B calling next_public_id(A) does not advance A''s counter');

  -- anonymous role --------------------------------------------------------
  perform t.anon();
  perform t.ok(t.throws('select count(*) from mneme.notes'), 'anon has no access to the schema');
  perform t.ok(t.throws('select * from mneme.search_notes(''x'')'), 'anon cannot call RPCs');
  perform t.logout();

  -- deleting a user removes everything --------------------------------
  delete from auth.users where id = a;
  perform t.ok((select count(*) from mneme.notes where user_id = a) = 0
           and (select count(*) from mneme.tasks where user_id = a) = 0
           and (select count(*) from mneme.note_counters where user_id = a) = 0, 'deleting the auth user cascades all Mneme data');
end $$;

-- ============================================================ 5. password vault ==
do $$
declare a uuid := 'aaaaaaaa-0000-0000-0000-000000000001'; b uuid := 'bbbbbbbb-0000-0000-0000-000000000002';
        i1 uuid; i2 uuid; c int;
begin
  insert into auth.users (id, email) values (a, 'a-again@test') on conflict do nothing;   -- section 4 deleted user A
  perform t.login(a);
  insert into mneme.vault_meta (iterations, salt, check_payload) values (600000, 'c2FsdHNhbHRzYWx0c2FsdA==', 'v1.iv.check');
  perform t.ok(t.throws($q$ insert into mneme.vault_meta (user_id, iterations, salt, check_payload) values (auth.uid(), 600000, 'c2FsdHNhbHRzYWx0c2FsdA==', 'x') $q$), 'one vault per user');
  perform t.logout(); perform t.login(b);
  perform t.ok(t.throws($q$ insert into mneme.vault_meta (iterations, salt, check_payload) values (1000, 'c2FsdHNhbHRzYWx0c2FsdA==', 'x') $q$), 'KDF iteration floor enforced (no downgrade)');
  perform t.ok(t.throws($q$ insert into mneme.vault_meta (iterations, salt, check_payload) values (600000, 'short', 'x') $q$), 'salt length enforced');
  perform t.logout(); perform t.login(a);

  insert into mneme.vault_items (payload) values ('v1.aaaa.bbbb') returning id into i1;
  insert into mneme.vault_items (payload) values ('v1.cccc.dddd') returning id into i2;
  perform t.ok((select count(*) from mneme.vault_items) = 2, 'A stores encrypted items');
  perform t.ok(t.throws($q$ insert into mneme.vault_items (payload) values (repeat('x', 40000)) $q$), 'payload size capped');
  perform t.ok(t.throws($q$ update mneme.vault_items set user_id = 'bbbbbbbb-0000-0000-0000-000000000002' $q$), 'item user_id immutable');

  -- tenant isolation
  perform t.logout(); perform t.login(b);
  perform t.ok(t.n('select count(*) from mneme.vault_items') = 0, 'B sees none of A''s vault items');
  perform t.ok(t.n('select count(*) from mneme.vault_meta') = 0, 'B cannot read A''s KDF parameters');
  perform t.ok(t.n(format($q$ with u as (update mneme.vault_items set payload = 'v1.evil.evil' where id = %L returning 1) select count(*) from u $q$, i1)) = 0, 'B cannot overwrite A''s ciphertext');
  perform t.ok(t.n(format($q$ with d as (delete from mneme.vault_items where id = %L returning 1) select count(*) from d $q$, i1)) = 0, 'B cannot delete A''s items');
  perform t.ok(t.throws(format($q$ insert into mneme.vault_items (user_id, payload) values (%L, 'v1.x.y') $q$, a)), 'B cannot plant items in A''s vault');
  perform t.ok(t.throws($q$ select mneme.vault_rekey(600000, 'c2FsdHNhbHRzYWx0c2FsdA==', 'v1.k.k', '[]'::jsonb) $q$), 'rekey with no vault of one''s own is refused');
  perform t.logout(); perform t.anon();
  perform t.ok(t.throws('select count(*) from mneme.vault_items'), 'anon cannot reach the vault');
  perform t.logout(); perform t.login(a);

  -- atomic re-key
  perform t.ok(t.throws(format($q$ select mneme.vault_rekey(700000, 'bmV3c2FsdG5ld3NhbHQxMg==', 'v1.new.check', %L::jsonb) $q$, json_build_array(json_build_object('id', i1, 'payload', 'v1.n1.n1'))::text)), 'rekey refused when an item is missing (partial re-key)');
  perform t.ok((select iterations from mneme.vault_meta) = 600000 and (select payload from mneme.vault_items where id = i1) = 'v1.aaaa.bbbb', 'a refused rekey changes nothing');
  perform t.ok(t.throws(format($q$ select mneme.vault_rekey(700000, 'bmV3c2FsdG5ld3NhbHQxMg==', 'v1.new.check', %L::jsonb) $q$, json_build_array(json_build_object('id', i1, 'payload', 'v1.n1.n1'), json_build_object('id', gen_random_uuid(), 'payload', 'v1.n2.n2'))::text)), 'rekey refused when an id is unknown');
  perform mneme.vault_rekey(700000, 'bmV3c2FsdG5ld3NhbHQxMg==', 'v1.new.check',
    json_build_array(json_build_object('id', i1, 'payload', 'v1.n1.n1'), json_build_object('id', i2, 'payload', 'v1.n2.n2'))::jsonb);
  perform t.ok((select iterations from mneme.vault_meta) = 700000 and (select check_payload from mneme.vault_meta) = 'v1.new.check', 'rekey swaps the KDF parameters');
  perform t.ok((select string_agg(payload, ',' order by payload) from mneme.vault_items) = 'v1.n1.n1,v1.n2.n2', 'rekey swaps every ciphertext in one go');

  -- item cap (bounds abuse on the shared free tier)
  perform t.logout();
  insert into mneme.vault_items (user_id, payload) select 'bbbbbbbb-0000-0000-0000-000000000002', 'v1.a.b' from generate_series(1, 5000);
  perform t.login(b);
  perform t.ok(t.throws($q$ insert into mneme.vault_items (payload) values ('v1.over.cap') $q$), 'vault capped at 5000 items');
  perform t.logout(); perform t.login(a);

  -- reset
  perform mneme.vault_reset();
  perform t.ok((select count(*) from mneme.vault_items) = 0 and (select count(*) from mneme.vault_meta) = 0, 'vault_reset erases the caller''s vault');
  perform t.logout();
  perform t.ok((select count(*) from mneme.vault_items where user_id = 'bbbbbbbb-0000-0000-0000-000000000002') = 5000, 'vault_reset never touches other users');
end $$;


-- ==================================================== 6. tag rename & merge ==
do $$
declare a uuid := 'aaaaaaaa-0000-0000-0000-000000000001'; b uuid := 'bbbbbbbb-0000-0000-0000-000000000002';
        n1 uuid; n2 uuid; n3 uuid; r text;
begin
  perform t.login(a);
  delete from mneme.notes; delete from mneme.tags;

  insert into mneme.notes (content) values (
    '#jvm today and #jvm/memory too, also `#jvm` in code and [[x #jvm y]]'
  ) returning id into n1;
  insert into mneme.notes (content) values ('a second note, also #jvm') returning id into n2;
  insert into mneme.tags (name) values ('manualonly');
  insert into mneme.note_tags (note_id, tag_id, source) select n1, id, 'manual' from mneme.tags where name = 'manualonly';

  perform mneme.rename_tag('jvm', 'kotlin');

  perform t.ok((select content from mneme.notes where id = n1)
    = '#kotlin today and #kotlin/memory too, also `#jvm` in code and [[x #jvm y]]',
    'rename rewrites real occurrences, leaves code spans/[[link labels]] untouched');
  perform t.ok((select content from mneme.notes where id = n2) = 'a second note, also #kotlin', 'rename rewrites every affected note');
  select string_agg(g.name, ',' order by g.name) into r
    from mneme.note_tags nt join mneme.tags g on g.id = nt.tag_id where nt.note_id = n1 and nt.source = 'inline';
  perform t.ok(r = 'kotlin,kotlin/memory', 'renaming jvm cascades to nested jvm/memory: ' || r);
  perform t.ok(not exists (select 1 from mneme.tags where name in ('jvm', 'jvm/memory')), 'old tag rows gone');
  select string_agg(name || '=' || note_count, ',' order by name) into r from mneme.tag_counts();
  perform t.ok(r like '%kotlin=2%' and r like '%kotlin/memory=1%', 'tag_counts reflects the rename with zero extra bookkeeping: ' || r);

  -- manual-only tag rename (no note text to rewrite)
  perform mneme.rename_tag('manualonly', 'renamed');
  perform t.ok((select g.name from mneme.note_tags nt join mneme.tags g on g.id = nt.tag_id where nt.note_id = n1 and nt.source = 'manual')
    = 'renamed', 'manual-only tag renamed directly (no text to rewrite)');

  -- renaming onto an existing name is refused, and refused atomically
  perform t.ok(t.throws($q$ select mneme.rename_tag('kotlin', 'renamed') $q$), 'rename onto an existing name is refused (use merge)');
  perform t.ok(exists (select 1 from mneme.tags where name = 'kotlin') and exists (select 1 from mneme.tags where name = 'kotlin/memory'),
               'a refused rename changes nothing (rolled back atomically)');

  -- merge: exact names only, no nested-children cascade
  perform mneme.merge_tags(array['kotlin'], 'java');
  perform t.ok(not exists (select 1 from mneme.tags where name = 'kotlin'), 'merged source tag row removed');
  perform t.ok(exists (select 1 from mneme.tags where name = 'kotlin/memory'), 'merge does not cascade to nested children');
  select string_agg(g.name, ',' order by g.name) into r
    from mneme.note_tags nt join mneme.tags g on g.id = nt.tag_id where nt.note_id = n1 and nt.source = 'inline';
  perform t.ok(r = 'java,kotlin/memory', 'note now carries the merge target instead of the source: ' || r);
  perform t.ok((select content from mneme.notes where id = n2) = 'a second note, also #java', 'merge rewrites text the same way rename does');

  perform t.logout();

  -- RLS: B cannot rename or merge tags A owns
  perform t.login(b);
  insert into mneme.notes (content) values ('nothing to do with #unrelated') returning id into n3;
  perform t.ok(t.throws($q$ select mneme.rename_tag('java', 'stolen') $q$), 'B renaming a name only A has: not found for B');
  perform mneme.merge_tags(array['java'], 'whatever');   -- B has no #java of its own: silently a no-op
  perform t.logout();   -- check as an unrestricted observer: RLS as B would hide A's row regardless, proving nothing
  perform t.ok(exists (select 1 from mneme.tags where user_id = 'aaaaaaaa-0000-0000-0000-000000000001' and name = 'java'),
               'B merging a name it does not have never touches A''s tag');
end $$;

-- ====================================================== 7. task due time ==
do $$
declare a uuid := 'aaaaaaaa-0000-0000-0000-000000000001'; b uuid := 'bbbbbbbb-0000-0000-0000-000000000002';
        n1 uuid; tid uuid; today date;
begin
  perform t.login(a);
  delete from mneme.notes; delete from mneme.tasks;
  update mneme.settings set timezone = 'UTC';
  select (now() at time zone 'UTC')::date into today;

  insert into mneme.notes (content) values (E'- [ ] Ship the release') returning id into n1;
  select id into tid from mneme.tasks where note_id = n1;
  update mneme.tasks set due_date = today, due_time = '14:30' where id = tid;
  update mneme.notes set content = replace(content, 'Ship the release', 'Ship the release today') where id = n1;
  perform t.ok((select due_date || '|' || due_time from mneme.tasks where id = tid) = today || '|14:30:00',
               'edited task text keeps due_time too (same as due_date/priority)');

  perform t.ok(mneme.due_task_count() = 1, 'due_task_count counts an open task due today');
  update mneme.tasks set due_date = today + 1 where id = tid;
  perform t.ok(mneme.due_task_count() = 0, 'due_task_count excludes a task due tomorrow');
  update mneme.tasks set due_date = today - 1 where id = tid;
  perform t.ok(mneme.due_task_count() = 1, 'due_task_count includes an overdue task');
  update mneme.tasks set status = 'done' where id = tid;
  perform t.ok(mneme.due_task_count() = 0, 'due_task_count excludes a completed task');
  perform t.logout();

  -- RLS
  perform t.login(b);
  perform t.ok(t.n(format($q$ with u as (update mneme.tasks set due_time = '00:00' where id = %L returning 1) select count(*) from u $q$, tid)) = 0,
               'B cannot set A''s task due_time');
  perform t.ok(mneme.due_task_count() = 0, 'B''s due_task_count never reflects A''s tasks');
  perform t.logout();
end $$;

-- ============================================ 8. saved searches & bulk tag ==
do $$
declare a uuid := 'aaaaaaaa-0000-0000-0000-000000000001'; b uuid := 'bbbbbbbb-0000-0000-0000-000000000002';
        n1 uuid; n2 uuid; sid uuid; r text;
begin
  perform t.login(a);
  delete from mneme.notes; delete from mneme.saved_searches;

  insert into mneme.saved_searches (name, query) values ('Open questions', 'type:question is:task') returning id into sid;
  perform t.ok((select count(*) from mneme.saved_searches) = 1, 'A saves a search');
  update mneme.saved_searches set pinned = true where id = sid;
  perform t.ok((select pinned from mneme.saved_searches where id = sid), 'pin toggles');
  perform t.ok(t.throws($q$ insert into mneme.saved_searches (name, query) values ('', 'x') $q$), 'empty name rejected');
  perform t.ok(t.throws($q$ insert into mneme.saved_searches (name, query) values ('x', '') $q$), 'empty query rejected');

  -- bulk tag
  insert into mneme.notes (content) values ('first') returning id into n1;
  insert into mneme.notes (content) values ('second') returning id into n2;
  perform mneme.bulk_add_tag(array[n1, n2], '#Team/Alpha');
  select string_agg(distinct g.name, ',') into r
    from mneme.note_tags nt join mneme.tags g on g.id = nt.tag_id where nt.note_id in (n1, n2);
  perform t.ok(r = 'team/alpha', 'bulk_add_tag normalises case/leading # like addManualTag: ' || r);
  perform t.ok((select count(*) from mneme.note_tags nt join mneme.tags g on g.id = nt.tag_id where g.name = 'team/alpha') = 2,
               'tag applied to both notes in one call');
  perform t.ok(t.throws($q$ select mneme.bulk_add_tag('{}'::uuid[], 'Not Valid!') $q$), 'invalid tag name rejected');

  perform t.logout();

  -- RLS
  perform t.login(b);
  perform t.ok(t.n('select count(*) from mneme.saved_searches') = 0, 'B sees no saved searches of A');
  perform t.ok(t.n(format($q$ with u as (update mneme.saved_searches set query = 'pwned' where id = %L returning 1) select count(*) from u $q$, sid)) = 0,
               'B cannot edit A''s saved search');
  perform mneme.bulk_add_tag(array[n1], 'sneaky');   -- n1 belongs to A; the function must touch nothing for B
  perform t.logout();   -- check as an unrestricted observer: RLS as B would hide A's row regardless, proving nothing
  perform t.ok(not exists (select 1 from mneme.tags where user_id = 'aaaaaaaa-0000-0000-0000-000000000001' and name = 'sneaky'),
               'B cannot bulk-tag A''s note via a note id it does not own');
end $$;

-- ============================================ 9. reminders (service_role only) ==
do $$
declare a uuid := 'aaaaaaaa-0000-0000-0000-000000000001'; b uuid := 'bbbbbbbb-0000-0000-0000-000000000002';
        n1 uuid; tid uuid; today date; cnt bigint;
begin
  perform t.login(a);
  delete from mneme.notes; delete from mneme.tasks;
  update mneme.settings set timezone = 'UTC', reminders_enabled = true, reminder_lead_minutes = 60, reminder_morning_time = '09:00';
  select (now() at time zone 'UTC')::date into today;

  insert into mneme.notes (content) values ('capture') returning id into n1;
  insert into mneme.tasks (source, title, due_date, due_time)
    values ('standalone', 'Call the dentist', today, (now() at time zone 'UTC')::time + interval '30 minutes')
    returning id into tid;

  -- neither authenticated nor anon may call the service-role-only functions
  perform t.ok(t.throws('select * from mneme.tasks_due_for_reminder()'), 'authenticated cannot call tasks_due_for_reminder');
  perform t.ok(t.throws('select mneme.mark_reminder_sent(array[]::uuid[])'), 'authenticated cannot call mark_reminder_sent');
  perform t.logout();
  perform t.anon();
  perform t.ok(t.throws('select * from mneme.tasks_due_for_reminder()'), 'anon cannot call tasks_due_for_reminder either');
  perform t.logout();

  -- service_role: the task is due within the lead time
  execute 'set local role service_role';
  select count(*) into cnt from mneme.tasks_due_for_reminder() where task_id = tid;
  perform t.ok(cnt = 1, 'a task due in 30 minutes is picked up with a 60-minute lead time');
  perform mneme.mark_reminder_sent(array[tid]);
  select count(*) into cnt from mneme.tasks_due_for_reminder() where task_id = tid;
  perform t.ok(cnt = 0, 'mark_reminder_sent dedupes: the same task is not offered again');
  execute 'reset role';

  -- rescheduling resets the dedupe marker
  perform t.login(a);
  update mneme.tasks set due_time = due_time + interval '2 hours' where id = tid;
  perform t.ok((select reminder_sent_at is null from mneme.tasks where id = tid), 'changing due_time resets reminder_sent_at');
  perform t.logout();

  -- a date-only task never gets a one-off "due soon" email (the daily digest, section 10, covers it)
  -- (clearing due_time is an ordinary user edit -- done as the task's owner, not as service_role,
  -- which only has execute on the two functions above, no direct table grants)
  perform t.login(a);
  update mneme.tasks set due_time = null where id = tid;
  perform t.logout();
  execute 'set local role service_role';
  select count(*) into cnt from mneme.tasks_due_for_reminder() where task_id = tid;
  perform t.ok(cnt = 0, 'a date-only task is left to the daily digest, not tasks_due_for_reminder');

  -- an opted-out user's own due task never appears (reminders_enabled defaults to false)
  execute 'reset role';
  perform t.login(b);
  insert into mneme.notes (content) values ('capture') returning id into n1;   -- lazily creates B's settings row too
  insert into mneme.tasks (source, title, due_date, due_time) values ('standalone', 'B''s task', today, '00:00');
  perform t.logout();
  execute 'set local role service_role';
  select count(*) into cnt from mneme.tasks_due_for_reminder() where user_id = 'bbbbbbbb-0000-0000-0000-000000000002';
  perform t.ok(cnt = 0, 'an opted-out user (default reminders_enabled = false) is never included even with a due task');
  execute 'reset role';
end $$;

-- ============================================= 10. daily digest (service_role only) ==
do $$
declare a uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
        t_over uuid; t_today uuid; t_soon uuid; t_far uuid; t_done uuid; t_sent uuid; today date; cnt bigint;
begin
  perform t.login(a);
  delete from mneme.tasks where user_id = a;
  -- morning time 00:00 so the digest is always "due" whatever time the suite runs
  update mneme.settings set timezone = 'UTC', reminders_enabled = true, reminder_morning_time = '00:00', last_digest_on = null;
  select (now() at time zone 'UTC')::date into today;
  insert into mneme.tasks (source, title, due_date) values ('standalone', 'Overdue thing', today - 3) returning id into t_over;
  insert into mneme.tasks (source, title, due_date) values ('standalone', 'Today thing', today) returning id into t_today;
  insert into mneme.tasks (source, title, due_date) values ('standalone', 'Soon thing', today + 2) returning id into t_soon;
  insert into mneme.tasks (source, title, due_date) values ('standalone', 'Far thing', today + 30) returning id into t_far;
  insert into mneme.tasks (source, title, due_date, status) values ('standalone', 'Done thing', today - 1, 'done') returning id into t_done;
  insert into mneme.tasks (source, title, due_date) values ('standalone', 'Already reminded', today - 1) returning id into t_sent;
  perform t.logout();

  perform t.login(a);
  perform t.ok(t.throws('select * from mneme.digests_due()'), 'authenticated cannot call digests_due');
  perform t.ok(t.throws('select mneme.mark_digest_sent(array[]::uuid[])'), 'authenticated cannot call mark_digest_sent');
  perform t.logout();
  perform t.anon();
  perform t.ok(t.throws('select * from mneme.digests_due()'), 'anon cannot call digests_due either');
  perform t.logout();

  execute 'set local role service_role';
  perform mneme.mark_reminder_sent(array[t_sent]);
  perform t.ok((select bucket from mneme.digests_due() where task_id = t_over) = 'overdue', 'an overdue open task is in the digest as overdue');
  perform t.ok((select bucket from mneme.digests_due() where task_id = t_today) = 'today', 'a task due today is in the digest as today');
  perform t.ok((select bucket from mneme.digests_due() where task_id = t_soon) = 'upcoming', 'a task due in 2 days is in the digest as upcoming');
  perform t.ok(not exists (select 1 from mneme.digests_due() where task_id = t_far), 'a task beyond the upcoming window is left out');
  perform t.ok(not exists (select 1 from mneme.digests_due() where task_id = t_done), 'a completed task is never in the digest');
  perform t.ok(exists (select 1 from mneme.digests_due() where task_id = t_sent),
               'an unfinished task stays in the digest even after its one-off reminder was sent');
  perform t.ok(exists (select 1 from mneme.digests_due(60) where task_id = t_far), 'p_upcoming_days widens the window');

  perform mneme.mark_digest_sent(array[a]);
  select count(*) into cnt from mneme.digests_due() where user_id = a;
  perform t.ok(cnt = 0, 'mark_digest_sent: no second digest the same local day');
  execute 'reset role';

  -- simulate the next day: yesterday's digest date makes the same tasks come back
  update mneme.settings set last_digest_on = today - 1 where user_id = a;
  execute 'set local role service_role';
  perform t.ok(exists (select 1 from mneme.digests_due() where task_id = t_over), 'an unfinished task is repeated in the next day''s digest');
  execute 'reset role';

  -- not before the configured time
  update mneme.settings set reminder_morning_time = '23:59:59.999' where user_id = a;
  execute 'set local role service_role';
  select count(*) into cnt from mneme.digests_due() where user_id = a;
  perform t.ok(cnt = 0, 'no digest before reminder_morning_time');
  execute 'reset role';

  -- a due user with nothing to report still gets one row (task_id null) so it can be marked
  update mneme.settings set reminder_morning_time = '00:00' where user_id = a;
  delete from mneme.tasks where user_id = a;
  execute 'set local role service_role';
  select count(*) into cnt from mneme.digests_due() where user_id = a and task_id is null;
  perform t.ok(cnt = 1, 'a due user with no tasks gets a single placeholder row');
  execute 'reset role';
end $$;

-- ================================================================ 11. calendar ==
do $$
declare a uuid := 'aaaaaaaa-0000-0000-0000-000000000001'; b uuid := 'bbbbbbbb-0000-0000-0000-000000000002';
        n1 uuid; r record;
begin
  perform t.login(a);
  delete from mneme.notes; delete from mneme.tasks where user_id = a;
  update mneme.settings set timezone = 'Asia/Kolkata';
  -- 20:00 UTC on the 9th is 01:30 on the 10th in Kolkata: must land on the 10th
  insert into mneme.notes (content, created_at) values ('late night', '2026-03-09 20:00+00') returning id into n1;
  insert into mneme.notes (content, created_at, note_type) values ('standup', '2026-03-10 05:00+00', 'meeting');
  insert into mneme.notes (content, created_at, deleted_at) values ('binned', '2026-03-10 06:00+00', now());
  insert into mneme.tasks (source, title, due_date, due_time) values ('standalone', 'Dentist', '2026-03-10', '15:00');
  insert into mneme.tasks (source, title, due_date) values ('standalone', 'Pay rent', '2026-03-10');
  insert into mneme.tasks (source, title, due_date, status) values ('standalone', 'Filed', '2026-03-12', 'done');

  select * into r from mneme.calendar_month('2026-03-01', '2026-03-31') where day = '2026-03-10';
  perform t.ok(r.notes = 2, 'calendar buckets notes by the user''s local day and ignores trash');
  perform t.ok(r.meetings = 1, 'calendar counts meeting notes');
  perform t.ok(r.scheduled = 1 and r.open_tasks = 2, 'calendar counts timed (scheduled) and all open tasks');
  perform t.ok(not exists (select 1 from mneme.calendar_month('2026-03-01', '2026-03-31') where day = '2026-03-09'),
               'no mark on a day with nothing local to it');
  perform t.ok((select done_tasks from mneme.calendar_month('2026-03-01', '2026-03-31') where day = '2026-03-12') = 1,
               'a day with only done tasks is marked done');
  perform t.ok(t.throws($q$ select * from mneme.calendar_month('2026-01-01', '2026-12-31') $q$), 'calendar rejects ranges over 62 days');
  perform t.logout();

  perform t.login(b);
  perform t.ok(not exists (select 1 from mneme.calendar_month('2026-03-01', '2026-03-31')), 'calendar never shows another user''s notes or tasks');
  perform t.logout();
  perform t.anon();
  perform t.ok(t.throws($q$ select * from mneme.calendar_month('2026-03-01', '2026-03-31') $q$), 'anon cannot call calendar_month');
  perform t.logout();
end $$;

-- ================================================================= 12. journal ==
do $$
declare a uuid := 'aaaaaaaa-0000-0000-0000-000000000001'; b uuid := 'bbbbbbbb-0000-0000-0000-000000000002';
        id1 text; id2 text; today date; cnt bigint;
begin
  perform t.login(a);
  update mneme.settings set timezone = 'UTC';
  select (now() at time zone 'UTC')::date into today;
  id1 := mneme.open_journal(today);
  id2 := mneme.open_journal(today);
  perform t.ok(id1 is not null and id1 = id2, 'open_journal is idempotent: one page per day');
  perform t.ok((select note_type = 'journal' and journal_date = today and title is not null from mneme.notes where public_id = id1),
               'the journal page is typed journal, dated, and titled');
  perform t.ok(mneme.inbox_count() = (select count(*) from mneme.notes where note_type = 'capture' and archived_at is null and deleted_at is null),
               'journal pages never land in the Inbox');
  perform t.ok(mneme.open_journal(today - 5) <> id1, 'a past day gets its own page');
  perform t.ok(t.throws(format('select mneme.open_journal(%L::date)', today + 5)), 'no journal for future days');
  perform t.ok(t.throws(format('update mneme.notes set note_type = %L where public_id = %L', 'idea', id1)),
               'a journal page cannot be retyped (type and date go together)');
  perform t.ok(t.throws($q$ insert into mneme.notes (note_type) values ('journal') $q$), 'a journal note needs a date');
  perform t.ok((select journal from mneme.calendar_month(today - 1, today + 1) where day = today), 'calendar flags journal days');

  -- trash frees the day: opening again starts a fresh page
  update mneme.notes set deleted_at = now() where public_id = id1;
  id2 := mneme.open_journal(today);
  perform t.ok(id2 <> id1, 'a trashed journal page is replaced by a fresh one');
  perform t.logout();

  perform t.login(b);
  id2 := mneme.open_journal(today);
  select count(*) into cnt from mneme.notes where note_type = 'journal';
  perform t.ok(cnt = 1 and (select user_id from mneme.notes where public_id = id2) = b,
               'each user has their own journal; B sees only B''s page');
  perform t.logout();
  perform t.anon();
  perform t.ok(t.throws(format('select mneme.open_journal(%L::date)', today)), 'anon cannot open a journal');
  perform t.logout();
end $$;

-- ================================================================== 13. habits ==
do $$
declare a uuid := 'aaaaaaaa-0000-0000-0000-000000000001'; b uuid := 'bbbbbbbb-0000-0000-0000-000000000002';
        h_run uuid; h_water uuid; h_gym uuid; today date; v int; r record; mon date;
begin
  perform t.login(a);
  update mneme.settings set timezone = 'UTC';
  select (now() at time zone 'UTC')::date into today;
  insert into mneme.habits (name, created_at) values ('Run', now() - interval '10 days') returning id into h_run;
  insert into mneme.habits (name, target, unit, created_at) values ('Water', 8, 'glasses', now() - interval '10 days') returning id into h_water;

  -- counts: atomic +/-, never below zero, zero removes the row
  perform mneme.bump_habit(h_water, today, 1); perform mneme.bump_habit(h_water, today, 1);
  v := mneme.bump_habit(h_water, today, 1);
  perform t.ok(v = 3, 'bump_habit adds up taps');
  v := mneme.bump_habit(h_water, today, -1);
  perform t.ok(v = 2, 'bump_habit subtracts');
  v := mneme.bump_habit(h_water, today, -5);
  perform t.ok(v = 0 and not exists (select 1 from mneme.habit_logs where habit_id = h_water and day = today),
               'going to zero deletes the log row');
  v := mneme.bump_habit(h_water, today, -1);
  perform t.ok(v = 0, 'minus on nothing stays at zero');
  perform t.ok(t.throws(format('select mneme.bump_habit(%L, %L::date, 1)', h_run, today + 3)), 'cannot log a future day');

  -- streak: 3 days in a row before today, today not done yet -> streak 3 (today does not break it)
  perform mneme.bump_habit(h_run, today - 1, 1); perform mneme.bump_habit(h_run, today - 2, 1); perform mneme.bump_habit(h_run, today - 3, 1);
  select * into r from mneme.habits_for_day(today) where id = h_run;
  perform t.ok(r.streak = 3 and r.value = 0 and r.due, 'streak counts consecutive days; today pending does not break it');
  perform mneme.bump_habit(h_run, today, 1);
  perform t.ok((select streak from mneme.habits_for_day(today) where id = h_run) = 4, 'doing it today extends the streak');
  perform mneme.bump_habit(h_run, today - 2, -1);   -- a gap two days ago
  perform t.ok((select streak from mneme.habits_for_day(today) where id = h_run) = 2, 'a missed due day resets the streak');

  -- count habits only count days that reached the target
  perform mneme.bump_habit(h_water, today - 1, 8); perform mneme.bump_habit(h_water, today - 2, 5);
  perform t.ok((select streak from mneme.habits_for_day(today) where id = h_water) = 1, 'a count below target is not a streak day');

  -- weekdays: a Mon/Wed/Fri habit is not due on other days, and those days never break its streak
  mon := today - (extract(isodow from today)::int - 1) - 7;   -- Monday of last week
  insert into mneme.habits (name, days, created_at) values ('Gym', 1 | 4 | 16, (mon - 7)::timestamptz) returning id into h_gym;
  perform mneme.bump_habit(h_gym, mon, 1); perform mneme.bump_habit(h_gym, mon + 2, 1); perform mneme.bump_habit(h_gym, mon + 4, 1);
  perform t.ok(not (select due from mneme.habits_for_day(mon + 1) where id = h_gym), 'a Mon/Wed/Fri habit is not due on Tuesday');
  perform t.ok((select streak from mneme.habits_for_day(mon + 6) where id = h_gym) = 3, 'off days (Tue/Thu/weekend) do not break a weekday streak');

  -- created later -> hidden on earlier days
  perform t.ok(not exists (select 1 from mneme.habits_for_day(today - 30) where id = h_run), 'a habit is not listed before it existed');
  perform t.logout();

  -- isolation
  perform t.login(b);
  perform t.ok(not exists (select 1 from mneme.habits_for_day(today)), 'B sees none of A''s habits');
  perform t.ok(t.throws(format('select mneme.bump_habit(%L, %L::date, 1)', h_run, today)), 'B cannot log A''s habit');
  perform t.ok(t.throws(format('insert into mneme.habit_logs (habit_id, day, value) values (%L, %L::date, 1)', h_run, today)),
               'B cannot write a log row against A''s habit directly');
  perform t.logout();
  perform t.anon();
  perform t.ok(t.throws(format('select * from mneme.habits_for_day(%L::date)', today)), 'anon cannot read habits');
  perform t.logout();
end $$;

-- ============================================= 14. habit marks / task delete ==
do $$
declare a uuid := 'aaaaaaaa-0000-0000-0000-000000000001'; b uuid := 'bbbbbbbb-0000-0000-0000-000000000002';
        n1 uuid; t1 uuid; t2 uuid; s1 uuid; today date; r record; c text; k int;
begin
  perform t.login(a);
  update mneme.settings set timezone = 'UTC';
  select (now() at time zone 'UTC')::date into today;
  delete from mneme.habits;
  insert into mneme.habits (name, created_at) values ('Read', now() - interval '5 days');
  insert into mneme.habits (name, target, created_at) values ('Water', 8, now() - interval '5 days');
  perform mneme.bump_habit(id, today - 1, 1) from mneme.habits where name = 'Read';
  perform mneme.bump_habit(id, today - 1, 8) from mneme.habits where name = 'Water';
  perform mneme.bump_habit(id, today - 2, 1) from mneme.habits where name = 'Read';
  select * into r from mneme.calendar_month(today - 3, today + 3) where day = today - 1;
  perform t.ok(r.habits_due = 2 and r.habits_met = 2, 'calendar: all habits met yesterday');
  select * into r from mneme.calendar_month(today - 3, today + 3) where day = today - 2;
  perform t.ok(r.habits_due = 2 and r.habits_met = 1, 'calendar: partly met two days ago');
  perform t.ok(not exists (select 1 from mneme.calendar_month(today - 3, today + 3) where day > today and habits_due > 0),
               'calendar: no habit marks on future days');
  perform t.ok((select show_streaks from mneme.settings), 'streaks are shown by default');

  -- deleting tasks
  insert into mneme.notes (content) values (E'plan\n- [x] book flights\n- [ ] pack\n- [x] visa') returning id into n1;
  select id into t1 from mneme.tasks where note_id = n1 and title = 'book flights';
  select id into t2 from mneme.tasks where note_id = n1 and title = 'pack';
  perform mneme.delete_task(t1);
  select content into c from mneme.notes where id = n1;
  perform t.ok(c = E'plan\n- [ ] pack\n- [x] visa', 'deleting a note task removes exactly its line from the note');
  perform t.ok(not exists (select 1 from mneme.tasks_active where id = t1), 'the deleted note task is gone from lists');
  perform t.ok(exists (select 1 from mneme.note_revisions where note_id = n1), 'the old note text is kept in history');
  insert into mneme.tasks (source, title, status) values ('standalone', 'old chore', 'done') returning id into s1;
  k := mneme.clear_completed_tasks();
  perform t.ok(k >= 2 and not exists (select 1 from mneme.tasks_active where status = 'done'),
               'clear_completed_tasks clears every done task (note + standalone)');
  select content into c from mneme.notes where id = n1;
  perform t.ok(c = E'plan\n- [ ] pack', 'open tasks and other text survive clearing');
  perform t.ok(exists (select 1 from mneme.tasks_active where id = t2 and status = 'open'), 'the open task is untouched');
  perform t.logout();

  perform t.login(b);
  perform t.ok(t.throws(format('select mneme.delete_task(%L)', t2)), 'B cannot delete A''s task');
  perform t.logout();
end $$;

-- renaming tasks
do $$
declare a uuid := 'aaaaaaaa-0000-0000-0000-000000000001'; b uuid := 'bbbbbbbb-0000-0000-0000-000000000002';
        n1 uuid; t1 uuid; s1 uuid; c text;
begin
  perform t.login(a);
  insert into mneme.notes (content) values (E'trip\n  * [x] buy maps\n1. [ ] call hotel') returning id into n1;
  select id into t1 from mneme.tasks where note_id = n1 and title = 'call hotel';
  update mneme.tasks set priority = 'high', due_date = '2030-01-02' where id = t1;
  perform mneme.rename_task(t1, E'  call   the\nhotel \\1 ');
  select content into c from mneme.notes where id = n1;
  perform t.ok(c = E'trip\n  * [x] buy maps\n1. [ ] call the hotel \\1', 'renaming a note task rewrites only its text in the note');
  perform t.ok(exists (select 1 from mneme.tasks_active where id = t1 and title = E'call the hotel \\1'
                       and priority = 'high' and due_date = '2030-01-02'), 'the renamed task keeps its id, priority and due date');
  perform t.ok((select count(*) from mneme.tasks_active where note_id = n1) = 2, 'renaming creates no extra task');
  insert into mneme.tasks (source, title) values ('standalone', 'chore') returning id into s1;
  perform mneme.rename_task(s1, 'weekly chore');
  perform t.ok(exists (select 1 from mneme.tasks where id = s1 and title = 'weekly chore'), 'renaming a standalone task');
  perform t.ok(t.throws(format('select mneme.rename_task(%L, %L)', s1, '   ')), 'an empty title is rejected');
  perform t.logout();

  perform t.login(b);
  perform t.ok(t.throws(format('select mneme.rename_task(%L, %L)', t1, 'x')), 'B cannot rename A''s task');
  perform t.logout();
end $$;

-- ============================================================ task trees ===
do $$
declare a uuid := 'aaaaaaaa-0000-0000-0000-000000000001'; b uuid := 'bbbbbbbb-0000-0000-0000-000000000002';
        p uuid; q uuid; s1 uuid; s2 uuid; x1 uuid; x2 uuid; x3 uuid; y1 uuid; l1 uuid; c1 uuid; c2 uuid;
        nt uuid; n1 uuid; today date;
begin
  perform t.login(a);
  update mneme.settings set timezone = 'UTC';
  select (now() at time zone 'UTC')::date into today;

  -- state <-> status
  insert into mneme.tasks (source, title) values ('standalone', 'Launch site') returning id into p;
  perform t.ok((select state from mneme.tasks where id = p) = 'open', 'new task starts open');
  perform mneme.set_task_state(p, 'in_progress');
  perform t.ok((select status from mneme.tasks where id = p) = 'open', 'in progress still counts as unfinished');
  perform mneme.set_task_state(p, 'cancelled');
  perform t.ok((select status from mneme.tasks where id = p) = 'done', 'cancelled counts as finished');
  perform mneme.set_task_done(p, false);
  perform t.ok((select state from mneme.tasks where id = p) = 'open', 'set_task_done(false) reopens');
  update mneme.tasks set status = 'done' where id = p;
  perform t.ok((select state from mneme.tasks where id = p) = 'done', 'writing the old status column still works');
  perform mneme.set_task_state(p, 'open');
  perform t.ok(t.throws(format('select mneme.set_task_state(%L, %L)', p, 'nope')), 'unknown state is rejected');

  -- sequences block in order; loose subtasks don't
  insert into mneme.task_sequences (task_id, title) values (p, 'Domain') returning id into s1;
  insert into mneme.task_sequences (task_id, title) values (p, 'Content') returning id into s2;
  insert into mneme.tasks (source, title, sequence_id) values ('standalone', 'Buy domain', s1) returning id into x1;
  insert into mneme.tasks (source, title, sequence_id) values ('standalone', 'Point DNS', s1) returning id into x2;
  insert into mneme.tasks (source, title, sequence_id) values ('standalone', 'Verify SSL', s1) returning id into x3;
  insert into mneme.tasks (source, title, sequence_id) values ('standalone', 'Write About', s2) returning id into y1;
  insert into mneme.tasks (source, title, parent_id) values ('standalone', 'Favicon', p) returning id into l1;
  perform t.ok((select parent_id from mneme.tasks where id = x1) = p, 'a sequence step gets its parent from the sequence');
  perform t.ok((select sort_order from mneme.tasks where id = x3) > (select sort_order from mneme.tasks where id = x2), 'steps are appended in order');
  perform t.ok(not (select blocked from mneme.tasks_active where id = x1), 'first step is actionable');
  perform t.ok((select blocked from mneme.tasks_active where id = x2), 'second step is blocked');
  perform t.ok((select blocked from mneme.tasks_active where id = x3), 'third step is blocked');
  perform t.ok(not (select blocked from mneme.tasks_active where id = y1), 'a parallel sequence is not blocked');
  perform t.ok(not (select blocked from mneme.tasks_active where id = l1), 'a loose subtask is not blocked');
  perform t.ok(t.throws(format('select mneme.set_task_state(%L, %L)', x2, 'done')), 'a blocked step can''t be completed');
  perform t.ok(t.throws(format('select mneme.set_task_state(%L, %L)', x2, 'in_progress')), 'a blocked step can''t be started');
  perform mneme.set_task_state(x2, 'on_hold');
  perform t.ok((select state from mneme.tasks where id = x2) = 'on_hold', 'a blocked step can be put on hold');
  perform mneme.set_task_state(x2, 'open');
  perform t.ok((select row(child_count, child_resolved) from mneme.tasks_active where id = p) = row(5, 0), 'child counts');

  -- roll-up
  perform mneme.set_task_state(x1, 'done');
  perform t.ok(not (select blocked from mneme.tasks_active where id = x2), 'finishing step 1 unblocks step 2');
  perform t.ok((select blocked from mneme.tasks_active where id = x3), 'step 3 still waits on step 2');
  perform t.ok((select state from mneme.tasks where id = p) = 'in_progress', 'parent goes in progress once a subtask is done');
  perform t.ok(t.throws(format('select mneme.set_task_state(%L, %L)', p, 'done')), 'a parent can''t be done while subtasks are open');
  perform mneme.set_task_state(x2, 'cancelled');
  perform t.ok(not (select blocked from mneme.tasks_active where id = x3), 'a cancelled step unblocks the next');
  perform mneme.set_task_state(x3, 'done');
  perform mneme.set_task_state(y1, 'done');
  perform mneme.set_task_state(l1, 'done');
  perform t.ok((select state from mneme.tasks where id = p) = 'done', 'parent is done when every subtask is done or cancelled');
  insert into mneme.tasks (source, title, parent_id) values ('standalone', 'Launch tweet', p) returning id into q;
  perform t.ok((select state from mneme.tasks where id = p) = 'in_progress', 'adding a subtask to a done parent reopens it');
  delete from mneme.tasks where id = q;
  perform t.ok((select state from mneme.tasks where id = p) = 'done', 'deleting the only open subtask finishes the parent again');
  perform mneme.set_task_state(l1, 'open');
  perform t.ok((select state from mneme.tasks where id = p) = 'in_progress', 'reopening a subtask reopens the parent');
  perform mneme.set_task_state(p, 'on_hold');
  perform mneme.set_task_state(l1, 'done');
  perform t.ok((select state from mneme.tasks where id = p) = 'on_hold', 'a parent put on hold by hand is left alone');
  perform mneme.set_task_state(p, 'open');
  perform t.ok((select state from mneme.tasks where id = p) = 'done', 'taking it off hold lets the roll-up finish it');

  -- nesting + grandparent roll-up
  perform mneme.set_task_state(l1, 'open');
  insert into mneme.tasks (source, title, parent_id) values ('standalone', 'Draw sketch', l1) returning id into q;
  perform t.ok((select parent_id from mneme.tasks where id = q) = l1, 'subtasks can have subtasks');
  perform mneme.set_task_state(q, 'done');
  perform t.ok((select state from mneme.tasks where id = l1) = 'done' and (select state from mneme.tasks where id = p) = 'done',
               'roll-up climbs to the grandparent');
  perform t.ok(t.throws(format('update mneme.tasks set parent_id = %L where id = %L', q, p)), 'no cycles in the tree');
  perform t.ok(t.throws(format('update mneme.tasks set parent_id = id where id = %L', p)), 'a task can''t be its own parent');

  -- blocked is inherited
  perform mneme.set_task_state(x1, 'open');
  insert into mneme.tasks (source, title, parent_id) values ('standalone', 'Pick registrar', x2) returning id into c1;
  perform t.ok((select blocked from mneme.tasks_active where id = c1), 'a subtask of a blocked step is blocked too');
  delete from mneme.tasks where id = c1;

  -- cancel cascade
  perform mneme.set_task_state(p, 'cancelled');
  perform t.ok((select state from mneme.tasks where id = x1) = 'cancelled' and (select state from mneme.tasks where id = x3) = 'done',
               'cancelling cancels unfinished subtasks, leaves done ones');
  perform t.ok((select state from mneme.tasks where id = x2) = 'cancelled' and not (select cascade_cancelled from mneme.tasks where id = x2),
               'a step cancelled by hand earlier stays marked as its own');
  perform mneme.set_task_state(p, 'open');
  perform t.ok((select state from mneme.tasks where id = x1) = 'open', 'un-cancelling reopens what the cascade cancelled');
  perform t.ok((select state from mneme.tasks where id = x2) = 'cancelled', '…but not what was cancelled by hand');
  perform t.ok((select state from mneme.tasks where id = p) = 'in_progress', 'the parent re-derives its state after un-cancel');

  -- links
  insert into mneme.tasks (source, title) values ('standalone', 'Get visa') returning id into c1;
  insert into mneme.tasks (source, title) values ('standalone', 'Book flights') returning id into c2;
  insert into mneme.task_links (from_task_id, to_task_id) values (c1, c2);
  perform t.ok((select blocked from mneme.tasks_active where id = c2), 'a "must happen first" link blocks the later task');
  perform t.ok(t.throws(format('insert into mneme.task_links (from_task_id, to_task_id) values (%L, %L)', c2, c1)), 'no loops of links');
  perform t.ok(t.throws(format('insert into mneme.task_links (from_task_id, to_task_id) values (%L, %L)', p, x1)), 'a parent can''t block its own subtask');
  perform t.ok(t.throws(format('insert into mneme.task_links (from_task_id, to_task_id) values (%L, %L)', q, p)), 'a subtask can''t block its ancestor');
  insert into mneme.task_links (from_task_id, to_task_id, kind) values (c2, c1, 'related');
  perform t.ok(true, 'a related link may point either way');
  perform mneme.set_task_state(c1, 'done');
  perform t.ok(not (select blocked from mneme.tasks_active where id = c2), 'finishing the first task unblocks the linked one');

  -- dates: parent pushed, parent can't be earlier, steps chronological
  update mneme.tasks set due_date = today + 10, due_time = null where id = l1;
  perform t.ok((select due_date from mneme.tasks where id = p) = today + 10, 'an undated parent takes its subtask''s due date');
  update mneme.tasks set due_date = today + 12, due_time = '09:00' where id = q;
  perform t.ok((select (due_date, due_time) from mneme.tasks where id = l1) = row(today + 12, '09:00'::time), 'a later subtask pushes its parent');
  perform t.ok((select (due_date, due_time) from mneme.tasks where id = p) = row(today + 12, '09:00'::time), '…and the push climbs');
  perform t.ok(t.throws(format('update mneme.tasks set due_date = %L where id = %L', today + 11, p)), 'a parent can''t be due before its subtasks');
  perform t.ok(t.throws(format('update mneme.tasks set due_date = null where id = %L', p)), 'a parent with dated subtasks can''t lose its date');
  update mneme.tasks set due_date = today + 20 where id = p;
  perform t.ok((select due_date from mneme.tasks where id = p) = today + 20, 'moving a parent later is fine');
  update mneme.tasks set due_date = today + 3 where id = x1;
  update mneme.tasks set due_date = today + 5 where id = x3;
  perform t.ok(t.throws(format('update mneme.tasks set due_date = %L where id = %L', today + 2, x3)), 'a step can''t be due before the dated step before it');
  update mneme.tasks set due_date = today + 7 where id = x1;
  perform t.ok((select due_date from mneme.tasks where id = x3) = today + 7, 'a later step date pushes the dated step after it');
  perform t.ok((select due_date from mneme.tasks where id = x2) is null, 'undated steps are skipped');
  perform t.ok(t.throws(format('update mneme.tasks set due_time = %L where id = %L', '10:00', x3)),
               'same day: a date-only step counts as the end of the day');
  update mneme.tasks set due_time = '09:00' where id = x1;
  update mneme.tasks set due_time = '10:00' where id = x3;
  perform t.ok((select due_time from mneme.tasks where id = x3) = '10:00', 'a later time on the same day is fine');
  update mneme.tasks set due_date = today + 30 where id = y1;
  perform t.ok((select due_date from mneme.tasks where id = p) = today + 30, 'any subtask pushes the parent');

  -- Today only lists actionable items
  update mneme.tasks set due_date = today where id = c2;
  insert into mneme.tasks (source, title, due_date) values ('standalone', 'Held', today) returning id into q;
  perform mneme.set_task_state(q, 'on_hold');
  insert into mneme.tasks (source, title, due_date) values ('standalone', 'Waits', today) returning id into c1;
  insert into mneme.tasks (source, title) values ('standalone', 'Blocker') returning id into n1;
  insert into mneme.task_links (from_task_id, to_task_id) values (n1, c1);
  perform t.ok(exists (select 1 from mneme.list_tasks('today') where id = c2), 'Today lists an actionable task');
  perform t.ok(not exists (select 1 from mneme.list_tasks('today') where id = q), 'Today skips on-hold tasks');
  perform t.ok(not exists (select 1 from mneme.list_tasks('today') where id = c1), 'Today skips blocked tasks');
  perform t.ok(mneme.due_task_count() = (select count(*) from mneme.list_tasks('today')), 'the due badge matches Today');

  -- canvases
  insert into mneme.canvases (name) values ('Work') returning id into c1;
  insert into mneme.canvases (name) values ('Side projects') returning id into c2;
  insert into mneme.canvas_tasks (canvas_id, task_id) values (c1, p), (c2, p);
  perform t.ok((select count(*) from mneme.canvas_tasks where task_id = p) = 2, 'a main task can be on several canvases');
  perform t.ok(t.throws(format('insert into mneme.canvas_tasks (canvas_id, task_id) values (%L, %L)', c1, l1)), 'subtasks can''t be put on a canvas');
  perform t.ok(t.throws($q$insert into mneme.canvases (name) values (' work ')$q$), 'canvas names are unique per user');
  insert into mneme.tasks (source, title) values ('standalone', 'Loose idea') returning id into q;
  insert into mneme.canvas_tasks (canvas_id, task_id) values (c1, q);
  update mneme.tasks set parent_id = p where id = q;
  perform t.ok(not exists (select 1 from mneme.canvas_tasks where task_id = q), 'a task moved under another leaves its canvases');

  -- note tasks: status survives note edits; phase-1 limits
  insert into mneme.notes (content) values (E'- [ ] call bank\n- [ ] email') returning id into n1;
  select id into nt from mneme.tasks where note_id = n1 and title = 'call bank';
  perform mneme.set_task_state(nt, 'in_progress');
  perform t.ok((select content from mneme.notes where id = n1) like '- [/] call bank%', 'in progress is written into the note as [/]');
  update mneme.notes set content = content || E'\nmore text' where id = n1;
  perform t.ok((select state from mneme.tasks where id = nt) = 'in_progress', 'in progress survives editing the note');
  perform mneme.set_task_state(nt, 'cancelled');
  perform t.ok((select content from mneme.notes where id = n1) like '- [-] call bank%', 'cancelling a note task marks its line [-]');
  perform t.ok((select state from mneme.tasks where id = nt) = 'cancelled', '…and it stays cancelled');
  update mneme.notes set content = replace(content, '- [-] call bank', '- [ ] call bank') where id = n1;
  perform t.ok((select state from mneme.tasks where id = nt) = 'open', 'unticking the line in the note reopens it');
  perform t.ok(t.throws(format('update mneme.tasks set parent_id = %L where id = %L', p, nt)), 'a note task can''t be moved under a task (yet)');
  perform t.ok(t.throws(format('insert into mneme.tasks (source, title, parent_id) values (%L, %L, %L)', 'standalone', 'sub', nt)),
               'a note task can''t get subtasks (yet)');
  insert into mneme.task_links (from_task_id, to_task_id) values (nt, x3);
  perform t.ok(true, 'note tasks can be linked');
  delete from mneme.task_links where from_task_id = nt;

  -- deleting / clearing
  perform mneme.delete_task(l1);
  perform t.ok(not exists (select 1 from mneme.tasks where parent_id = l1), 'deleting a task deletes its subtasks');
  delete from mneme.task_sequences where id = s2;
  perform t.ok(not exists (select 1 from mneme.tasks where id = y1), 'deleting a sequence deletes its steps');
  insert into mneme.tasks (source, title) values ('standalone', 'Done main') returning id into q;
  insert into mneme.tasks (source, title, parent_id) values ('standalone', 'Done sub', q) returning id into c1;
  perform mneme.set_task_state(c1, 'done');
  perform t.ok((select state from mneme.tasks where id = q) = 'done', 'setup: finished main task');
  perform mneme.clear_completed_tasks();
  perform t.ok(not exists (select 1 from mneme.tasks where id in (q, c1)), 'clearing completed removes finished main tasks with their subtasks');
  perform t.ok(exists (select 1 from mneme.tasks where id = x3 and state = 'done'), '…but keeps finished steps of unfinished tasks');
  perform t.logout();

  -- isolation
  perform t.login(b);
  perform t.ok(not exists (select 1 from mneme.tasks_active where id = p), 'B can''t see A''s tasks');
  perform t.ok(t.throws(format('insert into mneme.tasks (source, title, parent_id) values (%L, %L, %L)', 'standalone', 'x', p)),
               'B can''t add a subtask to A''s task');
  perform t.ok(t.throws(format('insert into mneme.task_sequences (task_id) values (%L)', p)), 'B can''t add a sequence to A''s task');
  perform t.ok(t.throws(format('select mneme.set_task_state(%L, %L)', p, 'done')), 'B can''t change A''s task');
  perform t.ok((select count(*) from mneme.canvases) = 0, 'B can''t see A''s canvases');
  perform t.logout();
end $$;

-- ======================================================= task tree reads ===
do $$
declare a uuid := 'aaaaaaaa-0000-0000-0000-000000000001'; b uuid := 'bbbbbbbb-0000-0000-0000-000000000002';
        r uuid; s1 uuid; x1 uuid; x2 uuid; g uuid; o uuid; cv uuid; j jsonb; today date;
begin
  perform t.login(a);
  select (now() at time zone 'UTC')::date into today;
  insert into mneme.tasks (source, title) values ('standalone', 'Tree root') returning id into r;
  insert into mneme.task_sequences (task_id, title) values (r, 'Steps') returning id into s1;
  insert into mneme.tasks (source, title, sequence_id, due_date) values ('standalone', 'Step one', s1, today + 40) returning id into x1;
  insert into mneme.tasks (source, title, sequence_id) values ('standalone', 'Step two', s1) returning id into x2;
  insert into mneme.tasks (source, title, parent_id) values ('standalone', 'Grandchild', x2) returning id into g;
  insert into mneme.tasks (source, title) values ('standalone', 'Elsewhere') returning id into o;
  insert into mneme.task_links (from_task_id, to_task_id) values (o, x1);
  insert into mneme.canvases (name) values ('Tree canvas') returning id into cv;
  insert into mneme.canvas_tasks (canvas_id, task_id) values (cv, r);

  perform t.ok((select root_id from mneme.tasks_active where id = g) = r, 'root_id climbs to the main task');
  perform t.ok((select root_id from mneme.tasks_active where id = r) = r, 'a main task is its own root');
  perform t.ok((select parent_title from mneme.tasks_active where id = g) = 'Step two', 'parent_title for breadcrumbs');

  j := mneme.task_tree(r);
  perform t.ok(jsonb_array_length(j->'tasks') = 4, 'task_tree returns the whole tree');
  perform t.ok(jsonb_array_length(j->'sequences') = 1 and j->'sequences'->0->>'title' = 'Steps', 'task_tree returns its sequences');
  perform t.ok(jsonb_array_length(j->'links') = 1 and j->'links'->0->'other'->>'title' = 'Elsewhere'
               and (j->'links'->0->'other'->>'root_id')::uuid = o, 'task_tree returns links with the other end');
  perform t.ok(j->'canvas_ids' = jsonb_build_array(cv), 'task_tree returns its canvases');

  perform t.ok(exists (select 1 from mneme.list_tasks('upcoming') where id = r), 'Upcoming lists the main task');
  perform t.ok(not exists (select 1 from mneme.list_tasks('upcoming') where id = x1), '…but not its subtasks');
  perform t.ok(not exists (select 1 from mneme.list_tasks('no_date') where id in (x2, g)), 'No date skips subtasks');
  perform t.logout();

  perform t.login(b);
  perform t.ok(jsonb_array_length(mneme.task_tree(r)->'tasks') = 0, 'B gets an empty tree for A''s task');
  perform t.logout();
end $$;

-- ================================================== tasks written in notes ===
do $$
declare a uuid := 'aaaaaaaa-0000-0000-0000-000000000001'; b uuid := 'bbbbbbbb-0000-0000-0000-000000000002';
        n1 uuid; n2 uuid; lw uuid; bd uuid; pd uuid; wa uuid; pf uuid; ds uuid; t1 uuid; t2 uuid; s1 uuid; s2 uuid;
        x uuid; y uuid; c text; today date := (now() at time zone 'UTC')::date;
begin
  perform t.login(a);
  insert into mneme.notes (content) values (E'Launch site\n- [ ] Launch website\n  Domain:\n  1. [ ] Buy domain\n  2. [ ] Point DNS\n  Content:\n  1. [ ] Write About\n  - [ ] Pick favicon\n    - [ ] Draw sketch\n1. [ ] Top step one\n2. [ ] Top step two')
    returning id into n1;
  select id into lw from mneme.tasks where note_id = n1 and title = 'Launch website';
  select id into bd from mneme.tasks where note_id = n1 and title = 'Buy domain';
  select id into pd from mneme.tasks where note_id = n1 and title = 'Point DNS';
  select id into wa from mneme.tasks where note_id = n1 and title = 'Write About';
  select id into pf from mneme.tasks where note_id = n1 and title = 'Pick favicon';
  select id into ds from mneme.tasks where note_id = n1 and title = 'Draw sketch';
  select id into t1 from mneme.tasks where note_id = n1 and title = 'Top step one';
  select id into t2 from mneme.tasks where note_id = n1 and title = 'Top step two';

  -- structure from the text
  perform t.ok((select parent_id from mneme.tasks where id = bd) = lw, 'indentation makes a subtask');
  perform t.ok((select parent_id from mneme.tasks where id = ds) = pf, 'deeper indentation nests further');
  select sequence_id into s1 from mneme.tasks where id = bd;
  perform t.ok(s1 is not null and (select sequence_id from mneme.tasks where id = pd) = s1, 'numbered siblings form one sequence');
  perform t.ok((select title from mneme.task_sequences where id = s1) = 'Domain', 'a "Name:" line names the sequence');
  select sequence_id into s2 from mneme.tasks where id = wa;
  perform t.ok(s2 is not null and s2 <> s1 and (select title from mneme.task_sequences where id = s2) = 'Content', 'a plain line starts a new, parallel sequence');
  perform t.ok((select sequence_id from mneme.tasks where id = pf) is null, 'a bullet sibling is a loose subtask');
  perform t.ok((select blocked from mneme.tasks_active where id = pd) and not (select blocked from mneme.tasks_active where id = bd), 'note steps block in order');
  perform t.ok((select parent_id from mneme.tasks where id = t1) is null and (select sequence_id from mneme.tasks where id = t2) is not null
               and (select blocked from mneme.tasks_active where id = t2), 'a top-level numbered run is a sequence without a parent');
  perform t.ok((select child_count from mneme.tasks_active where id = lw) = 4, 'the note parent counts its subtasks');

  -- markers in the text set the state
  update mneme.notes set content = replace(content, '1. [ ] Buy domain', '1. [/] Buy domain') where id = n1;
  perform t.ok((select state from mneme.tasks where id = bd) = 'in_progress', '[/] means in progress');
  update mneme.notes set content = replace(content, '- [ ] Pick favicon', '- [h] Pick favicon') where id = n1;
  perform t.ok((select state from mneme.tasks where id = pf) = 'on_hold', '[h] means on hold');
  update mneme.notes set content = replace(content, '1. [ ] Top step one', '1. [-] Top step one') where id = n1;
  perform t.ok((select state from mneme.tasks where id = t1) = 'cancelled' and not (select blocked from mneme.tasks_active where id = t2),
               '[-] means cancelled, and unblocks the next step');

  -- identity survives restructuring
  update mneme.tasks set due_date = today + 5 where id = ds;
  update mneme.notes set content = replace(content, E'    - [ ] Draw sketch', E'- [ ] Draw sketch') where id = n1;
  perform t.ok((select parent_id from mneme.tasks where id = ds) is null and (select due_date from mneme.tasks where id = ds) = today + 5,
               'outdenting in the note keeps the same task (and its date)');
  update mneme.notes set content = replace(content, E'\n- [ ] Draw sketch', E'\n    - [ ] Draw sketch') where id = n1;
  perform t.ok((select parent_id from mneme.tasks where id = ds) = pf, 'indenting it back re-parents it');
  perform t.ok((select due_date from mneme.tasks where id = pf) = today + 5, 'dates still push the note parent');

  -- a save is never refused and never rewritten: roll-up from ticking in the note
  update mneme.notes set content = replace(replace(replace(replace(content,
           '1. [/] Buy domain', '1. [x] Buy domain'), '2. [ ] Point DNS', '2. [x] Point DNS'),
           '1. [ ] Write About', '1. [x] Write About'), '- [h] Pick favicon', '- [x] Pick favicon') where id = n1;
  update mneme.notes set content = replace(content, '    - [ ] Draw sketch', '    - [x] Draw sketch') where id = n1;
  perform t.ok((select state from mneme.tasks where id = lw) = 'done', 'ticking every subtask in the note finishes the parent');
  perform t.ok((select content from mneme.notes where id = n1) like E'Launch site\n- [ ] Launch website%', '…without rewriting the note being saved');

  -- changes made elsewhere are written into the note
  perform mneme.set_task_state(wa, 'open');
  c := (select content from mneme.notes where id = n1);
  perform t.ok(c like E'%\n  1. [ ] Write About%', 'reopening from the Tasks page writes [ ]');
  perform t.ok(c like E'%\n- [/] Launch website%', '…and the parent''s roll-up (in progress) is written too');
  perform mneme.set_task_state(pd, 'on_hold');
  perform t.ok((select content from mneme.notes where id = n1) like E'%  2. [h] Point DNS%', 'on hold is written as [h]');
  perform mneme.set_task_state(pd, 'done');

  -- adding from the Tasks page / board writes lines
  perform mneme.add_subtask(lw, 'Buy hosting');
  c := (select content from mneme.notes where id = n1);
  perform t.ok(c like E'%    - [x] Draw sketch\n  - [ ] Buy hosting\n1. [-] Top step one%', 'add_subtask appends an indented line under the parent''s block');
  perform t.ok((select parent_id from mneme.tasks where note_id = n1 and title = 'Buy hosting') = lw, '…which becomes its subtask');
  perform mneme.add_subtask(lw, 'Renew SSL', s1);
  perform t.ok((select content from mneme.notes where id = n1) like E'%  2. [x] Point DNS\n  3. [ ] Renew SSL\n%', 'a step is added as the next number');
  perform t.ok((select sequence_id from mneme.tasks where note_id = n1 and title = 'Renew SSL') = s1, '…into that sequence');
  perform t.ok(mneme.add_sequence(lw, 'Launch day', 'Announce') is not null, 'add_sequence returns the new sequence');
  perform t.ok((select content from mneme.notes where id = n1) like E'%  - [ ] Buy hosting\n  Launch day:\n  1. [ ] Announce\n%', 'a sequence is written as "Name:" + "1. [ ] step"');
  perform t.ok((select s.title from mneme.tasks t join mneme.task_sequences s on s.id = t.sequence_id where t.note_id = n1 and t.title = 'Announce') = 'Launch day',
               '…and read back as a sequence');
  perform mneme.rename_task(pd, 'Point DNS to Vercel');
  perform t.ok((select content from mneme.notes where id = n1) like E'%  2. [x] Point DNS to Vercel\n%', 'rename keeps the numbered prefix and marker');

  -- guards: the note arranges its own tasks
  perform t.ok(t.throws(format('update mneme.tasks set parent_id = null where id = %L', bd)), 'a note task can''t be re-parented directly');
  perform t.ok(t.throws(format('insert into mneme.tasks (source, title, sequence_id) values (%L, %L, %L)', 'standalone', 'x', s1)),
               'a standalone task can''t join a note''s sequence directly');

  -- moves
  perform mneme.move_task(ds, lw);
  c := (select content from mneme.notes where id = n1);
  perform t.ok(c like E'%  1. [ ] Announce\n  - [x] Draw sketch\n1. [-] Top step one%' and (select parent_id from mneme.tasks where id = ds) = lw,
               'moving within a note moves and re-indents the line');
  insert into mneme.notes (content) values (E'Budget\n- [ ] Costs') returning id into n2;
  select id into x from mneme.tasks where note_id = n2 and title = 'Costs';
  perform mneme.move_task(pf, x);
  perform t.ok((select content from mneme.notes where id = n2) = E'Budget\n- [x] Costs\n  - [x] Pick favicon', 'moving into another note writes it there (its only, done subtask finishes Costs)');
  perform t.ok((select content from mneme.notes where id = n1) like
               format(E'%%  - ↗ Pick favicon → [[%s]]\n%%', (select public_id from mneme.notes where id = n2)), '…and leaves a link line behind');
  perform t.ok((select note_id from mneme.tasks where id = pf) = n2 and (select parent_id from mneme.tasks where id = pf) = x, '…keeping the same task');
  perform t.ok(exists (select 1 from mneme.task_links where from_task_id = lw and to_task_id = pf and kind = 'related'), '…with a dotted link from its old parent');
  insert into mneme.tasks (source, title) values ('standalone', 'Board parent') returning id into y;
  perform mneme.move_task(pf, y);
  perform t.ok((select source from mneme.tasks where id = pf) = 'standalone' and (select parent_id from mneme.tasks where id = pf) = y,
               'moving out of notes makes it a standalone task');
  perform t.ok((select content from mneme.notes where id = n2) = format(E'Budget\n- [x] Costs\n  - ↗ Pick favicon → [[%s]]', mneme.task_code(pf)),
               '…leaving a [[T-…]] link line');
  perform t.ok((select id from mneme.find_task(mneme.task_code(pf))) = pf, 'find_task resolves a T- code');
  insert into mneme.tasks (source, title, parent_id) values ('standalone', 'Sub of board', y) returning id into x;
  perform mneme.move_task(y, lw);
  c := (select content from mneme.notes where id = n1);
  perform t.ok(c like E'%  - [/] Board parent\n    - [x] Pick favicon\n    - [ ] Sub of board\n%', 'moving a standalone task into a note writes its subtree');
  perform t.ok((select source from mneme.tasks where id = x) = 'note' and (select parent_id from mneme.tasks where id = x) = y
               and (select parent_id from mneme.tasks where id = y) = lw, '…keeping the same tasks and shape');
  perform mneme.move_task(y, null);
  perform t.ok((select content from mneme.notes where id = n1) like E'%  - [x] Draw sketch\n- [/] Board parent\n  - [x] Pick favicon\n  - [ ] Sub of board\n1. [-] Top step one%',
               'moving a note task to the top outdents it, right after its old tree');
  perform t.ok((select parent_id from mneme.tasks where id = y) is null and (select source from mneme.tasks where id = y) = 'note', '…as a main task still in the note');

  -- delete takes the indented block with it
  perform mneme.delete_task(y);
  c := (select content from mneme.notes where id = n1);
  perform t.ok(c not like '%Board parent%' and c not like '%Sub of board%', 'deleting a note task removes its indented block');
  perform t.logout();

  perform t.login(b);
  perform t.ok(t.throws(format('select mneme.move_task(%L, null)', lw)), 'B can''t move A''s task');
  perform t.ok(t.throws(format('select mneme.add_subtask(%L, %L)', lw, 'x')), 'B can''t add to A''s task');
  perform t.ok(not exists (select 1 from mneme.find_task(mneme.task_code(lw))), 'B can''t find A''s task by code');
  perform t.logout();
end $$;

-- ================================================================ board ===
do $$
declare a uuid := 'aaaaaaaa-0000-0000-0000-000000000001'; b uuid := 'bbbbbbbb-0000-0000-0000-000000000002';
        r1 uuid; r2 uuid; k uuid; o uuid; cv uuid; j jsonb;
begin
  perform t.login(a);
  delete from mneme.canvas_tasks; delete from mneme.canvases;
  insert into mneme.canvases (name) values ('Travel') returning id into cv;
  insert into mneme.tasks (source, title) values ('standalone', 'Inbox root') returning id into r1;
  insert into mneme.tasks (source, title, parent_id) values ('standalone', 'Inbox kid', r1) returning id into k;
  insert into mneme.tasks (source, title) values ('standalone', 'Visa') returning id into o;
  insert into mneme.canvas_tasks (canvas_id, task_id) values (cv, o);
  insert into mneme.task_links (from_task_id, to_task_id) values (o, k);
  insert into mneme.tasks (source, title, state) values ('standalone', 'Finished root', 'done') returning id into r2;
  insert into mneme.board_positions (board, task_id, x, y) values ('inbox', r1, 10, 20);

  j := mneme.board_data(null);
  perform t.ok(exists (select 1 from jsonb_array_elements(j->'tasks') e where e->>'id' = r1::text)
               and exists (select 1 from jsonb_array_elements(j->'tasks') e where e->>'id' = k::text), 'Inbox board has main tasks on no canvas, with subtasks');
  perform t.ok(not exists (select 1 from jsonb_array_elements(j->'tasks') e where e->>'id' in (o::text, r2::text)),
               'Inbox skips canvas tasks and finished ones');
  perform t.ok(exists (select 1 from jsonb_array_elements(mneme.board_data(null, true)->'tasks') e where e->>'id' = r2::text), '…finished ones on request');
  perform t.ok(j->'positions'->r1::text = '{"x": 10, "y": 20}'::jsonb, 'saved positions come back');
  perform t.ok((select e->'other'->'canvases'->0->>'name' from jsonb_array_elements(j->'links') e where e->>'to_task_id' = k::text) = 'Travel',
               'a link''s far end carries its canvases');
  j := mneme.board_data(cv);
  perform t.ok(jsonb_array_length(j->'tasks') = 1 and j->'tasks'->0->>'id' = o::text, 'a canvas board has its own main tasks');
  perform t.ok(t.throws(format('insert into mneme.board_positions (board, task_id, x, y) values (%L, %L, 0, 0)', 'nope', r1)), 'board key is checked');
  delete from mneme.canvases where id = cv;
  perform t.ok(not exists (select 1 from mneme.board_positions where board = cv::text), 'deleting a canvas drops its layout');
  perform t.logout();

  perform t.login(b);
  perform t.ok(not exists (select 1 from jsonb_array_elements(mneme.board_data(null)->'tasks') e where e->>'user_id' = a::text), 'B sees nothing of A''s board');
  perform t.ok(t.throws(format('insert into mneme.board_positions (board, task_id, x, y) values (%L, %L, 0, 0)', 'inbox', r1)), 'B can''t place A''s task');
  perform t.logout();
end $$;

rollback;
\echo ALL TESTS PASSED
