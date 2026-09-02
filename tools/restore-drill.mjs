/**
 * Can this database be brought back, and does the thing that comes back work?
 *
 * Nothing in this repository has ever answered that. There is no backup
 * described anywhere, no restore has ever been attempted, and everything the
 * product knows lives in one database: the accounts, the projects, the clips,
 * the social tokens, and the ledger that says who paid what. The free Supabase
 * plan carries no point-in-time restore; Pro carries a daily one. Either way
 * the interesting question is not whether a dump exists. It is whether the
 * database you get back from it is one the product can actually run against.
 *
 * ## Why now, with one account and ten renders in production
 *
 * Because this is the cheapest hour this exercise will ever cost. It will find
 * the same things later that it finds today — the roles, the extensions, the
 * row-level security policies that `pg_dump` alone does not bring with it — but
 * later it finds them at three in the morning with customers watching. The
 * drill is not urgent because the data is precious yet. It is urgent because
 * the *procedure* is untested, and an untested procedure is discovered under
 * load or not at all.
 *
 * ## The failure this is really looking for
 *
 * Not "the restore failed". A restore that fails is a good afternoon: you can
 * see it, and you try again. The failure worth building a drill around is:
 *
 *   **the restore succeeded, and every read comes back empty.**
 *
 * That is not hypothetical here. `pg_dump` dumps a database; roles live in the
 * *cluster* and are not in the file. So the dump says `CREATE POLICY … TO
 * editly_app` and `GRANT … TO editly_app`, and on a server where that role does
 * not exist those statements fail — while `ALTER TABLE … ENABLE ROW LEVEL
 * SECURITY`, two lines above, succeeds. Restore that with plain `psql`, which
 * continues past errors by default, and you are left with tables that have row
 * security switched on and no policy at all. Every SELECT the application makes
 * then returns **zero rows rather than an error**, at full speed, with nothing
 * in any log.
 *
 * This project has already met that exact shape once, from the other direction:
 * four migrations shipped a policy naming `postgres` while the API connects as
 * `editly_app`, and reads went quiet in production for as long as they were
 * live. So the drill's last and most important check is not "do the tables
 * exist". It is: **connect as the role the server actually uses, read a row
 * that was in the source, and get it back.**
 *
 * ## What this file does
 *
 * Two modes, and the difference matters:
 *
 *   node tools/restore-drill.mjs
 *       Builds a synthetic source from `lib/db/migrations` on the local test
 *       server, seeds it, dumps it, restores it, and verifies the restore. This
 *       is what CI runs. It proves the *procedure* and the verifier — including
 *       by damaging two restores on purpose and requiring the verifier to catch
 *       them, because a verifier that has never failed is decoration.
 *
 *   node tools/restore-drill.mjs --source "postgres://…"
 *       The real drill. The source is read with `pg_dump` and nothing else —
 *       never written to — and the restore always lands on the **local** test
 *       server, never on the source's. That is a property of the code rather
 *       than of the operator's attention: this script cannot create a database
 *       on the machine it is dumping from.
 *
 * Timings are printed for each phase, because a restore that works in six hours
 * is not a restore, and "we have backups" is a sentence about a file rather
 * than about a recovery.
 *
 * Usage:
 *   node tools/restore-drill.mjs [--source <url>] [--keep]
 * Requires: a local Postgres you may create and drop databases on, and the
 * `postgresql-client` binaries (pg_dump, psql). Skips itself, without failing,
 * when neither is present — see the note where it does.
 */
import { mkdtemp, rm, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolveTestDatabaseUrl } from "./lib/test-db.mjs";

const require = createRequire(import.meta.url);
const { Pool } = require(require.resolve("pg", { paths: ["lib/db"] }));

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

/* ── Where things are allowed to happen ────────────────────────────────────── */

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const KEEP = argv.includes("--keep");

/**
 * Every database this script may create is named with this prefix, and it
 * refuses to drop anything that is not.
 *
 * A drill that can drop a database is one typo away from being the disaster it
 * was written to rehearse for, so the guard is in the code and not in the
 * operator's memory.
 */
