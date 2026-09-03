-- The Shopify integration's only state.
--
-- One row per shop that has installed the app: the offline access token, what
-- it is allowed to do, and when they arrived and left. Everything else a
-- merchant makes lands in the tables that already exist, under an account id
-- derived from the shop domain rather than allocated here — see
-- lib/shopify/domain.ts for why that is arithmetic and not a column.
--
-- No foreign key to anything. `user_id` is a UUID version 5 minted from the
-- domain, so there is no `auth.users` row for it to reference: a shop is not a
-- person who signed up, and pretending otherwise would mean creating an account
-- nobody can sign in to in order to satisfy a constraint.
--
-- The row survives an uninstall on purpose. Shopify sends `shop/redact` 48
-- hours later and that is when the data goes; in between, a merchant who
-- reinstalls gets their projects back instead of an empty account.
CREATE TABLE IF NOT EXISTS shopify_shops (
  shop           text PRIMARY KEY,
  user_id        uuid NOT NULL,
  access_token   text NOT NULL,
  scopes         text NOT NULL DEFAULT '',
  installed_at   timestamptz NOT NULL DEFAULT now(),
  uninstalled_at timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Every query that starts from a project row and wants to know which shop it
-- belongs to arrives by this column.
CREATE INDEX IF NOT EXISTS shopify_shops_user_idx ON shopify_shops (user_id);

-- The table holds an access token that can read a merchant's catalogue, so it
-- is the one table in this schema where a stray read is a credential leak
-- rather than a privacy incident. Row-level security on, with a policy for the
-- application role and nobody else — the shape every table in `public` has, and
-- which tools/schema-test.mjs asserts for all of them so the next one added
-- meets the rule before it ships rather than after Supabase's linter finds it.
ALTER TABLE shopify_shops ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'shopify_shops' AND policyname = 'shopify_shops_app'
  ) THEN
    EXECUTE 'CREATE POLICY shopify_shops_app ON shopify_shops FOR ALL TO editly_app USING (true) WITH CHECK (true)';
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON shopify_shops TO editly_app;
