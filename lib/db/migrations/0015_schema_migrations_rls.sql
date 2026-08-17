-- The ledger this repository's own migration tool created is a public table.
--
-- Everything in `public` is served by PostgREST, and Supabase's linter flags it
-- as an ERROR: `public.schema_migrations` is reachable with the anon key that
-- ships in the browser bundle. What it leaks is small — filenames and the times
-- they were applied — but it is a list of every schema change this product has
-- ever made, handed to anyone who asks, and the four tables that hold customer
-- data all had RLS from the day they were created. The table that was added to
-- *fix* a schema problem is the one that arrived without the rule.
--
-- RLS with no policies is the correct state here: nothing outside the migration
-- tool has any business reading this, and that tool connects as the owner,
-- which bypasses RLS. So this is a deny-all for every client and a no-op for
-- the only legitimate reader.
ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;

-- FORCE so that even a future owner-level connection has to be deliberate about
-- it rather than inheriting an exemption nobody remembers granting.
ALTER TABLE schema_migrations FORCE ROW LEVEL SECURITY;

-- The migration tool itself must still be able to read and write its own
-- ledger, and FORCE applies to the owner too — so it gets an explicit policy
-- rather than an implicit exemption.
DROP POLICY IF EXISTS schema_migrations_owner ON schema_migrations;
CREATE POLICY schema_migrations_owner ON schema_migrations
  FOR ALL
  USING (current_user = 'postgres' OR pg_has_role(current_user, 'postgres', 'MEMBER'))
  WITH CHECK (current_user = 'postgres' OR pg_has_role(current_user, 'postgres', 'MEMBER'));
