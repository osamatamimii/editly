-- The one narrow question was answerable by anyone with the anon key.
--
-- 0020 created `public.user_id_for_email` as SECURITY DEFINER so the billing
-- webhook — connecting as `editly_app` — could resolve an email without
-- USAGE on the auth schema. It revoked EXECUTE from PUBLIC and granted it to
-- `editly_app`, which reads as airtight and is not: a managed Supabase
-- project carries ALTER DEFAULT PRIVILEGES that grant EXECUTE on every new
-- public function to `anon`, `authenticated` and `service_role` directly.
-- Those are grants in their own right, not inherited through PUBLIC, so the
-- revoke from PUBLIC never touched them — and PostgREST happily exposed the
-- function at /rest/v1/rpc/user_id_for_email.
--
-- Which made it an oracle: anyone holding the public anon key could map any
-- email address to whether an account exists here and to its user id. Email
-- enumeration is the reason login pages say "invalid credentials" instead of
-- "no such user"; this function said the quiet part over REST.
--
-- Supabase's own linter caught it (0028/0029). The fix is the revoke 0020
-- should have written. `service_role` keeps EXECUTE: it bypasses RLS anyway,
-- so revoking it buys nothing and breaks nothing — but anon and authenticated
-- have no business asking.
revoke execute on function public.user_id_for_email(text) from anon, authenticated;

-- Belt to the braces above: future functions in public get no automatic
-- EXECUTE for the API roles either. The default privileges are re-stated
-- rather than dropped so `service_role` behaviour is unchanged.
--
-- Scoped to the role that owns objects created by migrations; a migration
-- run by a different owner must repeat the revoke explicitly (0020's lesson:
-- write the revoke beside the create, always).
do $$
begin
  execute format(
    'alter default privileges for role %I in schema public revoke execute on functions from anon, authenticated',
    current_user
  );
end $$;