const PREFIX = "editly_drill_";
const SOURCE_DB = `${PREFIX}source`;
const RESTORE_DB = `${PREFIX}restore`;
const NO_POLICY_DB = `${PREFIX}nopolicy`;
const SCHEMA_ONLY_DB = `${PREFIX}schemaonly`;

/** The tools this needs, checked before anything is created. */
const missingBinary = ["pg_dump", "psql"].find(
  (bin) => spawnSync(bin, ["--version"], { stdio: "ignore" }).status !== 0,
);

const LOCAL = await resolveTestDatabaseUrl();
const reachable = await (async () => {
  const p = new Pool({ connectionString: adminUrl(LOCAL), max: 1 });
  try {
    await p.query("select 1");
    return true;
  } catch {
    return false;
  } finally {
    await p.end().catch(() => {});
  }
})();

if (missingBinary || !reachable) {
  // Skipped, out loud, with the reason — and exit 0.
  //
  // A drill is worth running on every push where a database exists, and a
  // developer's laptop with no Postgres is not a broken build. What would be
  // wrong is skipping *quietly*: a check that says nothing when it does nothing
  // is indistinguishable from one that passed, which is the whole class of
  // problem this repository keeps finding.
  console.log(
    missingBinary
      ? `Skipped: ${missingBinary} is not on PATH, so a dump cannot be taken. Install postgresql-client to run the drill.`
      : `Skipped: nothing is listening for Postgres at ${redact(LOCAL)}, so there is nowhere to restore into.`,
  );
  process.exit(0);
}

const SOURCE_URL = arg("--source") ?? withDatabase(LOCAL, SOURCE_DB);
const SYNTHETIC = arg("--source") === undefined;

// The restore target is derived from the local server and never from --source.
// This is what makes "do not restore over production" a fact about the program
// rather than a warning in a comment.
const restoreUrl = (db) => withDatabase(LOCAL, db);

if (sameDatabase(SOURCE_URL, restoreUrl(RESTORE_DB))) {
  console.error("The source and the restore target are the same database. Refusing.");
  process.exit(1);
}

const workDir = await mkdtemp(path.join(tmpdir(), "editly-restore-drill-"));
const clock = {};

