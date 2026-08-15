/**
 * Can the database this code needs be built from the files in the repository,
 * and does anything notice when it has not been?
 *
 * On 12 August the production database was five migrations behind and had been
 * for two days. The files were written, reviewed and committed. Applying them
 * was something a person had to remember to do by hand, and nobody had. Every
 * query in the product named a column that did not exist and failed; the
 * symptom the customer saw was an empty project list and a Create button that
 * did nothing, with no error anywhere. `/healthz` said ok throughout, because
 * it returned a constant.
 *
 * Two things had to become checkable, and this file checks both.
 *
 * The first is that the migrations *are* the schema — that running them, in
 * order, against an empty database produces exactly the columns the code
 * declares. Not a document that describes the schema: the actual files, run for
 * real, against a real Postgres, compared column by column with what Drizzle
 * says the queries will ask for.
 *
 * The second is that a database which is behind says so. The health check reads
 * its expectations out of the Drizzle tables rather than from a list somebody
 * maintains, because a hand-maintained list of columns is the same forgetting
 * one layer up.
 *
 * Usage: DATABASE_URL=postgres://... node tools/schema-test.mjs
 * Requires: a local Postgres you may create and drop databases on.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Pool } = require(require.resolve("pg", { paths: ["lib/db"] }));

const repoRoot = process.cwd();
const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://postgres@127.0.0.1:5433/editly_test";
const SCRATCH = "editly_schema_check";
const scratchUrl = DATABASE_URL.replace(/\/[^/?]+(\?|$)/, `/${SCRATCH}$1`);

let checks = 0;
let failures = 0;
const check = (name, ok, detail = "") => {
  checks += 1;
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
};
const section = (title) => console.log(`\n${title}`);

// ─── The health module, as the server runs it ────────────────────────────────

const buildDir = await mkdtemp(path.join(tmpdir(), "editly-schema-"));
// Inside the package rather than in the temp directory: `@workspace/db` is a
// workspace name, and workspace names resolve from the importing file.
const entryDir = path.join(repoRoot, "artifacts/api-server/.schema-test");
const entry = path.join(entryDir, "entry.ts");
await (await import("node:fs/promises")).mkdir(entryDir, { recursive: true });
await writeFile(
  entry,
  `export * from "../src/lib/schema-health";
   export { pool } from "@workspace/db";`,
);
// The bundle leaves `pg` external, so it has to sit somewhere `require("pg")`
// resolves from at runtime — which is lib/db, the package that depends on it.
const outfile = path.join(repoRoot, "lib/db/.schema-health-under-test.mjs");
const built = spawnSync(
  require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/api-server"] }),
  [
    entry,
    "--bundle", "--platform=node", "--format=esm", "--target=node22",
    "--external:pg", `--outfile=${outfile}`, "--log-level=error",
  ],
  { stdio: "inherit", cwd: path.join(repoRoot, "artifacts/api-server") },
);
if (built.status !== 0) {
  console.error("could not bundle the health module");
  process.exit(1);
}
const health = await import(pathToFileURL(outfile).href);

// ─── What the code says it needs ─────────────────────────────────────────────

section("The expected columns are read from the schema, not from a list");
{
  const expected = health.expectedColumns();
  check("all five tables are covered", expected.size === 5, JSON.stringify([...expected.keys()]));
  check(
    "and the columns are the ones the queries name",
    expected.get("jobs")?.has("output_seconds") &&
      expected.get("jobs")?.has("priority") &&
      expected.get("projects")?.has("reference_video_path"),
    JSON.stringify([...(expected.get("jobs") ?? [])]),
  );
  // If this ever has to be edited by hand to stay correct, it has stopped being
  // a check and become a second thing to forget.
  const source = (await import("node:fs")).readFileSync(
    path.join(repoRoot, "artifacts/api-server/src/lib/schema-health.ts"),
    "utf8",
  );
  check("nothing in it is a literal column name", !/"[a-z]+_[a-z_]+"/.test(source.split("BEHIND_MESSAGE")[0]));
  check("it reads them out of the Drizzle tables", /getTableConfig/.test(source));
}

section("A database that is behind is reported by name");
{
  const expected = new Map([
    ["jobs", new Set(["id", "output_seconds", "priority"])],
    ["projects", new Set(["id", "reference_video_path"])],
  ]);

  const complete = health.compareSchema(
    expected,
    new Map([
      ["jobs", new Set(["id", "output_seconds", "priority"])],
      ["projects", new Set(["id", "reference_video_path"])],
    ]),
  );
  check("a database that has everything reports nothing", complete.length === 0, JSON.stringify(complete));

  // Exactly the state production was in.
  const behind = health.compareSchema(
    expected,
    new Map([
      ["jobs", new Set(["id"])],
      ["projects", new Set(["id"])],
    ]),
  );
  check(
    "a database missing three columns names all three",
    JSON.stringify(behind) ===
      JSON.stringify(["jobs.output_seconds", "jobs.priority", "projects.reference_video_path"]),
    JSON.stringify(behind),
  );
  check("qualified by table, because a bare column name is ambiguous", behind.every((c) => c.includes(".")));

  const noTable = health.compareSchema(expected, new Map([["projects", new Set(["id", "reference_video_path"])]]));
  check(
    "a table that does not exist at all is reported as its columns",
    noTable.length === 3 && noTable.every((c) => c.startsWith("jobs.")),
    JSON.stringify(noTable),
  );

  // Deploying a migration before the code that uses it is the safe order, and
  // failing on it would make the safe order the failing one.
  const ahead = health.compareSchema(
    expected,
    new Map([
      ["jobs", new Set(["id", "output_seconds", "priority", "something_new"])],
      ["projects", new Set(["id", "reference_video_path"])],
    ]),
  );
  check("a column the database has and the code does not read is not a failure", ahead.length === 0, JSON.stringify(ahead));
}

// ─── Building the schema from the files ──────────────────────────────────────

/**
 * The parts of Supabase the migrations lean on, read from the same file CI
 * applies. A copy here and a copy there is how the two drift apart, and the
 * drift would present as "the migrations do not run" on whichever one nobody
 * looked at recently.
 */
