-- The mail can be written; there was no way to find out where to send it.
--
-- `0041` gave this product a sender and the two tables that stop it sending
-- twice. What it did not need at the time was an address lookup: the only
-- caller was the billing webhook, and Freemius hands the email over in the
-- payload.
--
-- The next letter is "your edit is ready", and it is queued by the **worker**,
-- which knows a `user_id` and nothing else. There is no address anywhere in
-- this schema — identity lives in `auth.users`, which `editly_app` has no USAGE
-- on at all.
--
-- This is the same wall met twice before, and it is met the same supported way:
-- a SECURITY DEFINER function answering one narrow question with its owner's
-- rights. `0020` did it for "which user owns this email"; this is the inverse,
-- and it is the more dangerous direction, which is why the grants below are
-- spelled out one role at a time.
--
-- `search_path = ''` because a definer function with a mutable search path can
-- be hijacked by objects created earlier on the path; empty means every name in
-- the body must be schema-qualified, and is.
create or replace function public.email_for_user(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select u.email::text from auth.users u where u.id = p_user_id limit 1;
$$;

revoke all on function public.email_for_user(uuid) from public;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'editly_app') then
    create role editly_app nologin;
  end if;
end $$;

-- Supabase grants EXECUTE on every new function in `public` to the PostgREST
-- roles through ALTER DEFAULT PRIVILEGES. That grant is independent of PUBLIC,
-- so revoking from PUBLIC alone would leave this callable by anyone holding the
-- anon key over /rest/v1/rpc -- and this one turns a user id into an email
-- address. `0028` learned that the expensive way; both roles are named here,
-- and guarded, because a local database has neither.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.email_for_user(uuid) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.email_for_user(uuid) from authenticated';
  end if;
end $$;

grant execute on function public.email_for_user(uuid) to editly_app;
