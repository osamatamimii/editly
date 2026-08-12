/**
 * The job loop, against a real Postgres.
 *
 * This is the file the build plan called the most under-tested thing in the
 * repository relative to its risk, and the description was fair. Everything
 * here is concurrency and time — `FOR UPDATE SKIP LOCKED`, a lock that expires,
 * an attempt counter, and an ordering that decides whose render happens first —
 * and none of it can be checked by reasoning about the code. Two workers
 * claiming the same row produces no error at all: it produces one customer's
 * render happening twice and being billed twice.
 *
 * So these run the actual SQL, in a transaction-per-connection, against a real
 * database. Nothing is mocked, because a mock of `SKIP LOCKED` is a mock of the
 * only thing worth testing.
 *
 * Usage: DATABASE_URL=postgres://... node tools/queue-test.mjs
 * Requires: a Postgres carrying the production schema.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// `pg` is a dependency of lib/db, not of this repo's root, so it is resolved
// from there rather than assumed to be hoisted.
const { Pool } = require(require.resolve("pg", { paths: ["lib/db"] }));

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres@127.0.0.1:5433/editly_test";

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

const pool = new Pool({ connectionString: DATABASE_URL, max: 8 });

const ALICE = "11111111-1111-4111-8111-111111111111";
const STALE_MINUTES = 30;

/**
 * The claim, copied from `worker/src/index.ts`.
 *
 * Copied rather than imported because the worker's module opens a connection
 * pool and a logger the moment it loads. The statement is the thing under test
 * and it is short enough that a divergence would be obvious in review — and the
 * last check in this file asserts that the worker still contains this ordering,
 * so a change there that is not made here fails.
 */
const CLAIM = `
  UPDATE jobs SET
    status = 'running',
    locked_at = now(),
    locked_by = $1,
    started_at = COALESCE(started_at, now()),
    attempts = attempts + 1,
    updated_at = now()
  WHERE id = (
    SELECT id FROM jobs
    WHERE status = 'queued' AND attempts < max_attempts
    ORDER BY priority DESC, created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING id, attempts, locked_by`;

const REQUEUE_STALE = `
  UPDATE jobs SET status = 'queued', locked_at = NULL, locked_by = NULL, updated_at = now()
  WHERE status = 'running'
    AND locked_at < now() - ($1 || ' minutes')::interval
    AND attempts < max_attempts
  RETURNING id`;

const FAIL_EXHAUSTED = `
  UPDATE jobs SET status = 'failed',
    error = COALESCE(error, 'Gave up after repeated failures.'),
    locked_at = NULL, locked_by = NULL, finished_at = now(), updated_at = now()
  WHERE status = 'running'
    AND locked_at < now() - ($1 || ' minutes')::interval
    AND attempts >= max_attempts
  RETURNING id`;

async function reset() {
  await pool.query("DELETE FROM jobs WHERE user_id = $1", [ALICE]);
}

/** Queues a job. `over` sets any column directly, for the cases time creates. */
async function queue(id, over = {}) {
  const columns = {
    id,
    user_id: ALICE,
    project_id: `p-${id}`,
    status: "queued",
    plan: JSON.stringify({ version: 1, operations: [] }),
    input_path: `${ALICE}/p-${id}/source.mp4`,
    priority: 0,
    attempts: 0,
    max_attempts: 3,
    ...over,
  };
  const names = Object.keys(columns);
  const values = Object.values(columns);
  await pool.query(
    `INSERT INTO jobs (${names.join(",")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(",")})`,
    values,
  );
}

const claim = async (worker) => (await pool.query(CLAIM, [worker])).rows[0] ?? null;
const read = async (id) => (await pool.query("SELECT * FROM jobs WHERE id = $1", [id])).rows[0];

// ─── One row, one worker ─────────────────────────────────────────────────────

section("Two workers never claim the same job");
{
  await reset();
  await queue("only-one");

  // Concurrently, on separate connections, which is the only arrangement in
  // which SKIP LOCKED means anything.
  const results = await Promise.all([claim("w1"), claim("w2"), claim("w3")]);
  const claimed = results.filter(Boolean);

  check("exactly one worker gets it", claimed.length === 1, JSON.stringify(results));
  check("the others get nothing rather than blocking", results.filter((r) => r === null).length === 2);
  check("and the row says who has it", ["w1", "w2", "w3"].includes(claimed[0].locked_by));

  const row = await read("only-one");
  check("it is marked running", row.status === "running");
  check("the attempt is counted", row.attempts === 1, String(row.attempts));
  check("and the start time is recorded", row.started_at !== null);
}

section("Ten workers over five jobs: every job once, no job twice");
{
  await reset();
  for (let i = 0; i < 5; i += 1) await queue(`race-${i}`);

  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) => claim(`worker-${i}`)),
  );
  const ids = results.filter(Boolean).map((r) => r.id);

  check("five claims succeeded", ids.length === 5, `${ids.length}`);
  check("no job was handed out twice", new Set(ids).size === 5, JSON.stringify(ids));
  check("and the five that missed got null", results.filter((r) => r === null).length === 5);
}

// ─── Who goes first ──────────────────────────────────────────────────────────