const SUPABASE_SHIM = readFileSync(path.join(repoRoot, "lib/db/testing/supabase-shim.sql"), "utf8");

/**
 * Every pool here gets an error handler, and it is not defensive clutter.
 *
 * This file drops and recreates a database repeatedly. `DROP DATABASE … WITH
 * (FORCE)` terminates whatever is still attached to it, and a node-postgres
 * pool holding an *idle* connection to that database learns about it as a pool
 * error rather than as a failed query — which, unhandled, takes the process
 * down with a stack pointing at the protocol parser and no clue which section
 * caused it. It passed here and on one CI run before failing on the next, which
 * is the worst kind of suite: one people learn to re-run.
 */
const attach = (pool) => {
  pool.on("error", () => {});
  return pool;
};

const admin = attach(new Pool({ connectionString: DATABASE_URL, max: 1 }));

const recreateScratch = async () => {
  // Ask everything attached to leave before forcing it out, so the drop is not
  // racing anybody, and retry once or twice because a backend takes a moment to
  // actually go.
  await admin
    .query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [SCRATCH],
    )
    .catch(() => {});

  for (let attempt = 0; ; attempt += 1) {
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
      break;
    } catch (error) {
      if (attempt >= 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  await admin.query(`CREATE DATABASE ${SCRATCH}`);
  const scratch = attach(new Pool({ connectionString: scratchUrl, max: 1 }));
  await scratch.query(SUPABASE_SHIM);
  await scratch.end();
};

const runMigrations = (url, args = []) =>
  spawnSync("node", [path.join(repoRoot, "tools/migrate.mjs"), ...args], {
    encoding: "utf8",
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: url },
  });

const columnsOf = async (url) => {
  const pool = attach(new Pool({ connectionString: url, max: 1 }));
  const { rows } = await pool.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [["projects", "messages", "exports", "jobs", "subscriptions"]],
  );
  await pool.end();
  const found = new Map();
  for (const row of rows) {
    const set = found.get(row.table_name) ?? new Set();
    set.add(row.column_name);
    found.set(row.table_name, set);
  }
  return found;
};

