-- The database was quietly undoing a billing rule the code takes care to state.
--
-- `routes/projects.ts` deletes a project's messages and exports and leaves its
-- jobs alone, with a comment explaining why: the meter sums `output_seconds`
-- over finished jobs this month, so removing them would make "delete your
-- projects" a way to reset your allowance and render for nothing. That is the
-- same hole `render-policy.ts` exists to close, reopened from the other side.
-- `account-deletion.ts` says the same thing, and `tools/isolation-test.mjs`
-- asserts it: delete a project, and the minutes it produced stay counted.
--
-- Meanwhile `jobs.project_id` carried `ON DELETE CASCADE`, and Postgres was
-- deleting them anyway.
--
-- The reason nobody saw it is that the test database was built by `drizzle-kit
-- push` from the Drizzle schema, which declares no foreign keys at all, while
-- production was built from the SQL in this directory, which declares four. The
-- check that was supposed to catch this passed locally against a database
-- shaped differently from the one it was describing. Rebuilt from the
-- migrations, it fails: "2 before, 0 after".
--
-- Jobs do not reference projects. Ownership is denormalised onto every row
-- precisely so that no query needs a join, and a job whose project is gone is
-- not garbage — it is the record of a render that happened, which is the whole
-- basis of the bill. Account deletion removes jobs by user_id, so nothing
-- accumulates forever.
--
-- Messages and exports keep their cascade. Those genuinely belong to the
-- project and are worthless without it, and the cascade is a backstop under the
-- explicit deletes rather than the mechanism.

ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_project_id_fkey;

COMMENT ON COLUMN public.jobs.project_id IS
  'The project this render was for. Deliberately not a foreign key: a job outlives its project because the minutes it produced were produced, and cascading it would make deleting a project a way to reset the meter.';

-- ── The indexes the cascades actually walk ──────────────────────────────────
--
-- A foreign key without a covering index means every delete of a parent row
-- sequentially scans the child table. Invisible at three projects, and the kind
-- of thing that is discovered under load, at which point it is discovered by a
-- customer. The composite indexes these tables already carry lead with
-- `user_id`, so they cannot answer "which rows point at this project".
CREATE INDEX IF NOT EXISTS messages_project_idx ON public.messages (project_id);
CREATE INDEX IF NOT EXISTS exports_project_idx  ON public.exports (project_id);
CREATE INDEX IF NOT EXISTS exports_job_idx      ON public.exports (job_id);
