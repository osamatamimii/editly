-- Poster frames, and the clip's real length.
--
-- Applied to the Supabase project on 2026-08-07.
--
-- `thumbnail_url` was rendered on every dashboard card and never populated, so
-- every project was a grey rectangle. And `duration` was never written, which
-- mattered more than it looks: templates place their punch-in zooms across the
-- clip's length, and with no length they fell back to 30 seconds — so on a
-- three-minute video every punch landed in the first thirty seconds.
alter table public.projects add column if not exists thumbnail_path text;

-- The bucket only accepted video, so the poster frame could not be stored in it.
update storage.buckets
set allowed_mime_types = array['video/mp4', 'video/quicktime', 'video/webm', 'image/jpeg']
where id = 'videos';