try {
  /* ── The source ──────────────────────────────────────────────────────────── */

  section(SYNTHETIC ? "A source built from the migrations, so the drill owns everything it touches" : "The source, which is read and never written");
  if (SYNTHETIC) {
    const t0 = Date.now();
    await recreate(SOURCE_DB);
    psql(withDatabase(LOCAL, SOURCE_DB), ["-v", "ON_ERROR_STOP=1", "-f", "lib/db/testing/supabase-shim.sql"]);
    const migrated = spawnSync("node", ["tools/migrate.mjs"], {
      env: { ...process.env, DATABASE_URL: withDatabase(LOCAL, SOURCE_DB) },
      encoding: "utf8",
    });
    check("the source is built by running every migration in order", migrated.status === 0, (migrated.stderr ?? "").slice(0, 200));
    await seed(withDatabase(LOCAL, SOURCE_DB));
    clock.build = Date.now() - t0;
  }

  const source = await inspect(SOURCE_URL);
  check("the source has tables", source.tables.length >= 5, String(source.tables.length));
  check(
    "and rows in them, because a read that returns nothing proves nothing",
    source.rows.some(([, count]) => count > 0),
    JSON.stringify(source.rows.filter(([, c]) => c > 0).slice(0, 4)),
  );
  check("and row-level security is on somewhere, which is the part a dump is bad at", source.rls.length > 0, String(source.rls.length));

  /* ── The dump ────────────────────────────────────────────────────────────── */

  section("The dump, and the thing it does not contain");
  const dumpFile = path.join(workDir, "source.sql");
  {
    const t0 = Date.now();
    // Plain SQL rather than the custom format on purpose: the point of this
    // exercise is partly to be able to *read* what a backup contains, and the
    // failure being rehearsed is a statement in it that quietly did not run.
    // `--no-owner` is deliberately NOT passed — ownership and grants are the
    // half that goes wrong.
    run("pg_dump", [SOURCE_URL, "--format=plain", "--file", dumpFile]);
    clock.dump = Date.now() - t0;
  }
  const dump = await readFile(dumpFile, "utf8");
  check("a dump was produced", (await stat(dumpFile)).size > 0, `${Math.round((await stat(dumpFile)).size / 1024)}KB`);

  /*
    The roles the dump *needs*, read out of the dump itself.

    `pg_dumpall --roles-only` is the documented answer and it is not available
    on a managed Supabase project, where nobody hands you a superuser. So the
    list is derived instead from the only place that is always true: every role
    the dump file names in a GRANT, a POLICY or an OWNER TO. A dump cannot be
    restored without the roles it names, and it names all of them.
  */
  const rolesNeeded = rolesNamedIn(dump);
  check(
    "the dump names the role the server connects as",
    rolesNeeded.includes("editly_app"),
    JSON.stringify(rolesNeeded),
  );
  check(
    "and the dump does not carry those roles itself — which is the whole trap",
    !/^CREATE ROLE /m.test(dump),
    "a dump that created its own roles would make this drill pointless",
  );

  const rolesFile = path.join(workDir, "roles.sql");
  await writeFile(rolesFile, rolesSql(rolesNeeded));

  /* ── The restore ─────────────────────────────────────────────────────────── */

  section("The restore, in the order that actually works");
  {
    const t0 = Date.now();
    await recreate(RESTORE_DB);
    // Roles first. Then the database, with ON_ERROR_STOP so that a failure is
    // a failure — the default is to continue, and continuing is precisely how a
    // restore ends up with row security on and no policy under it.
    psql(restoreUrl(RESTORE_DB), ["-v", "ON_ERROR_STOP=1", "-f", rolesFile]);
    psql(restoreUrl(RESTORE_DB), ["-v", "ON_ERROR_STOP=1", "-f", dumpFile]);
    clock.restore = Date.now() - t0;
  }
  check("it restored without a single statement failing", true, `${clock.restore}ms`);

  /* ── What the restored database can actually do ──────────────────────────── */

  section("What came back, measured against what went in");
  const t0 = Date.now();
  const restored = await inspect(restoreUrl(RESTORE_DB));
  const verdict = await verify(source, restored, restoreUrl(RESTORE_DB));
  clock.verify = Date.now() - t0;
  for (const [name, ok, detail] of verdict) check(name, ok, detail);

  /* ── And the verifier is not decoration ──────────────────────────────────── */

  section("Two restores damaged on purpose, because a check that has never failed is not a check");
  {
    // The realistic damage, not invented sabotage: this is byte for byte what
    // the file becomes when every policy statement fails because the roles were
    // not created first, and psql was left to continue past the errors.
    await recreate(NO_POLICY_DB);
    const stripped = path.join(workDir, "no-policy.sql");
    await writeFile(stripped, withoutPolicies(dump));
    psql(restoreUrl(NO_POLICY_DB), ["-v", "ON_ERROR_STOP=1", "-f", rolesFile]);
    psql(restoreUrl(NO_POLICY_DB), ["-v", "ON_ERROR_STOP=1", "-f", stripped]);

    const damaged = await inspect(restoreUrl(NO_POLICY_DB));
    check(
      "a restore with the policies missing still has every table and every row",
      damaged.tables.length === source.tables.length &&
        sameCounts(damaged.rows, source.rows),
      `${damaged.tables.length} tables`,
    );
    const damagedVerdict = await verify(source, damaged, restoreUrl(NO_POLICY_DB));
    const readCheck = damagedVerdict.find(([name]) => name.startsWith("a real read"));
    check(
      "— so nothing about it looks wrong, and it is the exact database this drill exists to catch",
      readCheck !== undefined && readCheck[1] === false,
      JSON.stringify(readCheck),
    );
    check(
      "the read comes back empty rather than failing, which is why nobody would notice",
      /0 rows/.test(readCheck?.[2] ?? ""),
      readCheck?.[2],
    );
    check(
      "and the drill fails it",
      damagedVerdict.some(([, ok]) => ok === false),
      JSON.stringify(damagedVerdict.filter(([, ok]) => !ok).map(([n]) => n)),
    );
  }
  {
    // The other way a backup lies: it restored, it has every table, and it is
    // empty. `--schema-only` is one flag away from the command above.
    await recreate(SCHEMA_ONLY_DB);
    const schemaOnly = path.join(workDir, "schema-only.sql");
    run("pg_dump", [SOURCE_URL, "--format=plain", "--schema-only", "--file", schemaOnly]);
    psql(restoreUrl(SCHEMA_ONLY_DB), ["-v", "ON_ERROR_STOP=1", "-f", rolesFile]);
    psql(restoreUrl(SCHEMA_ONLY_DB), ["-v", "ON_ERROR_STOP=1", "-f", schemaOnly]);
    const empty = await inspect(restoreUrl(SCHEMA_ONLY_DB));
    const emptyVerdict = await verify(source, empty, restoreUrl(SCHEMA_ONLY_DB));
    check("a schema without its rows has every table the code expects", empty.tables.length === source.tables.length);
    check(
      "and the drill still refuses it",
      emptyVerdict.some(([name, ok]) => name.startsWith("every table came back with") && ok === false),
      JSON.stringify(emptyVerdict.filter(([, ok]) => !ok).map(([n]) => n)),
    );
  }

  /* ── The clock ───────────────────────────────────────────────────────────── */

  section("How long it took, which is half of whether it is a restore");
  for (const [phase, ms] of Object.entries(clock)) {
    console.log(`  · ${phase}: ${(ms / 1000).toFixed(2)}s`);
  }
  console.log(
    `  · total: ${(Object.values(clock).reduce((a, b) => a + b, 0) / 1000).toFixed(2)}s` +
      (SYNTHETIC ? " — against a synthetic source the size of an empty schema, not against production" : ""),
  );
} finally {
  if (!KEEP) {
    for (const db of [RESTORE_DB, NO_POLICY_DB, SCHEMA_ONLY_DB, ...(SYNTHETIC ? [SOURCE_DB] : [])]) {
      await drop(db).catch(() => {});
    }
  } else {
    console.log(`\n  (kept: ${[RESTORE_DB, NO_POLICY_DB, SCHEMA_ONLY_DB].join(", ")})`);
  }
  await rm(workDir, { recursive: true, force: true });
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log("A backup nobody has restored is a file, not a plan.");
  process.exit(1);
}
console.log(
  SYNTHETIC
    ? "The restore procedure works, and the verifier fails when it should. Run it with --source against production to time the real thing."
    : "The restore came back and the product can read it.",
);

