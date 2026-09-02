/**
 * Applies every migration in `lib/db/migrations`, in order, once.
 *
 * This exists because on 12 August the production database was five migrations
 * behind and had been for two days. The files were written, reviewed and
 * committed; applying them was a thing a person had to remember to do by hand,
 * against a console, and nothing anywhere noticed that nobody had. Every query
 * in the product failed, and the product's own health check said ok.
 *
 * So: a command. `pnpm run migrate` against any DATABASE_URL, safe to run
 * repeatedly, and it prints what it did rather than what it intended to do.
 *
 * Two deliberate choices.
 *
 * It records what it has applied in `schema_migrations` rather than trusting
 * the SQL to be idempotent. Every file here is written with IF NOT EXISTS and
 * would survive re-running today — but that is a property of how they happen to
 * be written, not a property of migrations, and the first UPDATE that backfills
 * a column would silently do it twice.
 *
 * And each file runs inside its own transaction, so a migration that fails
 * halfway leaves the database as it was rather than half-migrated. Half-applied
 * is the state that is hardest to reason about later, because the file has a
 * name and a number and appears to have run.
 *
 * Usage: DATABASE_URL=postgres://... node tools/migrate.mjs [--dry-run]
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Pool } = require(require.resolve("pg", { paths: ["lib/db"] }));

const dryRun = process.argv.includes("--dry-run") || process.argv.includes("--check");

/**
 * `--check`: say what is pending, change nothing, and **fail** if anything is.
 *
 * `--dry-run` prints and exits 0, which is right for a person looking. It is
 * exactly wrong for a machine: a workflow that runs it and reads the exit code
 * is told everything is fine while five migrations are missing.
 *
 * That is not hypothetical. On 2 September production sat at 0037 while `main`
 * needed 0042, and a commit had added `projects.last_opened_at` to the Drizzle
 * schema — which Drizzle writes into the column list of every `select()`, so
 * every project read in the product answered 500. Nothing failed loudly: Vercel
 * reported zero errors for twenty-four hours, because nobody opened the app.
 *
 * Nothing in this repository could have caught that. CI migrates an ephemeral
 * database and passes; the deploy never looks at production. This flag is what
 * a scheduled job runs so that "the code needs a migration nobody applied"
 * becomes a red build instead of a discovery.
 */
const checkOnly = process.argv.includes("--check");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is not set. Nothing to migrate against.");
  process.exit(1);
}

const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(DATABASE_URL);
const pool = new Pool({
  connectionString: DATABASE_URL,
  ...(isLocal ? {} : { ssl: { rejectUnauthorized: false } }),
  max: 1,
});

const dir = path.join(process.cwd(), "lib/db/migrations");
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

const client = await pool.connect();
try {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )`);

  const applied = new Set(
    (await client.query("SELECT filename FROM schema_migrations")).rows.map((r) => r.filename),
  );

  // Migrations 0000–0005 were applied by hand — or, for the base tables, by
  // `drizzle-kit push` — before this runner existed, so on a database that
  // already carries them the bookkeeping table starts empty and this would try
  // to run them again. Adopting anything already reflected in the schema is the
  // one-off cost of introducing a ledger to a live database, and it is decided
  // by looking at the schema rather than assumed from a file's number.
  if (applied.size === 0) {
    const { rows } = await client.query(`
      SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'projects' AND column_name = 'video_path'`);
    if (rows[0].n > 0) {
      const adopted = files.filter((f) => /^000[0-5]_/.test(f));
      if (!dryRun) {
        for (const filename of adopted) {
          await client.query(
            "INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING",
            [filename],
          );
        }
      }
      for (const filename of adopted) applied.add(filename);
      console.log(`adopted ${adopted.length} migration(s) already present in this database`);
    }
  }

  const pending = files.filter((f) => !applied.has(f));
  if (pending.length === 0) {
    console.log(`up to date — ${files.length} migration(s), none pending`);
  }

  if (checkOnly) {
    for (const filename of pending) console.log(`would apply ${filename}`);
    if (pending.length > 0) {
      console.error(
        `\nthis database is ${pending.length} migration(s) behind the repository.\n` +
          `The deployed code expects them. Apply with: node tools/migrate.mjs`,
      );
      client.release();
      await pool.end();
      process.exit(1);
    }
    client.release();
    await pool.end();
    process.exit(0);
  }

  for (const filename of pending) {
    if (dryRun) {
      console.log(`would apply ${filename}`);
      continue;
    }
    const sql = readFileSync(path.join(dir, filename), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      // ON CONFLICT DO NOTHING, because a migration that recorded itself must
      // not be able to stop the whole run.
      //
      // 0018 ended with its own `INSERT INTO schema_migrations` — written while
      // applying it to production by hand, where that line was the bookkeeping.
      // In the file it meant the row already existed by the time this insert
      // ran, the primary key was violated, the transaction rolled back, and CI
      // died before a single test executed. What is applied is decided by the
      // set read above, not by whether this insert had anything to do.
      await client.query(
        "INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING",
        [filename],
      );
      await client.query("COMMIT");
      console.log(`applied ${filename}`);
    } catch (error) {
      await client.query("ROLLBACK");
      console.error(`\n${filename} failed and was rolled back:\n  ${error.message}`);
      console.error("Nothing after it was attempted.");
      process.exitCode = 1;
      break;
    }
  }
} finally {
  client.release();
  await pool.end();
}