section("Paid work is claimed first, and within a band the oldest wins");
{
  await reset();
  const now = Date.now();
  const ago = (minutes) => new Date(now - minutes * 60_000).toISOString();

  await queue("free-oldest", { priority: 0, created_at: ago(60) });
  await queue("free-newer", { priority: 0, created_at: ago(30) });
  await queue("paid-newest", { priority: 10, created_at: ago(1) });
  await queue("paid-older", { priority: 10, created_at: ago(10) });

  const order = [];
  for (let i = 0; i < 4; i += 1) order.push((await claim(`w${i}`)).id);

  check(
    "both paid jobs go before either free one",
    order.slice(0, 2).every((id) => id.startsWith("paid")),
    JSON.stringify(order),
  );
  check("the older paid job goes first", order[0] === "paid-older", JSON.stringify(order));
  check("the older free job goes first too", order[2] === "free-oldest", JSON.stringify(order));
  check(
    "so a free render waits behind paid work queued before it, never behind work queued after",
    JSON.stringify(order) === JSON.stringify(["paid-older", "paid-newest", "free-oldest", "free-newer"]),
    JSON.stringify(order),
  );
}

// ─── A worker that dies ──────────────────────────────────────────────────────

section("A job whose worker died goes back to the queue");
{
  await reset();
  await queue("abandoned", {
    status: "running",
    attempts: 1,
    locked_at: new Date(Date.now() - 45 * 60_000).toISOString(),
    locked_by: "a-worker-that-is-gone",
  });
  await queue("still-working", {
    status: "running",
    attempts: 1,
    locked_at: new Date(Date.now() - 2 * 60_000).toISOString(),
    locked_by: "a-worker-that-is-fine",
  });

  const requeued = (await pool.query(REQUEUE_STALE, [String(STALE_MINUTES)])).rows.map((r) => r.id);
  check("the abandoned one is returned", requeued.includes("abandoned"), JSON.stringify(requeued));
  check("a render that is merely slow is left alone", !requeued.includes("still-working"), JSON.stringify(requeued));

  const back = await read("abandoned");
  check("it is queued again", back.status === "queued");
  check("with the lock cleared, or no worker could take it", back.locked_at === null && back.locked_by === null);
  check("and the attempt it already burned is remembered", back.attempts === 1, String(back.attempts));

  const retaken = await claim("a-fresh-worker");
  check("a fresh worker can pick it up", retaken?.id === "abandoned", JSON.stringify(retaken));
  check("and that costs it a second attempt", retaken.attempts === 2, String(retaken.attempts));
}

section("A job that has burned every attempt stops looking pending");
{
  await reset();
  await queue("hopeless", {
    status: "running",
    attempts: 3,
    max_attempts: 3,
    locked_at: new Date(Date.now() - 45 * 60_000).toISOString(),
    locked_by: "gone",
  });

  const requeued = (await pool.query(REQUEUE_STALE, [String(STALE_MINUTES)])).rows.map((r) => r.id);
  check("it is not returned to the queue", !requeued.includes("hopeless"), JSON.stringify(requeued));

  const failed = (await pool.query(FAIL_EXHAUSTED, [String(STALE_MINUTES)])).rows.map((r) => r.id);
  check("it is failed instead", failed.includes("hopeless"), JSON.stringify(failed));

  const row = await read("hopeless");
  check("with a status the UI can show", row.status === "failed");
  check("a message the user can read", typeof row.error === "string" && row.error.length > 0, row.error);
  check("a finish time, so it stops counting as in flight", row.finished_at !== null);
  check("and no lock left behind", row.locked_at === null && row.locked_by === null);
}

section("A queued job at its attempt ceiling is never claimed again");
{
  await reset();
  await queue("burnt-out", { attempts: 3, max_attempts: 3 });
  const taken = await claim("w1");
  check("the claim finds nothing", taken === null, JSON.stringify(taken));

  await queue("one-left", { attempts: 2, max_attempts: 3 });
  const last = await claim("w1");
  check("but a job with one attempt left is claimed", last?.id === "one-left", JSON.stringify(last));
  check("and that is its last", last.attempts === 3, String(last.attempts));
  check("a further claim finds nothing", (await claim("w2")) === null);
}

// ─── An empty queue ──────────────────────────────────────────────────────────

section("An empty queue is not an error");
{
  await reset();
  check("claiming returns null", (await claim("w1")) === null);
  check("the sweep returns nothing", (await pool.query(REQUEUE_STALE, ["30"])).rowCount === 0);
  check("and so does the failer", (await pool.query(FAIL_EXHAUSTED, ["30"])).rowCount === 0);
}

section("Finished work is invisible to the queue");
{
  await reset();
  await queue("done-already", { status: "done" });
  await queue("failed-already", { status: "failed" });
  check("neither is claimed", (await claim("w1")) === null);
}

// ─── The statement this file is a copy of ────────────────────────────────────

section("The worker still claims the way this file assumes");
{
  const { readFileSync } = await import("node:fs");
  const source = readFileSync("artifacts/worker/src/index.ts", "utf8");

  check("it uses SKIP LOCKED", /FOR UPDATE SKIP LOCKED/.test(source));
  check("it orders by priority before age", /ORDER BY priority DESC, created_at/.test(source));
  check("it refuses jobs at their attempt ceiling", /attempts < max_attempts/.test(source));
  check("it claims only queued rows", /status = 'queued'/.test(source));
  check("it takes one at a time", /LIMIT 1/.test(source));
  check("and it counts the attempt as part of the claim", /attempts = attempts \+ 1/.test(source));
}

await reset();
await pool.end();

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("One job, one worker, in the order people were promised.");
