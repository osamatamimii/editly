-- The admin console has to show who signed up, and "who" is an email address.
-- Addresses live in `auth.users`, which the application role cannot read: the
-- schema is owned by `supabase_admin` and USAGE is not ours to grant. That is
-- the same wall migration 0020 hit, and the answer is the same shape — a
-- SECURITY DEFINER function that answers exactly one question and nothing
-- wider.
--
-- Two functions rather than one, because a list and its total are different
-- questions and a count that is computed from a page is a count that lies as
-- soon as there is a second page.
--
-- `search_path = ''` because a definer function with a mutable search path can
-- be hijacked by objects created earlier on the path; empty means every name
-- in the body must be schema-qualified, and is.
--
-- What these deliberately do NOT return: password hashes, tokens, recovery
-- data, raw metadata, banned/deleted flags. The console shows an address, when
-- the account was made, and when it was last used. Anything more is not
-- operations, it is surveillance, and the cheapest place to refuse it is here
-- where the data is read rather than in the interface that displays it.

create or replace function public.admin_accounts(
  p_search text,
  p_limit int,
  p_offset int
)
returns table (user_id uuid, email text, created_at timestamptz, last_sign_in_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select u.id, u.email::text, u.created_at, u.last_sign_in_at
  from auth.users u
  where p_search is null
     or p_search = ''
     or u.email::text ilike '%' || p_search || '%'
  order by u.created_at desc
  limit least(greatest(coalesce(p_limit, 100), 1), 200)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

create or replace function public.admin_account_count(p_search text)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)
  from auth.users u
  where p_search is null
     or p_search = ''
     or u.email::text ilike '%' || p_search || '%';
$$;

-- Supabase grants EXECUTE on every new public function to the PostgREST roles
-- through ALTER DEFAULT PRIVILEGES. That grant is independent of PUBLIC, so
-- revoking from PUBLIC alone leaves both of these callable by anyone holding
-- the anon key over /rest/v1/rpc — which would make this migration the widest
-- data leak in the product rather than a narrowing of one.
revoke all on function public.admin_accounts(text, int, int) from public;
revoke all on function public.admin_account_count(text) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.admin_accounts(text, int, int) from anon';
    execute 'revoke all on function public.admin_account_count(text) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.admin_accounts(text, int, int) from authenticated';
    execute 'revoke all on function public.admin_account_count(text) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke all on function public.admin_accounts(text, int, int) from service_role';
    execute 'revoke all on function public.admin_account_count(text) from service_role';
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'editly_app') then
    create role editly_app nologin;
  end if;
end $$;

grant execute on function public.admin_accounts(text, int, int) to editly_app;
grant execute on function public.admin_account_count(text) to editly_app;
