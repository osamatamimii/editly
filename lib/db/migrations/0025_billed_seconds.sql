-- What the meter charges for a job, separated from what the job produced.
--
-- Until now the two were the same column: `output_seconds`, measured from the
-- finished file, summed by the meter. Clips broke the equivalence. A clips
-- render reads the *whole* source — transcribes it, scores every window,
-- renders each chosen piece — and then produces ninety seconds of output from
-- an hour of input. Charging the ninety seconds bills the cheapest part of
-- the work and gives the expensive part away, which is the kind of pricing
-- error nobody reports because it is always in their favour.
--
-- So the charge gets its own column, recorded by the worker at the moment
-- the job finishes — the one time the number is known rather than inferred.
-- A single render is billed at what it produced (nothing changes for it); a
-- clips render is billed at the source it read, and its notes say so in the
-- conversation, because a charge the customer cannot see coming is a charge
-- they will dispute.
--
-- NULL means "recorded before this column existed": the meter falls back to
-- output_seconds for those rows, which is exactly what they were billed at
-- the time. No backfill, because rewriting history is how ledgers stop being
-- ledgers.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS billed_seconds real;

COMMENT ON COLUMN jobs.billed_seconds IS
  'Seconds the meter charges for this job. Output seconds for a single render; source seconds for a clips render, which reads the whole file. NULL on rows from before the column existed - the meter falls back to output_seconds for those.';
