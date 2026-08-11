-- The look a project is being edited toward.
--
-- "Match the style of a video you like" has been on every paid plan card since
-- the pricing page was written, and the code that reads a reference —
-- style-measure.ts, 250 lines, 25 tests — has been in the worker the whole
-- time with exactly one importer: its own test file. It measured cuts per
-- minute, kept silence, loudness, saturation, brightness and motion, mapped
-- them onto knobs the renderer already had, and was wired to nothing.
--
-- This is the column that connects it. A path, not a URL: the reference is
-- uploaded to the same private bucket under the same per-user prefix as
-- everything else, because fetching someone's TikTok to analyse it breaks that
-- platform's terms and the exposure would be ours, not the customer's.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS reference_video_path text;

COMMENT ON COLUMN projects.reference_video_path IS
  'Storage key of a video whose look this project should match. Paid plans only; enforced in routes/projects.ts.';

-- Carried onto the job so the worker measures the reference the render was
-- queued with, not whatever the project points at by the time it is claimed.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS reference_path text;

COMMENT ON COLUMN jobs.reference_path IS
  'The reference this render was queued against. Snapshotted so a mid-queue change cannot alter a render already accepted.';
