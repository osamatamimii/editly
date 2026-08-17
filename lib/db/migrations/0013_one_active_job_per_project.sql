-- One render at a time per project — enforced, not merely checked.
--
-- Both routes that queue work (POST /projects/:id/render and
-- POST /projects/:id/export) already refuse when the project has a queued or
-- running job. Both do it the same way: SELECT the latest job, look at its
-- status, then INSERT. There is no transaction around the pair and nothing in
-- the database stopping the second insert, so two requests a few milliseconds
-- apart — a double-click, or the browser's own retry after a dropped response —
-- both read "nothing pending" and both write a job.
--
-- What that costs is not a duplicate row. The worker renders both, both write
-- output_seconds, and usageFor sums them: a Creator customer with eight minutes
-- left double-clicks Export on a four-minute clip and has consumed all eight,
-- for one video. Only the latest export row is ever shown, so the second render
-- is invisible while being billed. It is the exact mirror of the ON DELETE
-- CASCADE that used to refund minutes, pointing the other way.
--
-- A partial unique index states the invariant those two guards are trying to
-- express, in the one place that can actually hold it. The insert now fails
-- with 23505 instead of succeeding, and both routes translate that into the
-- same 409 they would have returned had they seen the row.
--
-- Verified empty on production before adding: no project currently holds two
-- active jobs, so this cannot fail on existing rows.
CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_active_per_project
  ON jobs (project_id)
  WHERE status IN ('queued', 'running');
