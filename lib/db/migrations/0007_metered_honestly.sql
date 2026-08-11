-- The meter had three ways to be wrong, and all three favoured the customer,
-- which is exactly why none of them would ever have been reported.
--
-- 1. A failed ffprobe wrote NULL into output_seconds, and SUM() skips NULLs, so
--    that render counted as zero minutes forever. Nothing alerted, nothing
--    reconciled. output_seconds_source records how the number was arrived at,
--    so "we measured it" and "we estimated it" stop looking identical.
--
-- 2. The upload ceiling — the number that actually separates the tiers — was
--    enforced against projects.duration, which the browser writes. Omitting the
--    field skipped the check entirely. source_seconds is measured by the worker
--    from the file itself, and max_source_seconds carries the ceiling the plan
--    allowed at the moment the job was queued, so the worker can enforce it
--    without knowing anything about billing, and a mid-queue downgrade cannot
--    retroactively refuse work already accepted.
--
-- 3. subscriptions.plan defaulted to 'starter', which the plan map aliases to
--    Creator. Any insert that forgot the column handed out sixty minutes,
--    no watermark and reference style, for nothing. Both current insert sites
--    set it explicitly, so this was a trap rather than a leak — but a default
--    that contradicts DEFAULT_PLAN is a trap that goes off eventually.

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS source_seconds real;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS max_source_seconds real;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS output_seconds_source text;

COMMENT ON COLUMN jobs.source_seconds IS
  'Length of the uploaded file, measured by the worker. The trusted one; projects.duration is the browser''s and is for display.';
COMMENT ON COLUMN jobs.max_source_seconds IS
  'Longest source this job''s plan allowed when it was queued. NULL means no ceiling was recorded (pre-0007 rows).';
COMMENT ON COLUMN jobs.output_seconds_source IS
  'probe | estimate | fallback — how output_seconds was arrived at.';

-- Rows written before this migration were measured by probe when they have a
-- value at all; saying so is more useful than leaving the column empty and
-- making every future reader wonder.
UPDATE jobs SET output_seconds_source = 'probe'
 WHERE output_seconds IS NOT NULL AND output_seconds_source IS NULL;

ALTER TABLE subscriptions ALTER COLUMN plan SET DEFAULT 'free';
