-- =============================================================================
-- Mneme 15 — schedule the reminder check. Run this ONE MANUALLY in the SQL
-- editor, after (not before) deploying the Edge Function and setting its
-- secret — same order Argus's own (never-activated) migration_v8_ai_export.sql
-- documents:
--
--   1. supabase functions deploy task-reminders
--   2. supabase secrets set MNEME_REMINDER_FUNCTION_SECRET=<a random string>
--      (RESEND_API_KEY is almost certainly already set project-wide for
--      Argus's functions — Supabase secrets are shared by every Edge
--      Function in a project, so it does not need to be set again here.
--      Set MNEME_RESEND_FROM too, e.g. "Mneme <onboarding@resend.dev>", so
--      reminder emails are branded correctly instead of borrowing Argus's
--      RESEND_FROM.)
--   3. Replace <project-ref> and <mneme-reminder-function-secret> below with
--      your real project ref and the SAME secret from step 2, then run this
--      file.
--
-- This enables pg_cron/pg_net PROJECT-WIDE (shared with Argus). Confirmed
-- safe: Argus's own migration_v8_ai_export.sql — which assumes these same
-- extensions — never ran to completion on the live project (its own
-- `create extension` line is what was failing), so no pre-existing Argus
-- cron job is reactivated by enabling them here.
--
-- To inspect or remove the schedule later:
--   select * from cron.job;
--   select * from cron.job_run_details order by start_time desc limit 5;
--   select cron.unschedule('mneme-task-reminders');
-- =============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'mneme-task-reminders',
  '*/10 * * * *',
  $$
  select net.http_post(
    url := 'https://<project-ref>.functions.supabase.co/task-reminders',
    headers := jsonb_build_object(
      'Authorization', 'Bearer <mneme-reminder-function-secret>',
      'Content-Type', 'application/json'
    )
  );
  $$
);
