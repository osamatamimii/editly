-- The billing webhook maps a Freemius event to an account with exactly one
-- question: which user id owns this email? It used to ask by querying
-- `auth.users` directly — and the application connects as `editly_app`, which
-- has no USAGE on the `auth` schema at all. So every webhook died with
-- "permission denied" *after* recording the event and *before* deciding
-- anything. Upgrades still appeared to work, but only because the
-- claim-on-read path (which learns the user from the session, not from
-- auth.users) picked the event up when the buyer next loaded the app.
-- Downgrades never applied: the claim path refuses them by design, and the
-- webhook — the only path allowed to downgrade — never got as far as deciding.
--
-- Found by cancelling a sandbox subscription and watching `outcome` stay null.
--
-- Granting the role access to auth.users is not ours to do: on Supabase the
-- schema is owned by `supabase_admin`, and even `postgres` holds plain USAGE
-- with no grant option — the GRANT silently grants nothing. The supported
-- shape is a SECURITY DEFINER function: it runs with its owner's rights, and
-- its owner (the migration role) can read auth.users. The app role gets
-- EXECUTE on this one narrow question and nothing else — not the schema, not
-- the table, and never the columns it has no business reading.
--
-- `search_path = ''` because a definer function with a mutable search path
-- can be hijacked by objects created earlier on the path; empty means every
-- name in the body must be schema-qualified, and is.
create or replace function public.user_id_for_email(p_email text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select id from auth.users where lower(email) = lower(p_email) limit 1;
$$;

revoke all on function public.user_id_for_email(text) from public;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'editly_app') then
    create role editly_app nologin;
  end if;
end $$;

grant execute on function public.user_id_for_email(text) to editly_app;

-- Tidy up the attempt this migration replaces: column grants on auth.users
-- are dead weight without schema USAGE, and dead grants read as intent.
do $$
begin
  if exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'auth' and c.relname = 'users'
  ) then
    revoke select (id, email) on auth.users from editly_app;
  end if;
end $$;
