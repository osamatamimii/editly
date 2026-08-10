-- Billing moves from "videos this month" to "minutes of finished video".
--
-- Counting videos charged the same for a nine-second hook and a ninety-minute
-- episode. Minutes are what people buy and what we can defend, so the worker
-- now records how long each render actually came out.
--
-- Nullable on purpose: every job rendered before this column existed has no
-- honest value, and writing a zero would quietly tell the quota those renders
-- were free. Null means "not measured", and the quota skips it.

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS output_seconds real;

COMMENT ON COLUMN jobs.output_seconds IS
  'Duration of the rendered output in seconds, measured by the worker after encoding. Null for jobs that predate minute-based billing.';

-- The quota query asks: how many seconds has this user produced since the first
-- of the month. This is the index it walks.
CREATE INDEX IF NOT EXISTS jobs_user_finished_idx
  ON jobs (user_id, finished_at)
  WHERE status = 'done';
