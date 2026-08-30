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
import { resolveTestDatabaseUrl } from "./lib/test-db.mjs";

const require = createRequire(import.meta.url);
// `pg` is a dependency of lib/db, not of this repo's root, so it is resolved
// from there rather than assumed to be hoisted.
const { Pool } = require(require.resolve("pg", { paths: ["lib/db"] }));

const DATABASE_URL =
  await resolveTestDatabaseUrl();

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

// ─── Is anything listening at all? ───────────────────────────────────────────

section("A queue with nobody on it, and a queue with somebody on it");
{
  // These are the two situations the product could not tell apart. Both look
  // like a job sitting at queued with a progress bar at zero, and they mean
  // opposite things to whoever is waiting: one is "your turn is coming", the
  // other is "nothing is going to happen".
  const { spawnSync } = await import("node:child_process");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const nodePath = await import("node:path");
  const { pathToFileURL } = await import("node:url");

  const buildDir = await mkdtemp(nodePath.join(tmpdir(), "editly-queue-health-"));
  const outfile = nodePath.join(buildDir, "queue-health.mjs");
  const built = spawnSync(
    require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/api-server"] }),
    [
      "artifacts/api-server/src/lib/queue-health.ts",
      "--bundle", "--platform=node", "--format=esm", "--target=node22",
      `--outfile=${outfile}`, "--log-level=error",
    ],
    { stdio: "inherit" },
  );
  if (built.status !== 0) {
    console.error("could not bundle queue-health");
    process.exit(1);
  }
  const { isUnclaimed, isUnattended, workerOnline, NO_WORKER_AFTER_MS, WORKER_OFFLINE_AFTER_MS } =
    await import(pathToFileURL(outfile).href);

  const now = Date.now();
  const ago = (ms) => new Date(now - ms).toISOString();

  check(
    "a job queued a moment ago is not stalled — the queue is allowed to be busy",
    !isUnclaimed({ status: "queued", createdAt: ago(30_000) }, now),
  );
  check(
    "a job queued long enough with nobody holding it is",
    isUnclaimed({ status: "queued", createdAt: ago(NO_WORKER_AFTER_MS + 1000) }, now),
  );
  check(
    "a job somebody has claimed never is, however long it takes",
    !isUnclaimed({ status: "queued", createdAt: ago(60 * 60_000), lockedAt: ago(60_000) }, now),
  );
  check("nor is one that is running", !isUnclaimed({ status: "running", createdAt: ago(60 * 60_000) }, now));
  check("nor one that finished", !isUnclaimed({ status: "done", createdAt: ago(60 * 60_000) }, now));

  // The heartbeat is the half the queue cannot answer: when nothing is queued,
  // an empty queue and a dead worker are the same picture.
  check("no heartbeat at all means nothing is listening", workerOnline(null, now) === false);
  check("and neither does an unparseable one", workerOnline("not a date", now) === false);
  check("a beat from a moment ago means it is here", workerOnline(ago(20_000), now) === true);
  check(
    "a beat older than the window means it has gone",
    workerOnline(ago(WORKER_OFFLINE_AFTER_MS + 1000), now) === false,
  );
  check(
    "the window is generously longer than the beat, because a worker mid-render is busy, not dead",
    WORKER_OFFLINE_AFTER_MS >= 60_000,
    String(WORKER_OFFLINE_AFTER_MS),
  );
  check(
    "a timestamp from the future is a clock disagreement, not evidence of absence",
    workerOnline(new Date(now + 30_000).toISOString(), now) === true,
  );

  // The two halves, put together — which is the fix. Age alone was the only
  // input, and age alone gets the flagship case exactly backwards: one worker
  // busy on a ninety-minute Pro render means every job queued behind it crosses
  // five minutes and is told "nothing has picked this up yet", while a machine
  // is running and will reach it shortly. That is the inversion this module's
  // own header says it exists to prevent, committed by the module itself.
  const oldQueued = { status: "queued", createdAt: ago(NO_WORKER_AFTER_MS + 60_000) };

  check(
    "a queue behind a machine that beat a moment ago is a queue, not a stall",
    isUnattended(oldQueued, ago(20_000), now) === false,
  );
  check(
    "however long it has been waiting",
    isUnattended({ status: "queued", createdAt: ago(6 * 60 * 60_000) }, ago(5_000), now) === false,
  );
  check(
    "with nothing listening, age speaks again",
    isUnattended(oldQueued, ago(WORKER_OFFLINE_AFTER_MS + 60_000), now) === true,
  );
  check(
    "and with nothing ever having beaten at all",
    isUnattended(oldQueued, null, now) === true,
  );
  check(
    "a job queued a moment ago is still not stalled, worker or no worker",
    isUnattended({ status: "queued", createdAt: ago(30_000) }, null, now) === false,
  );
  check(
    "and the old rule is still the one it falls back to, unchanged",
    isUnattended(oldQueued, null, now) === isUnclaimed(oldQueued, now),
  );

  await rm(buildDir, { recursive: true, force: true });
}

// ─── The statement this file is a copy of ────────────────────────────────────

