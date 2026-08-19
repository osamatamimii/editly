-- Four tables the application could not write to, and one of them was the
-- rate limiter.
--
-- 0015 through 0018 each shipped a policy of this shape:
--
--   CREATE POLICY x ON t FOR ALL
--     USING (current_user = 'postgres' OR pg_has_role(current_user,'postgres','MEMBER'))
--
-- together with FORCE ROW LEVEL SECURITY. The intent was "only the server
-- touches this", and the sentence is right; the implementation named the wrong
-- server. This deployment's API connects as `editly_app` — a role with no
-- superuser, no BYPASSRLS, and no membership in postgres — so it matched
-- neither branch. Every earlier table had already established the correct
-- pattern (`FOR ALL TO editly_app`), and these four departed from it.
--
-- What that cost, in order of severity:
--
--   * `rate_limits` — every write route logged "rate limiter unavailable —
--     allowing the request" and served the request anyway. The limiter has been
--     off in production since 0017, which is the failure mode you least want:
--     it degraded open, silently, on the tables that guard abuse.
--   * `billing_events` — the webhook's record of what money did. A real payment
--     would have failed to record.
--   * `assets` — the project library. Writes returned 500; reads returned
--     nothing at all, because a SELECT under a policy that does not match is
--     not an error, it is an empty result. Stock search worked, the download
--     worked, the upload to Storage worked, and the row that ties them to a
--     project could not be written.
--   * `schema_migrations` — a migration run as the app role could not be
--     recorded.
--
-- FORCE is dropped as well. It exists to subject the *owner* to policies, and
-- the owner here is `postgres`, which is not what runs the product. Keeping it
-- while the policy names a different role is how the reads went quiet.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'editly_app') then
    create role editly_app nologin;
  end if;
end $$;

-- assets ---------------------------------------------------------------------
ALTER TABLE public.assets NO FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS assets_service_only ON public.assets;
DROP POLICY IF EXISTS assets_app_role ON public.assets;
CREATE POLICY assets_app_role ON public.assets
  FOR ALL TO editly_app USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.assets TO editly_app;

-- rate_limits ----------------------------------------------------------------
ALTER TABLE public.rate_limits NO FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rate_limits_service_only ON public.rate_limits;
DROP POLICY IF EXISTS rate_limits_app_role ON public.rate_limits;
CREATE POLICY rate_limits_app_role ON public.rate_limits
  FOR ALL TO editly_app USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.rate_limits TO editly_app;

-- billing_events -------------------------------------------------------------
ALTER TABLE public.billing_events NO FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_events_service_only ON public.billing_events;
DROP POLICY IF EXISTS billing_events_app_role ON public.billing_events;
CREATE POLICY billing_events_app_role ON public.billing_events
  FOR ALL TO editly_app USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.billing_events TO editly_app;

-- schema_migrations ----------------------------------------------------------
ALTER TABLE public.schema_migrations NO FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS schema_migrations_owner ON public.schema_migrations;
DROP POLICY IF EXISTS schema_migrations_app_role ON public.schema_migrations;
CREATE POLICY schema_migrations_app_role ON public.schema_migrations
  FOR ALL TO editly_app USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.schema_migrations TO editly_app;

-- Row-level security stays *enabled* on all four. That is what keeps the
-- anon and authenticated roles — the ones a browser can reach through
-- PostgREST — out of tables that only the server has any business in.