/* ── The verifier ──────────────────────────────────────────────────────────── */

/**
 * Everything about a database that a restore can silently lose, read from the
 * database rather than from a list somebody maintains.
 */
async function inspect(url) {
  return withPool(url, async (p) => {
    const tables = (
      await p.query(`
        SELECT c.relname AS name, c.relrowsecurity AS rls
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r'
         ORDER BY c.relname`)
    ).rows;

    const columns = (
      await p.query(`
        SELECT table_name || '.' || column_name AS name
          FROM information_schema.columns
         WHERE table_schema = 'public'
         ORDER BY 1`)
    ).rows.map((r) => r.name);

    const policies = (
      await p.query(`
        SELECT tablename || ':' || policyname || ':' || roles::text AS name
          FROM pg_policies WHERE schemaname = 'public' ORDER BY 1`)
    ).rows.map((r) => r.name);

    const extensions = (await p.query("SELECT extname FROM pg_extension ORDER BY 1")).rows.map((r) => r.extname);

    const functions = (
      await p.query(`
        SELECT p.proname AS name, p.prosecdef AS definer, coalesce(array_to_string(p.proacl, ','), '') AS acl
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' ORDER BY 1`)
    ).rows;

    const rows = [];
    for (const table of tables) {
      const { rows: r } = await p.query(`SELECT count(*)::int AS n FROM public.${quote(table.name)}`);
      rows.push([table.name, r[0].n]);
    }

    return {
      tables: tables.map((t) => t.name),
      rls: tables.filter((t) => t.rls).map((t) => t.name),
      columns,
      policies,
      extensions,
      functions,
      rows,
    };
  });
}

/**
 * Does the restored database do what the source did?
 *
 * Returns a list rather than calling `check` directly, so that the drill can
 * run it against a deliberately damaged restore and assert that it *fails*.
 * A verifier that reports its own results has no way to be tested.
 */