section("The migrations in the repository build the schema the code expects");
{
  await recreateScratch();
  const run = runMigrations(scratchUrl);

  check("every migration applied cleanly", run.status === 0, (run.stderr || run.stdout || "").slice(0, 300));

  const files = readdirSync(path.join(repoRoot, "lib/db/migrations")).filter((f) => f.endsWith(".sql"));
  const appliedLines = (run.stdout || "").split("\n").filter((l) => l.startsWith("applied "));
  check(
    "all of them ran, not just the ones somebody remembered",
    appliedLines.length === files.length,
    `${appliedLines.length} of ${files.length}`,
  );

  const actual = await columnsOf(scratchUrl);
  const missing = health.compareSchema(health.expectedColumns(), actual);
  check(
    "and the result has every column the code reads",
    missing.length === 0,
    missing.join(", "),
  );

  // The other direction: a column the migrations create that the code has
  // forgotten about is dead weight, and usually means a rename went half-done.
  const expected = health.expectedColumns();
  const orphans = [];
  for (const [table, columns] of actual) {
    for (const column of columns) {
      if (!expected.get(table)?.has(column)) orphans.push(`${table}.${column}`);
    }
  }
  check("and nothing the code has never heard of", orphans.length === 0, orphans.join(", "));
}

/**
 * Runs the real `checkSchema` in a child process, because it binds its
 * connection when the module loads and the point is to point it at a database
 * we control.
 */
const askHealth = (url) => {
  const probe = spawnSync(
    "node",
    ["--input-type=module", "-e",
     `const m = await import(${JSON.stringify(pathToFileURL(outfile).href)});
      console.log(JSON.stringify(await m.checkSchema()));
      await m.pool.end();`],
    { encoding: "utf8", cwd: repoRoot, env: { ...process.env, DATABASE_URL: url } },
  );
  try {
    return JSON.parse((probe.stdout || "").trim().split("\n").pop());
  } catch {
    return { parseFailed: true, stdout: probe.stdout, stderr: (probe.stderr || "").slice(0, 300) };
  }
};

section("The health check, against a real database rather than a fixture");
{
  // The pure comparison above passed for a version of this that could not run
  // the query at all: handed a JavaScript array, Drizzle expands it into a
  // tuple and `= ANY((…))` is not valid SQL, so a perfectly healthy database
  // was reported as unreachable. A health check that names the wrong failure
  // sends whoever is on call to the wrong place — so it is asked for real.
  const healthy = askHealth(scratchUrl);
  check("a fully migrated database is reachable", healthy.reachable === true, JSON.stringify(healthy));
  check("and reports nothing missing", healthy.missingColumns?.length === 0, JSON.stringify(healthy));
  check("with no error to explain", healthy.error === undefined, String(healthy.error));
}

section("A database in the state production was actually in");
{
  // Not a fixture: an empty Postgres carrying only the migrations that had been
  // applied on 12 August, which is 0000 through 0005.
  await recreateScratch();
  const pool = attach(new Pool({ connectionString: scratchUrl, max: 1 }));
  const fs = await import("node:fs");
  const early = readdirSync(path.join(repoRoot, "lib/db/migrations"))
    .filter((f) => /^000[0-5]_/.test(f))
    .sort();
  for (const file of early) {
    await pool.query(fs.readFileSync(path.join(repoRoot, "lib/db/migrations", file), "utf8"));
  }
  await pool.end();

  const behind = askHealth(scratchUrl);
  check("it is reachable, which is the point — nothing was down", behind.reachable === true, JSON.stringify(behind));
  check("but it is reported as behind", behind.missingColumns?.length > 0, JSON.stringify(behind));
  check(
    "naming the column whose absence emptied the project list",
    behind.missingColumns?.includes("projects.reference_video_path"),
    JSON.stringify(behind.missingColumns),
  );
  check(
    "and the one that broke every subscription request",
    behind.missingColumns?.includes("jobs.output_seconds"),
    JSON.stringify(behind.missingColumns),
  );
  check(
    "and every other column the five unapplied migrations were going to add",
    JSON.stringify(behind.missingColumns) ===
      JSON.stringify([
        "jobs.max_source_seconds",
        "jobs.notes",
        "jobs.output_seconds",
        "jobs.output_seconds_source",
        "jobs.priority",
        "jobs.reference_path",
        "jobs.source_seconds",
        "projects.reference_video_path",
      ]),
    JSON.stringify(behind.missingColumns),
  );
  check(
    "eight names, which is the whole outage in one line",
    behind.missingColumns?.length === 8,
    String(behind.missingColumns?.length),
  );

  // And running the migrations fixes it, which is the sentence the health
  // message tells you to act on.
  runMigrations(scratchUrl);
  const after = askHealth(scratchUrl);
  check("running the migrations clears it", after.missingColumns?.length === 0, JSON.stringify(after.missingColumns));
}

