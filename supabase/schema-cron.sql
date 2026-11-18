-- ============================================================
--  Mnemos — OPTIONAL: schedule the always-on daily rank tracker
--  Run this only if you deployed the `track-brands` Edge Function
--  and want true 24/7 daily snapshots (independent of app visits).
--
--  Prereqs (Dashboard → Database → Extensions): enable `pg_cron`
--  and `pg_net`. Then replace the two placeholders below and run.
-- ============================================================

-- Replace with your project ref + a CRON_SECRET you also set on the function
--   supabase secrets set CRON_SECRET=your-long-random-string
-- Function URL looks like: https://<project-ref>.functions.supabase.co/track-brands

select cron.schedule(
    'mnemos-daily-track',
    '17 4 * * *',                       -- every day at 04:17 UTC
    $$
    select net.http_post(
        url     := 'https://<PROJECT_REF>.functions.supabase.co/track-brands',
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'x-cron-secret', '<CRON_SECRET>'
        ),
        body    := '{}'::jsonb
    );
    $$
);

-- To inspect / remove:
--   select * from cron.job;
--   select cron.unschedule('mnemos-daily-track');
