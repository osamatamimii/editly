-- An export is now a render framed for one platform, not a five-second
-- simulation that returned a download URL pointing at example.com.
--
-- Applied to the Supabase project on 2026-08-07.
alter table public.exports add column if not exists job_id text references public.jobs(id) on delete set null;

-- Rows created by the old simulation reported a status nothing produced and a
-- download URL that never resolved. Better to have no export than a false one.
--
-- Bounded by the date this ran, and that bound is the whole safety of it.
--
-- It was `where job_id is null` on its own, which was correct on 7 August: a
-- null job_id could only mean a simulated row, because nothing else produced
-- one. It is not correct now. The foreign key on the line above is
-- `on delete set null`, so a null job_id is an ordinary state for a real
-- export whose job row has since gone — which is exactly what account deletion
-- produces, and what any future pruning of finished jobs would produce.
--
-- The migration ledger is what normally stops a file running twice, and that
-- is the real mechanism. But `tools/migrate.mjs` adopts 0000..0005 only when
-- the ledger is empty *and* `projects.video_path` exists, so a database
-- restored without `schema_migrations` runs every file from 0000 — and this
-- one would then delete every export that had outlived its job. The date makes
-- it as safe on a second application as every other migration in this
-- directory.
delete from public.exports where job_id is null and created_at < timestamptz '2026-08-07';