section("The rules the schema itself enforces");
{
  // Columns are not the whole schema, and this is what that cost.
  //
  // `jobs.project_id` carried ON DELETE CASCADE, so deleting a project deleted
  // the jobs that record how many minutes it produced — undoing, in the
  // database, the exact rule routes/projects.ts and account-deletion.ts take
  // care to state in code and isolation-test.mjs asserts. Delete your projects,
  // reset your allowance, render for nothing.
  //
  // It survived because the test database was built by `drizzle-kit push` from
  // a Drizzle schema that declares no foreign keys, while production was built
  // from the SQL in this directory, which declares four. A check comparing
  // columns alone cannot see a constraint.
  await recreateScratch();
  runMigrations(scratchUrl);
  const pool = attach(new Pool({ connectionString: scratchUrl, max: 1 }));

  const { rows: keys } = await pool.query(`
    SELECT conrelid::regclass::text AS child, conname, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
     WHERE contype = 'f' AND connamespace = 'public'::regnamespace
     ORDER BY 1, 2`);

  const onJobs = keys.filter((k) => k.child === "jobs");
  check(
    "nothing cascades onto jobs, because a render that happened stays counted",
    onJobs.length === 0,
    JSON.stringify(onJobs),
  );

  const byName = Object.fromEntries(keys.map((k) => [k.conname, k.definition]));
  check(
    "a project's messages go with it",
    /REFERENCES projects\(id\) ON DELETE CASCADE/.test(byName["messages_project_fk"] ?? ""),
    byName["messages_project_fk"],
  );
  check(
    "and its exports",
    /REFERENCES projects\(id\) ON DELETE CASCADE/.test(byName["exports_project_fk"] ?? ""),
    byName["exports_project_fk"],
  );
  check(
    "an export whose job is gone loses the reference rather than itself",
    /REFERENCES jobs\(id\) ON DELETE SET NULL/.test(byName["exports_job_id_fkey"] ?? ""),
    byName["exports_job_id_fkey"],
  );
  check(
    "and there are no others nobody has reasoned about",
    keys.length === 3,
    JSON.stringify(keys.map((k) => k.conname)),
  );

  // Proved rather than asserted: delete a project that produced minutes and
  // read the meter's own query back.
  await pool.query(`
    INSERT INTO projects (id, user_id, title) VALUES ('p-cascade', '11111111-1111-4111-8111-111111111111', 'x');
    INSERT INTO jobs (id, user_id, project_id, status, plan, input_path, output_seconds, finished_at)
    VALUES ('j-cascade', '11111111-1111-4111-8111-111111111111', 'p-cascade', 'done',
            '{"version":1,"operations":[]}'::jsonb, 'x/y/source.mp4', 120, now());
    INSERT INTO messages (id, user_id, project_id, role, content)
    VALUES ('m-cascade', '11111111-1111-4111-8111-111111111111', 'p-cascade', 'user', 'hi');`);
  await pool.query("DELETE FROM projects WHERE id = 'p-cascade'");

  const after = await pool.query(`
    SELECT (SELECT coalesce(sum(output_seconds), 0) FROM jobs WHERE id = 'j-cascade') AS seconds,
           (SELECT count(*)::int FROM messages WHERE id = 'm-cascade') AS messages`);
  check(
    "deleting a project does not refund the minutes it produced",
    Number(after.rows[0].seconds) === 120,
    JSON.stringify(after.rows[0]),
  );
  check("but it does take the conversation with it", after.rows[0].messages === 0, JSON.stringify(after.rows[0]));

  // Every foreign key needs an index on the child side or each parent delete
  // sequentially scans the child table. Invisible at three projects; discovered
  // by a customer at thirty thousand.
  const { rows: indexes } = await pool.query(
    "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public'",
  );
  for (const [table, column] of [["messages", "project_id"], ["exports", "project_id"], ["exports", "job_id"]]) {
    check(
      `${table}.${column} is indexed, so the cascade is not a table scan`,
      indexes.some((i) => new RegExp(`ON public\\.${table} USING btree \\(${column}\\)`).test(i.indexdef)),
      column,
    );
  }
  await pool.end();
}

section("Running it twice does nothing the second time");
{
  const again = runMigrations(scratchUrl);
  check("it exits cleanly", again.status === 0, (again.stderr || "").slice(0, 200));
  check("and applies nothing", !/^applied /m.test(again.stdout || ""), (again.stdout || "").trim());
  check("saying so out loud rather than silently", /up to date/.test(again.stdout || ""), (again.stdout || "").trim());
}