async function verify(source, restored, url) {
  const out = [];
  const missing = (a, b) => a.filter((x) => !b.includes(x));

  out.push([
    "every table the source had is there",
    missing(source.tables, restored.tables).length === 0,
    missing(source.tables, restored.tables).join(", "),
  ]);
  out.push([
    "and every column of them",
    missing(source.columns, restored.columns).length === 0,
    missing(source.columns, restored.columns).slice(0, 5).join(", "),
  ]);
  out.push([
    "every table came back with the rows it had",
    sameCounts(source.rows, restored.rows),
    JSON.stringify(
      source.rows
        .filter(([name, n]) => (restored.rows.find(([r]) => r === name)?.[1] ?? -1) !== n)
        .slice(0, 4),
    ),
  ]);
  out.push([
    "row-level security is still on where it was on",
    missing(source.rls, restored.rls).length === 0,
    missing(source.rls, restored.rls).join(", "),
  ]);
  out.push([
    "and every policy came with it, naming the same roles",
    missing(source.policies, restored.policies).length === 0,
    missing(source.policies, restored.policies).slice(0, 4).join(" | "),
  ]);
  out.push([
    "every extension the source had is installed",
    missing(source.extensions, restored.extensions).length === 0,
    missing(source.extensions, restored.extensions).join(", "),
  ]);
  out.push([
    "the definer functions came back, and none of them is executable with the anon key",
    source.functions
      .filter((f) => f.definer)
      .every((f) => {
        const there = restored.functions.find((g) => g.name === f.name);
        return there !== undefined && !/(^|,)(anon|authenticated)=/.test(there.acl);
      }),
    JSON.stringify(restored.functions.filter((f) => f.definer).map((f) => f.name)),
  ]);

  /*
    And the one that matters.

    Every check above can pass on a database the product cannot use. This one
    stops being a question about the schema and becomes a question about the
    product: connect as the role the API actually connects as, ask for a row
    that is in the source, and see whether it comes back. Under a policy that
    does not match — or under no policy at all, which is what a half-restore
    leaves — this returns zero rows and no error, at full speed, forever.

    `SET ROLE` rather than a second connection because `editly_app` has no
    password here and, more importantly, because the check must not depend on
    the drill being handed a second credential. Row security applies to the
    role in effect, so a superuser that has stepped into `editly_app` is
    subject to exactly the policies the application is.
  */
  const readable = source.rows.filter(([name, n]) => n > 0 && source.rls.includes(name)).map(([name]) => name);
  const probe = readable[0] ?? source.rows.find(([, n]) => n > 0)?.[0];
  if (!probe) {
    out.push(["a real read comes back with rows", false, "the source had no rows to read"]);
    return out;
  }
  const read = await withPool(url, async (p) => {
    try {
      await p.query("SET ROLE editly_app");
      const { rows } = await p.query(`SELECT count(*)::int AS n FROM public.${quote(probe)}`);
      return { n: rows[0].n, error: null };
    } catch (error) {
      return { n: -1, error: String(error?.message ?? error).slice(0, 160) };
    }
  });
  const expected = source.rows.find(([name]) => name === probe)[1];
  out.push([
    `a real read as editly_app returns the rows that are there (${probe})`,
    read.error === null && read.n === expected,
    read.error ?? `${read.n} rows where the source has ${expected}`,
  ]);
  return out;
}

/* ── Small machinery ───────────────────────────────────────────────────────── */

/**
 * Every role the dump file names, which is exactly the set the restore needs.
 *
 * Read from the text rather than from a list in this file, because a list here
 * would be a second copy of the schema's own answer and would go stale the
 * first time a migration granted to something new.
 */
function rolesNamedIn(sql) {
  const found = new Set();
  for (const re of [/\bGRANT\s+[\s\S]*?\s+TO\s+([A-Za-z_][\w$]*)/g, /\bTO\s+([A-Za-z_][\w$]*)\s*\n?\s*USING/g, /OWNER TO ([A-Za-z_][\w$]*)/g, /CREATE POLICY[\s\S]*?\bTO\s+([A-Za-z_][\w$]*)/g]) {
    for (const match of sql.matchAll(re)) found.add(match[1]);
  }
  // PUBLIC is not a role, and the superuser the dump was taken as is already
  // there on any server you can restore onto.
  for (const notARole of ["PUBLIC", "public", "postgres", "CURRENT_USER", "SESSION_USER"]) found.delete(notARole);
  return [...found].sort();
}

