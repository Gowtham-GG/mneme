-- =============================================================================
-- Mneme SQL test-suite.  Run against a THROWAWAY database only (it creates
-- auth.users rows), never against the production project:
--     psql -v ON_ERROR_STOP=1 -f supabase/tests/mneme_tests.sql
-- Everything runs in one transaction that is rolled back at the end.
-- =============================================================================
\set ON_ERROR_STOP on
begin;

create schema t;
grant usage on schema t to authenticated, anon;

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

grant execute on all functions in schema t to authenticated, anon;

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


rollback;
\echo ALL TESTS PASSED