section("A long render is not an abandoned one");
{
  // The bug this replaces: `locked_at` was written once, at claim, and never
  // again. So "abandoned by a dead worker" was decided from a single sample
  // taken before any work started, and a 95-minute podcast — which Pro sells,
  // at a 240-minute ceiling — looked identical to a crash at exactly 30
  // minutes. A second worker requeued it and began rendering the same file, a
  // third did at 60, and at 90 the sweeper marked it failed with "Gave up after
  // repeated failures" while two workers were still encoding it.
  await reset();
  await queue("long-render", {
    status: "running",
    locked_at: new Date(Date.now() - 45 * 60_000),
    locked_by: "w1",
    attempts: 1,
  });

  const beforeRenewal = (await pool.query(REQUEUE_STALE, [String(STALE_MINUTES)])).rows.map((r) => r.id);
  check(
    "a lock written once and left is swept, which is the old behaviour",
    beforeRenewal.includes("long-render"),
    JSON.stringify(beforeRenewal),
  );

  // The renewal the worker now runs on a timer for as long as a job is in hand.
  await reset();
  await queue("long-render", {
    status: "running",
    locked_at: new Date(Date.now() - 45 * 60_000),
    locked_by: "w1",
    attempts: 1,
  });
  const renewed = await pool.query(
    "UPDATE jobs SET locked_at = now(), updated_at = now() WHERE id = $1 AND locked_by = $2 RETURNING id",
    ["long-render", "w1"],
  );
  check("the worker that holds it can renew", renewed.rowCount === 1);

  const afterRenewal = (await pool.query(REQUEUE_STALE, [String(STALE_MINUTES)])).rows.map((r) => r.id);
  check(
    "and then it is not swept, however long the render has taken",
    !afterRenewal.includes("long-render"),
    JSON.stringify(afterRenewal),
  );

  const stillRunning = await read("long-render");
  check("it is still running, not queued again", stillRunning.status === "running", stillRunning.status);
  check("and its attempt was not spent", Number(stillRunning.attempts) === 1, String(stillRunning.attempts));

  const exhausted = (await pool.query(FAIL_EXHAUSTED, [String(STALE_MINUTES)])).rows.map((r) => r.id);
  check(
    "nor is it failed out from under a worker that is still encoding",
    !exhausted.includes("long-render"),
    JSON.stringify(exhausted),
  );

  // The guard that matters if the job was taken away anyway: a renewal must
  // never reach into a row somebody else now holds.
  await pool.query("UPDATE jobs SET locked_by = $1 WHERE id = $2", ["w2", "long-render"]);
  const stolen = await pool.query(
    "UPDATE jobs SET locked_at = now() WHERE id = $1 AND locked_by = $2 RETURNING id",
    ["long-render", "w1"],
  );
  check("a worker cannot renew a lock it no longer holds", stolen.rowCount === 0, String(stolen.rowCount));
}

section("One project cannot have two renders in flight");
{
  // Both queueing routes SELECT for a pending job and then INSERT, with nothing
  // between them. Two requests milliseconds apart — a double-click, or the
  // browser retrying a dropped response — both read "nothing pending" and both
  // write. Two encodes of one clip, both measured, both summed by the meter,
  // and only one of them visible anywhere in the product: a Creator customer
  // with eight minutes left spends all eight on one four-minute video.
  await reset();
  await queue("first");

  let secondRejected = null;
  try {
    await queue("second", { project_id: "p-first" });
  } catch (error) {
    secondRejected = error;
  }
  check("a second queued job for the same project is refused", secondRejected !== null);
  check(
    "as a unique violation, which the routes translate into the 409 they already meant",
    secondRejected?.code === "23505",
    String(secondRejected?.code),
  );
  check(
    "naming the index, so the handler can tell it from any other collision",
    secondRejected?.constraint === "jobs_one_active_per_project",
    String(secondRejected?.constraint),
  );

  // Concurrently, which is the arrangement the SELECT cannot survive and the
  // index can.
  await reset();
  const both = await Promise.allSettled([
    queue("race-a", { project_id: "p-race" }),
    queue("race-b", { project_id: "p-race" }),
  ]);
  const wrote = both.filter((r) => r.status === "fulfilled").length;
  check("exactly one of two simultaneous inserts lands", wrote === 1, JSON.stringify(both.map((b) => b.status)));

  // Running counts as in flight too — the second click usually arrives after a
  // worker has already picked the first up.
  await reset();
  await queue("running-one", { status: "running", locked_at: new Date(), locked_by: "w1" });
  let whileRunning = null;
  try {
    await queue("running-two", { project_id: "p-running-one" });
  } catch (error) {
    whileRunning = error;
  }
  check("and a project already rendering takes no second job either", whileRunning?.code === "23505");

  // Finished work must not block the next render. The index is partial for
  // exactly this reason.
  await reset();
  await queue("done-one", { status: "done", project_id: "p-again" });
  await queue("failed-one", { status: "failed", project_id: "p-again" });
  let afterFinished = null;
  try {
    await queue("new-one", { project_id: "p-again" });
  } catch (error) {
    afterFinished = error;
  }
  check("a project whose renders have finished can be rendered again", afterFinished === null, String(afterFinished));
  check(
    "and a failed one too — a failure must not lock somebody out of retrying",
    (await read("new-one"))?.status === "queued",
  );
}

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
