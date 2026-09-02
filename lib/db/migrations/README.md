# Migrations

Applied by hand against the Supabase project and kept here so the schema can be
rebuilt from nothing, and so the storage policies are reviewable in code rather
than living only in a dashboard.

Run them in order against a fresh database:

```
DATABASE_URL=postgres://… pnpm run migrate
```

`tools/schema-test.mjs` proves that running these files against an empty
Postgres produces exactly the columns the code declares, and that a database
which is behind says so through `/api/healthz`.

---

## Backup and restore

Everything this product knows is in one database: the accounts, the projects,
the clips, the social tokens, and the ledger that records who paid what. So the
question worth answering is not whether a backup exists. It is whether the
database you get back from one is a database the product can run against.

`tools/restore-drill.mjs` is how that is answered. Run it:

```
node tools/restore-drill.mjs                        # rehearse the procedure locally
node tools/restore-drill.mjs --source "postgres://…" # the real drill
```

The second form reads the source with `pg_dump` and never writes to it, and it
always restores onto the **local** test server — never onto the source's. That
is enforced in the code rather than left to whoever is running it, because the
one unrecoverable mistake this exercise can make is restoring over the thing it
was trying to protect.

### What a dump does not contain, and why it matters here

`pg_dump` dumps a *database*. Roles are a property of the **cluster** and are
not in the file. Our dump therefore contains

```sql
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY projects_app ON projects FOR ALL TO editly_app USING (true) …;
GRANT SELECT, INSERT, UPDATE, DELETE ON projects TO editly_app;
```

and on a fresh server, where `editly_app` does not exist, the second and third
statements fail while the first succeeds. `psql` continues past errors unless
told not to. What you are left with is a database with every table, every row,
every index — row-level security switched **on**, and no policy underneath it.

Every read the application then makes returns **zero rows rather than an
error**, at full speed, with nothing in any log. That is not a hypothetical
failure mode for this project: four migrations once shipped a policy naming
`postgres` while the API connects as `editly_app`, and reads went quiet in
production for as long as they were live.

So the restore has two steps in a fixed order, and the drill performs them in
that order:

1. **Create the roles the dump names.** The drill reads them out of the dump
   file itself — every role named in a `GRANT`, a `CREATE POLICY` or an
   `OWNER TO` — rather than from a list kept here, which would go stale the
   first time a migration granted to something new. `pg_dumpall --roles-only`
   is the textbook answer and is not available on a managed Supabase project,
   where nobody hands you a superuser.
2. **Restore the dump with `psql -v ON_ERROR_STOP=1`.** Without that flag a
   half-restore looks exactly like a whole one.

### What the drill checks, and the one check that matters

Tables, columns, row counts per table, row-level security still on where it was
on, every policy present and naming the same roles, extensions installed, and
the `SECURITY DEFINER` functions back with the anon roles still revoked.

Then the one that is not about the schema at all:

> **`SET ROLE editly_app`, read a table that had rows in the source, and get
> them back.**

Every other check can pass on a database the product cannot use. This one is
the difference between a restore and a file.

And because a verifier that has never failed is decoration, the drill
deliberately damages two restores and requires itself to catch them: one with
the policy statements stripped — byte for byte what the file becomes when the
roles were not created first — and one restored from `--schema-only`, which has
every table and no data.

### Status, stated plainly

The drill has been run against a **synthetic source built from these
migrations**, on a local Postgres 16, and it passes — including the two damaged
restores, which it fails as it should. Total for that run: about one second,
against a schema with three rows in it.

It has **not** been run against production. That needs the production
connection string, which no automated session here holds, and it needs Supabase
Pro for the daily backup it would be rehearsing. Until somebody runs

```
node tools/restore-drill.mjs --source "$PRODUCTION_DATABASE_URL"
```

and writes the measured time below, this project has a tested *procedure* and
an untested *recovery*. Those are different things and the difference should
not be blurred.

| Run | Source | Dump | Restore | Verify | Result |
| --- | --- | --- | --- | --- | --- |
| 2026-09-02 | synthetic, built from `lib/db/migrations` | 0.08s | 0.28s | 0.03s | 22/22 |
| — | production | — | — | — | not yet run |