section("A migration that fails leaves the database as it was");
{
  await recreateScratch();
  const pool = attach(new Pool({ connectionString: scratchUrl, max: 1 }));

  // Half of a migration succeeds, then it hits something that cannot work.
  // Without a transaction per file the table would survive, the ledger would
  // not record the file, and the next run would fail differently — which is the
  // state that is hardest to diagnose, because the file looks like it never ran.
  const bad = path.join(repoRoot, "lib/db/migrations/9999_deliberately_broken.sql");
  const fs = await import("node:fs/promises");
  await fs.writeFile(
    bad,
    "CREATE TABLE half_done (id text);\nALTER TABLE table_that_is_not_here ADD COLUMN x text;\n",
  );

  const run = runMigrations(scratchUrl);
  await fs.rm(bad, { force: true });

  check("it exits non-zero", run.status !== 0, String(run.status));
  check("and says which file", /9999_deliberately_broken/.test(run.stderr || ""), (run.stderr || "").slice(0, 200));
  check("and that nothing after it was tried", /Nothing after it was attempted/.test(run.stderr || ""));

  const { rows } = await pool.query(
    "SELECT to_regclass('public.half_done') IS NOT NULL AS survived",
  );
  check("the half that succeeded is rolled back", rows[0].survived === false, JSON.stringify(rows[0]));

  const ledger = await pool.query("SELECT filename FROM schema_migrations WHERE filename LIKE '9999%'");
  check("and the failed file is not recorded as applied", ledger.rowCount === 0);

  // Everything before it is applied and stays applied, which is what makes a
  // failure resumable rather than a restart.
  const done = await pool.query("SELECT count(*)::int AS n FROM schema_migrations");
  check("the migrations before it are kept", done.rows[0].n >= 10, String(done.rows[0].n));
  await pool.end();
}

section("A database migrated by hand before the ledger existed is adopted, not re-run");
{
  await recreateScratch();
  // Stand in for production on 12 August: 0001–0005 applied by hand, no ledger.
  const pool = attach(new Pool({ connectionString: scratchUrl, max: 1 }));
  const files = readdirSync(path.join(repoRoot, "lib/db/migrations")).filter((f) => /^000[0-5]_/.test(f));
  const fs = await import("node:fs");
  for (const file of files.sort()) {
    await pool.query(fs.readFileSync(path.join(repoRoot, "lib/db/migrations", file), "utf8"));
  }

  const run = runMigrations(scratchUrl);
  check("it succeeds", run.status === 0, (run.stderr || "").slice(0, 300));
  check(
    `it notices the ${files.length} already there`,
    new RegExp(`adopted ${files.length} migration`).test(run.stdout || ""),
    (run.stdout || "").trim(),
  );
  // Counted rather than written down: a literal here has to be edited every
  // time a migration is added, which is a claim that goes stale by default.
  const total = readdirSync(path.join(repoRoot, "lib/db/migrations")).filter((f) => f.endsWith(".sql")).length;
  check(
    "and applies only what is genuinely missing",
    (run.stdout.match(/^applied /gm) ?? []).length === total - files.length,
    (run.stdout || "").trim(),
  );

  const actual = await columnsOf(scratchUrl);
  check(
    "leaving a schema the code can run against",
    health.compareSchema(health.expectedColumns(), actual).length === 0,
    health.compareSchema(health.expectedColumns(), actual).join(", "),
  );
  await pool.end();
}

section("A dry run says what it would do and does none of it");
{
  await recreateScratch();
  const run = runMigrations(scratchUrl, ["--dry-run"]);
  const all = readdirSync(path.join(repoRoot, "lib/db/migrations")).filter((f) => f.endsWith(".sql")).length;
  check("it lists every pending file", (run.stdout.match(/^would apply /gm) ?? []).length === all, (run.stdout || "").trim());
  check("and applies nothing", !/^applied /m.test(run.stdout || ""));

  const actual = await columnsOf(scratchUrl);
  check("the database is untouched", actual.size === 0, JSON.stringify([...actual.keys()]));
}

await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
await admin.end();
await health.pool.end();
await rm(buildDir, { recursive: true, force: true });
await rm(entryDir, { recursive: true, force: true });
await rm(outfile, { force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("The schema is what the files say it is, and a database that is behind says so.");
