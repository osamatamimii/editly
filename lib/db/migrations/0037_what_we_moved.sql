-- What this deployment stored and what it moved, so the bill is a measurement.
--
-- The dominant cost of a video product is not compute and it is not the
-- database. It is **egress** — bytes leaving object storage — and at the
-- prices this project pays it becomes the largest line long before anything
-- else does. On Supabase egress is $0.09/GB after the first 250; on
-- Cloudflare R2 it is nothing at all.
--
-- That is a decision worth tens of thousands a month at scale, and it was
-- about to be made from my estimate in a document. This is so it can be made
-- from our own number instead.
--
-- ## Why egress here is mostly our own traffic
--
-- Every render downloads the whole source out of storage onto the worker.
-- Measured against the way people actually use this product — ask again, it is
-- free — a published video costs three or more of those downloads. That is
-- roughly nine tenths of everything we will ever pay to move, and unlike a
-- customer watching a preview, it is a number we can count exactly.

-- What one render pulled in. Written by the worker at the end, beside the
-- seconds it already records for billing.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS bytes_in bigint;

COMMENT ON COLUMN jobs.bytes_in IS
  'Bytes this render downloaded out of storage: the source, the reference, and any assets. The dominant term in what egress costs, and the only part of it we can count exactly.';

-- And what is being kept.
--
-- `storage.objects` holds an exact size per object and the application role
-- cannot read that schema — the same wall `auth.users` presented, with the
-- same supported way through it: one narrow SECURITY DEFINER function that
-- answers one question.
--
-- `search_path` is pinned to empty and every name inside is schema-qualified,
-- because a definer function that resolves a name through a caller-controlled
-- path is the classic way one becomes a privilege escalation.
CREATE OR REPLACE FUNCTION public.storage_usage()
RETURNS TABLE (objects bigint, bytes bigint)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT count(*)::bigint,
         coalesce(sum((o.metadata->>'size')::bigint), 0)::bigint
    FROM storage.objects o
   WHERE o.bucket_id = 'videos';
$$;

COMMENT ON FUNCTION public.storage_usage() IS
  'Object count and total bytes in the videos bucket. Definer because the application role has no access to the storage schema; answers one question and returns no paths.';

-- Supabase grants EXECUTE on every new public function to the PostgREST roles
-- directly, through ALTER DEFAULT PRIVILEGES. That is a separate grant which
-- `REVOKE FROM PUBLIC` does not touch — so without these two lines the
-- function is callable by anybody holding the anon key.
REVOKE ALL ON FUNCTION public.storage_usage() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.storage_usage() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.storage_usage() TO editly_app;