/** `CREATE ROLE` for each, idempotently — the step `pg_dump` cannot do for you. */
function rolesSql(roles) {
  return [
    "-- The roles the dump names. pg_dump does not carry these: roles are a",
    "-- property of the cluster, not of the database, so a restore onto a fresh",
    "-- server has to create them first or every GRANT and every CREATE POLICY",
    "-- in the dump fails — and, with psql's default of continuing past errors,",
    "-- leaves tables with row security on and nothing under it.",
    "DO $$ BEGIN",
    ...roles.map(
      (role) =>
        `  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${quote(role)}; END IF;`,
    ),
    "END $$;",
    "",
  ].join("\n");
}

/** The dump as it lands when every policy statement failed and psql carried on. */
function withoutPolicies(sql) {
  return sql
    .split("\n")
    .filter((line) => !/^CREATE POLICY /.test(line))
    .join("\n")
    // A CREATE POLICY in a plain dump is one statement over several lines; drop
    // its continuation too, which is everything up to the terminating ";".
    .replace(/^\s+(FOR ALL|USING|WITH CHECK|TO )[^\n]*\n/gm, "");
}

function sameCounts(a, b) {
  const byName = new Map(b);
  return a.every(([name, n]) => byName.get(name) === n);
}

async function seed(url) {
  await withPool(url, async (p) => {
    await p.query(`
      INSERT INTO projects (id, user_id, title) VALUES ('drill-project', '11111111-1111-4111-8111-111111111111', 'a project that existed before the backup')
        ON CONFLICT (id) DO NOTHING;
      INSERT INTO messages (id, user_id, project_id, role, content)
        VALUES ('drill-message', '11111111-1111-4111-8111-111111111111', 'drill-project', 'user', 'make it vertical')
        ON CONFLICT (id) DO NOTHING;
      INSERT INTO jobs (id, user_id, project_id, status, plan, input_path, output_seconds, finished_at)
        VALUES ('drill-job', '11111111-1111-4111-8111-111111111111', 'drill-project', 'done',
                '{"version":1,"operations":[]}'::jsonb, 'x/y/source.mp4', 42, now())
        ON CONFLICT (id) DO NOTHING;`);
  });
}

async function recreate(db) {
  await drop(db);
  await withPool(adminUrl(LOCAL), (p) => p.query(`CREATE DATABASE ${quote(db)}`));
}

async function drop(db) {
  if (!db.startsWith(PREFIX)) throw new Error(`refusing to drop ${db}: not a drill database`);
  await withPool(adminUrl(LOCAL), async (p) => {
    await p.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [db],
    );
    await p.query(`DROP DATABASE IF EXISTS ${quote(db)}`);
  });
}

async function withPool(url, fn) {
  const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);
  const pool = new Pool({ connectionString: url, max: 1, ...(isLocal ? {} : { ssl: { rejectUnauthorized: false } }) });
  try {
    return await fn(pool);
  } finally {
    await pool.end().catch(() => {});
  }
}

function run(bin, args) {
  const out = spawnSync(bin, args, { encoding: "utf8", env: { ...process.env, PGCONNECT_TIMEOUT: "10" } });
  if (out.status !== 0) {
    console.error(`${bin} failed: ${(out.stderr ?? "").slice(0, 500)}`);
    process.exit(1);
  }
  return out.stdout ?? "";
}

function psql(url, args) {
  return run("psql", ["--quiet", "--no-psqlrc", url, ...args]);
}

function withDatabase(url, db) {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

function adminUrl(url) {
  return withDatabase(url, "postgres");
}

function sameDatabase(a, b) {
  const x = new URL(a);
  const y = new URL(b);
  return x.host === y.host && x.pathname === y.pathname;
}

/** Never print a connection string with its password in it. */
function redact(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "the configured database";
  }
}

/** An identifier, quoted, so a name from the database cannot become syntax. */
function quote(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}
