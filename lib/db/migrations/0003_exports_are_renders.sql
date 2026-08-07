-- An export is now a render framed for one platform, not a five-second
-- simulation that returned a download URL pointing at example.com.
--
-- Applied to the Supabase project on 2026-08-07.
alter table public.exports add column if not exists job_id text references public.jobs(id) on delete set null;

-- Rows created by the old simulation reported a status nothing produced and a
-- download URL that never resolved. Better to have no export than a false one.
delete from public.exports where job_id is null;
