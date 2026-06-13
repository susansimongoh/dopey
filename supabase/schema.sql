-- SPS Media Monitor – Supabase schema
-- Run this in your Supabase SQL Editor (https://supabase.com/dashboard → SQL Editor)

-- ── sessions table ──────────────────────────────────────────────────────
-- One row per monitoring day. clips and stories stored as JSON arrays.
CREATE TABLE IF NOT EXISTS sessions (
  id         uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  date       date        NOT NULL UNIQUE,          -- e.g. 2026-06-03
  saved_at   timestamptz DEFAULT now(),
  cfg        jsonb       NOT NULL DEFAULT '{}',    -- report number, date string, highlights, etc.
  clips      jsonb       NOT NULL DEFAULT '[]',    -- array of clip objects
  stories    jsonb       NOT NULL DEFAULT '[]'     -- array of story objects
);

-- Fast date-descending queries (for history list)
CREATE INDEX IF NOT EXISTS sessions_date_idx ON sessions (date DESC);

-- ── Row Level Security ──────────────────────────────────────────────────
-- This is a personal internal tool — allow all operations from the anon key.
-- If you ever add user auth, replace these with user-scoped policies.
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "allow_all" ON sessions
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- ── pg_cron for daily scraping (optional) ───────────────────────────────
-- Enable the pg_cron extension first: Database → Extensions → pg_cron
-- Then run this to trigger the Edge Function every morning at 7am SGT (23:00 UTC):
--
-- SELECT cron.schedule(
--   'sps-daily-scrape',
--   '0 23 * * *',
--   $$
--     SELECT net.http_post(
--       url := 'https://ezQ96J5Y5Xd8b1sa.supabase.co/functions/v1/daily-scrape',
--       headers := jsonb_build_object(
--         'Authorization', 'Bearer ' || current_setting('app.service_role_key'),
--         'Content-Type', 'application/json'
--       ),
--       body := '{}'::jsonb
--     );
--   $$
-- );
