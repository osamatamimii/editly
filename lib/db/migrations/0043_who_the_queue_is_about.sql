-- The work queue names things, and a thing belongs to somebody.
--
-- The console's new attention page lists the actual renders, posts, accounts
-- and payments that need a person, rather than a count of each. Every one of
-- those rows carries a `user_id` and nothing else that identifies who it is
-- about — and a queue that says "render 8f21c3a4 failed, owner
-- 4d0c…-…-9b2e" is a queue whose next step is a database prompt. The whole
-- point of listing the things is that the next step is an action.
--
-- Addresses live in `auth.users`, which the application role cannot read, for
-- the reasons migration 0028 sets out. `admin_accounts` cannot answer this
-- question: it filters by an email substring, and here the ids are what is
-- known and the addresses are what is wanted. So one more definer function,
-- as narrow as the others.
--
-- It takes a list of ids and returns their addresses. It cannot be used to
-- enumerate: a caller who does not already hold a user id learns nothing, and
-- a caller who holds every user id could have called `admin_accounts` anyway.
-- The bound is there so a bad or hostile call cannot turn into a table scan.
--
-- `search_path = ''` for the same reason as 0028: a definer function with a
-- mutable search path can be hijacked by objects created earlier on the path,
-- and empty means every name in the body is schema-qualified, and is.
--
-- What it deliberately does not return: everything 0028 refuses. An id and an
-- address, and nothing else.

create or replace function public.admin_emails(p_ids uuid[])
returns table (user_id uuid, email text)
language sql
stable
security definer
set search_path = ''
as $$
  select u.id, u.email::text
  from auth.users u
  where u.id = any(coalesce(p_ids, array[]::uuid[]))
  limit 500;
$$;

-- Supabase grants EXECUTE on every new public function to the PostgREST roles
-- through ALTER DEFAULT PRIVILEGES, independently of PUBLIC. Revoking from
-- PUBLIC alone would leave this callable by anyone holding the anon key over
-- /rest/v1/rpc, which is the opposite of what it is for.
revoke all on function public.admin_emails(uuid[]) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.admin_emails(uuid[]) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.admin_emails(uuid[]) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke all on function public.admin_emails(uuid[]) from service_role';
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'editly_app') then
    create role editly_app nologin;
  end if;
end $$;

grant execute on function public.admin_emails(uuid[]) to editly_app;
