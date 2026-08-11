-- "Claimed before older jobs when the queue is busy" — plan-limits.ts has said
-- this about Pro and Studio since the tiers were written, and the claim query
-- has ordered strictly by created_at the whole time. The promise had no
-- implementation anywhere in the repository.
--
-- Priority lives on the job rather than being joined from the subscription at
-- claim time, for the same reason the upload ceiling does: the worker should
-- need to know nothing about billing, the claim has to stay one atomic
-- statement, and the deal someone was on when they queued the work is the deal
-- that should be honoured — upgrading does not reach back and reorder a queue,
-- and downgrading does not demote work already accepted.

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN jobs.priority IS
  'Higher is claimed first. Set from the plan when the job is queued; 0 for everyone whose plan does not include it.';

-- The old index sorted (status, created_at), which is now the wrong order for
-- the query and would leave it sorting in memory on every claim.
DROP INDEX IF EXISTS jobs_queue_idx;
CREATE INDEX IF NOT EXISTS jobs_queue_idx ON jobs (status, priority DESC, created_at);
