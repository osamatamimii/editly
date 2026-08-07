-- Phase 2: durable video storage.
--
-- Applied to the Supabase project on 2026-08-07. Kept here so the schema can be
-- rebuilt from scratch, and so the storage policies are reviewable in code
-- rather than living only in the dashboard.

-- ── The bucket ──────────────────────────────────────────────────────────────
-- Private. Object keys are always "<auth.uid()>/<project_id>/<name>", which is
-- what the policies below rely on to keep one user's bytes invisible to others.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'videos',
  'videos',
  false,
  52428800, -- 50 MB: the hard per-file ceiling on the Supabase free plan
  array['video/mp4', 'video/quicktime', 'video/webm']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "videos_owner_select" on storage.objects;
drop policy if exists "videos_owner_insert" on storage.objects;
drop policy if exists "videos_owner_update" on storage.objects;
drop policy if exists "videos_owner_delete" on storage.objects;

create policy "videos_owner_select" on storage.objects
  for select to authenticated
  using (bucket_id = 'videos' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "videos_owner_insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'videos' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "videos_owner_update" on storage.objects
  for update to authenticated
  using (bucket_id = 'videos' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'videos' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "videos_owner_delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'videos' and (storage.foldername(name))[1] = auth.uid()::text);

-- ── Pointers on the project row ─────────────────────────────────────────────
-- Signed URLs expire, so the database stores the durable object key and the
-- client mints a URL when it actually needs to play something.
alter table public.projects add column if not exists video_path text;
alter table public.projects add column if not exists edited_video_path text;

-- "blob:" URLs, written by the old fake upload, only ever resolved inside the
-- tab that created them. They are dead references for anyone loading later.
update public.projects set video_url = null where video_url like 'blob:%';
update public.projects set edited_video_url = null where edited_video_url like 'blob:%';
