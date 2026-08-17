-- The month's remaining allowance, snapshotted onto the job.
--
-- `max_source_seconds` already travels this way: the API decides the ceiling,
-- writes it on the row, and the worker re-checks the file it actually
-- downloaded against it. The worker therefore needs to know nothing about plans
-- or prices, and a plan change while the job waited cannot retroactively refuse
-- work already accepted.
--
-- The allowance had no such column, and that is a hole. `projects.duration` is
-- written by the browser and is nullable — the schema itself notes the browser
-- cannot always decode a file — and the policy layer skips *both* the ceiling
-- check and the allowance check when it is absent. The ceiling survives that,
-- because the worker re-measures. The allowance does not: a free user with one
-- minute left uploads a nine-minute file whose duration never got recorded, the
-- "would exceed" refusal is skipped because there is no number to compare, the
-- render runs, and ~540 seconds are written to the meter after the fact. They
-- received nine minutes of product on a five-minute plan and we paid for the
-- encode. The guard's own comment says it exists so that never happens.
--
-- With this column the worker can apply the same rule to the number it measured
-- itself, which is the only one that was never a claim.
--
-- NULL means "queued before this existed" and is treated as no limit, exactly
-- as a NULL max_source_seconds is: refusing old rows on a column they could not
-- have carried would be inventing a failure.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS remaining_seconds real;

COMMENT ON COLUMN jobs.remaining_seconds IS
  'Seconds left in the user''s monthly allowance when this job was accepted. The worker refuses a file it measures as longer. NULL = unlimited (pre-existing rows).';
