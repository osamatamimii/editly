/**
 * "Waiting for a free slot" is true, and it is not an answer.
 *
 * One worker renders one job at a time, and that is a measurement rather than a
 * choice: peak resident memory for ffmpeg on a 1080p source runs from 602 MB at
 * two pieces to 1088 MB at six, against a machine with one gigabyte. A second
 * render inside the same box does not go slower — it gets OOM-killed, and an
 * OOM is not a failed render but a job that dies with no note while the
 * customer's minute is spent anyway. So capacity is machines, and the number on
 * the screen is what somebody waiting actually has.
 *
 * ## What this file is guarding
 *
 * A wait that is wrong is worse than no wait, because somebody plans around it.
 * Every check below is about the *refusals* as much as the arithmetic: too
 * little history to have a typical render, no worker to divide by, nothing
 * ahead. Production has ten renders in its whole history — a median drawn from
 * three of them is one video with a confident sentence wrapped around it.
 *
 * And the queue predicate has to agree with the claim. `claimJob` takes work in
 * `priority DESC, created_at` order; the count of what is ahead of you is a
 * second expression of the same rule, in a different file, in SQL. Two orders
 * that drift apart give everybody behind a priority job a number that is
 * quietly wrong, and nothing anywhere fails.
 *
 * Usage: node tools/capacity-test.mjs
 * Requires: nothing.
 */
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-capacity-"));

function build(source, name) {
  const outfile = path.join(buildDir, name);
  const built = spawnSync(
    require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/api-server"] }),
    [
      path.join(repoRoot, source),
      "--bundle", "--platform=node", "--format=esm", "--target=node22",
      `--outfile=${outfile}`, "--log-level=error",
    ],
    { stdio: "inherit" },
  );
  if (built.status !== 0) process.exit(1);
  return pathToFileURL(outfile).href;
}

const health = await import(build("artifacts/api-server/src/lib/queue-health.ts", "health.mjs"));
const words = await import(build("artifacts/editly/src/lib/wait-in-words.ts", "words.mjs"));
const {
  liveWorkers, renderRate, waitEstimate, workerOnline,
  RATE_SAMPLE_MIN, WORKER_OFFLINE_AFTER_MS,
} = health;
const { waitInWords } = words;

const read = (file) => readFile(path.join(repoRoot, file), "utf8");

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
const section = (t) => console.log(`\n${t}`);

const NOW = Date.UTC(2026, 7, 31, 12, 0, 0);
const secondsAgo = (s) => new Date(NOW - s * 1000);

// ── How many machines ───────────────────────────────────────────────────────

section("Workers are counted, not merely detected");
{
  check("nobody beating is nobody", liveWorkers([], NOW) === 0);
  check("one recent beat is one", liveWorkers([secondsAgo(5)], NOW) === 1);
  check("three recent beats are three", liveWorkers([secondsAgo(1), secondsAgo(30), secondsAgo(60)], NOW) === 3);
  /*
    A count and not a boolean because the wait divides by it: adding a machine
    has to shorten the estimate on its own, with nobody editing a constant.
  */
  check(
    "a worker that stopped beating is not counted",
    liveWorkers([secondsAgo(5), secondsAgo(WORKER_OFFLINE_AFTER_MS / 1000 + 60)], NOW) === 1,
  );
  check("nulls are not workers", liveWorkers([null, undefined, secondsAgo(2)], NOW) === 1);
  check("and it agrees with the single-worker question", liveWorkers([secondsAgo(5)], NOW) > 0 === workerOnline(secondsAgo(5), NOW));
}

// ── How fast ────────────────────────────────────────────────────────────────

section("A typical render is measured per second of source, not per job");
{
  const even = Array.from({ length: 5 }, () => ({ wallMs: 10_000, sourceSeconds: 10 }));
  check("five identical renders give their rate", renderRate(even) === 1000, String(renderRate(even)));

  /*
    Per second of source, because render time scales with the length of the
    footage. A flat median per job would tell everybody behind a podcast the
    same wrong number as everybody behind a thirty-second clip.
  */
  const mixed = [
    { wallMs: 60_000, sourceSeconds: 60 },
    { wallMs: 600_000, sourceSeconds: 600 },
    { wallMs: 30_000, sourceSeconds: 30 },
    { wallMs: 120_000, sourceSeconds: 120 },
    { wallMs: 45_000, sourceSeconds: 45 },
  ];
  check("a podcast and four clips agree on the rate", renderRate(mixed) === 1000, String(renderRate(mixed)));

  /*
    The median rather than the mean, so one render that stalled behind a
    provider timeout does not become everybody's estimate.
  */
  const withOutlier = [...even, { wallMs: 900_000, sourceSeconds: 10 }];
  check("one pathological render does not move it", renderRate(withOutlier) === 1000, String(renderRate(withOutlier)));

  check("fewer than the minimum is not a typical", renderRate(even.slice(0, RATE_SAMPLE_MIN - 1)) === null);
  check("and the minimum is more than a handful", RATE_SAMPLE_MIN >= 5, String(RATE_SAMPLE_MIN));
  check(
    "rows with no source length are dropped rather than counted as instant",
    renderRate([...even, { wallMs: 5_000, sourceSeconds: 0 }]) === 1000,
  );
  check("and so are impossible durations", renderRate([...even, { wallMs: -1, sourceSeconds: 10 }]) === 1000);
}

// ── The number itself ───────────────────────────────────────────────────────

section("The wait is arithmetic, and it divides by the machines that exist");
{
  const rate = 1000; // one second of work per second of source
  check(
    "600 seconds of work on one machine is ten minutes",
    waitEstimate({ aheadSourceSeconds: 600, workers: 1, rate }) === 600,
    String(waitEstimate({ aheadSourceSeconds: 600, workers: 1, rate })),
  );
  /*
    The whole point of counting machines. A second worker halves the wait with
    nobody editing anything — which is what makes `WORKER_COUNT` a real lever
    rather than a note in a runbook.
  */
  check(
    "and on two machines it is five",
    waitEstimate({ aheadSourceSeconds: 600, workers: 2, rate }) === 300,
    String(waitEstimate({ aheadSourceSeconds: 600, workers: 2, rate })),
  );

  /*
    Rounded up. Somebody told four minutes and given three and a half has been
    treated well; somebody told three and given four has been lied to.
  */
  check("it rounds up, never down", waitEstimate({ aheadSourceSeconds: 61, workers: 1, rate }) === 90,
    String(waitEstimate({ aheadSourceSeconds: 61, workers: 1, rate })));
  check("to the half minute, because the number under it is a median", waitEstimate({ aheadSourceSeconds: 100, workers: 1, rate }) % 30 === 0);
  check("and never to nothing", waitEstimate({ aheadSourceSeconds: 1, workers: 1, rate }) === 30);
}

section("...and refuses rather than invents");
{
  const rate = 1000;
  check("no history, no number", waitEstimate({ aheadSourceSeconds: 600, workers: 1, rate: null }) === null);
  /*
    No worker is a different sentence entirely — "nothing is listening" — and
    the screen already has a truer one for it. Dividing by zero to fill this
    field would replace it with Infinity dressed as a wait.
  */
  check("no worker, no number", waitEstimate({ aheadSourceSeconds: 600, workers: 0, rate }) === null);
  check("nothing ahead, no number", waitEstimate({ aheadSourceSeconds: 0, workers: 1, rate }) === null);
  check("and a nonsense rate is refused too", waitEstimate({ aheadSourceSeconds: 600, workers: 1, rate: 0 }) === null);
}

// ── What it reads as ────────────────────────────────────────────────────────

section("The words are a shape somebody can plan around");
{
  check("a minute or less is said as that", waitInWords(60) === "Starting in under a minute…", waitInWords(60));
  check("four minutes is said as four", waitInWords(240) === "About 4 minutes until this starts…", waitInWords(240));
  check("and two minutes is not '2 minutes '", waitInWords(120) === "About 2 minutes until this starts…", waitInWords(120));
  check("one minute is singular", waitInWords(95) === "About 2 minutes until this starts…" || waitInWords(95).includes("minute"));
  check("past an hour it stops pretending to be precise", /More than an hour/.test(waitInWords(7200)), waitInWords(7200));
  /*
    The null case is not a failure. It is a deployment with too little history
    to have a typical render, and the sentence it falls back to is the vague,
    true one this screen has always shown.
  */
  check("no number falls back to the old sentence", waitInWords(null) === "Waiting for a free slot…");
  check("and so does a missing field", waitInWords(undefined) === "Waiting for a free slot…");
}

// ── Where it is wired ───────────────────────────────────────────────────────

section("Only the people who are waiting pay for the query");
{
  const route = await read("artifacts/api-server/src/routes/render.ts");
  /*
    This route is polled every few seconds by every open editor. Somebody
    watching a render that is already running has nothing to learn from a queue
    depth, and charging them two reads for it would be paying for the answer on
    behalf of everybody who does not need it.
  */
  check("a job that is not queued asks nothing", /if \(job\["status"\] !== "queued"\) return job;/.test(route));
  check("and the two reads go together", /Promise\.all\(\[\s*renderCapacity\(\),\s*workAheadOf/.test(route));

  const presence = await read("artifacts/api-server/src/lib/worker-presence.ts");
  check("capacity is cached, because it changes slowly", /CAPACITY_CACHE_MS/.test(presence));
  check(
    "and the cache is far shorter than the window it feeds",
    /CAPACITY_CACHE_MS = 30_000/.test(presence) && WORKER_OFFLINE_AFTER_MS > 30_000,
    "a cache longer than the online window could change the verdict it is caching",
  );
  check("a failed read is not remembered", /Not cached: a failed read is retried/.test(presence));
}

section("The queue this counts is the queue the worker claims from");
{
  /*
    Two expressions of one rule, in two files, in two languages. If they drift,
    everybody behind a priority job gets a number that is quietly wrong and
    nothing anywhere fails.
  */
  const worker = await read("artifacts/worker/src/index.ts");
  const presence = await read("artifacts/api-server/src/lib/worker-presence.ts");
  check("the worker takes priority first, then age", /ORDER BY priority DESC, created_at/.test(worker));
  check(
    "and the count ahead uses exactly that rule",
    /j\.priority > me\.priority/.test(presence) &&
      /j\.priority = me\.priority and j\.created_at < me\.created_at/.test(presence),
  );
  check("it counts running work as well as queued", /j\.status in \('queued', 'running'\)/.test(presence));
  check("and never counts the job itself", /j\.id <> \$\{jobId\}/.test(presence));
  /*
    A queued job has no `source_seconds` — the worker measures that from the
    file — so the project's own duration stands in. It is browser-written and
    the schema says plainly that it is for display, which is what this is.
  */
  check("a queued job's length comes from the project when the worker has not measured it", /coalesce\(j\.source_seconds, p\.duration, 0\)/.test(presence));
}

section("One render per machine is written down as a measurement");
{
  const fly = await read("artifacts/worker/fly.toml");
  check("the memory table is cited where the machine is sized", /602 MB.*1088 MB.*1532 MB/s.test(fly), "");
  check("and it says an OOM is not a failed render", /OOM-killed/.test(fly) && /no note/.test(fly));
  check("capacity is named as machines, not threads", /machines, not threads/.test(fly));

  const deploy = await read(".github/workflows/deploy-worker.yml");
  check("the machine count is in version control", /flyctl scale count/.test(deploy));
  check("it defaults to one, because more costs money", /WORKER_COUNT:-1/.test(deploy));
  check("and a nonsense value stops the deploy rather than scaling to zero", /must be a whole number/.test(deploy));
}

// ── And the SQL, run rather than read ───────────────────────────────────────

/*
  Everything above this reads the query out of the file, which proves it is
  spelled the way the rule says and nothing about whether Postgres agrees. A
  predicate that is subtly wrong — a comparison the wrong way round, a join that
  drops rows with no project — passes every check above and gives everybody in
  the queue a number that is quietly wrong.

  So where there is a database, the query runs against real rows.
*/
if (!process.env.DATABASE_URL) {
  section("The queue query, against a real database");
  console.log("  · skipped: DATABASE_URL is not set");
} else {
  const psql = (sql) =>
    spawnSync("psql", [process.env.DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-tAc", sql], { encoding: "utf8" });

  const USER = "3f6b4a1e-0000-4000-8000-0000000ca9ac";
  const seed = psql(`
    insert into auth.users (id, email) values ('${USER}', 'capacity@test.local')
      on conflict (id) do nothing;
    insert into projects (id, user_id, title, duration) values
      ('cap_p1', '${USER}', 'one', 100),
      ('cap_p2', '${USER}', 'two', 200),
      ('cap_p3', '${USER}', 'three', 400),
      ('cap_p4', '${USER}', 'mine', 50)
      on conflict (id) do nothing;
    insert into jobs (id, user_id, project_id, status, plan, input_path, priority, created_at, source_seconds) values
      ('cap_j1', '${USER}', 'cap_p1', 'running', '{"version":1,"operations":[]}', 'a', 0, now() - interval '10 minutes', null),
      ('cap_j2', '${USER}', 'cap_p2', 'queued',  '{"version":1,"operations":[]}', 'a', 0, now() - interval '9 minutes', null),
      ('cap_j3', '${USER}', 'cap_p3', 'queued',  '{"version":1,"operations":[]}', 'a', 0, now() - interval '1 minute', 300),
      ('cap_j4', '${USER}', 'cap_p4', 'queued',  '{"version":1,"operations":[]}', 'a', 0, now() - interval '5 minutes', null),
      ('cap_j5', '${USER}', 'cap_p1', 'done',    '{"version":1,"operations":[]}', 'a', 0, now() - interval '20 minutes', 999)
      on conflict (id) do nothing;
  `);

  section("The queue query, against a real database");
  check("the fixture is in", seed.status === 0, (seed.stderr ?? "").slice(0, 200));

  /*
    Run under `tsx` against the real module rather than a bundle of it. `pg` and
    `pino` both reach for `require` at load time and an ESM bundle has none to
    give them — and chasing that with one `--external` per offender would be a
    list that goes stale the first time a dependency changes. The point of this
    section is the SQL, and the shortest honest way to reach the SQL is to load
    the file the server loads.
  */
  const ask = (ids) => {
    /*
      Written to a file rather than passed with `-e`: tsx evaluates `-e` as
      CommonJS, where a top-level await is a syntax error — and the whole point
      of this call is to await a database read.
    */
    const script = path.join(buildDir, "ask.mts");
    writeFileSync(
      script,
      `import { workAheadOf } from "${pathToFileURL(path.join(repoRoot, "artifacts/api-server/src/lib/worker-presence.ts")).href}";\n` +
        `const out = [];\n` +
        `for (const id of ${JSON.stringify(ids)}) out.push(await workAheadOf(id));\n` +
        `console.log(JSON.stringify(out));\n` +
        `process.exit(0);\n`,
    );
    const run = spawnSync("npx", ["tsx", script], { encoding: "utf8", cwd: repoRoot });
    const line = (run.stdout ?? "").trim().split("\n").pop() ?? "";
    try {
      return JSON.parse(line);
    } catch {
      console.log((run.stderr ?? "").slice(0, 400));
      return ids.map(() => "unreadable");
    }
  };

  /*
    `cap_j4` is mine, five minutes old. Ahead of it: the running job (100s, from
    its project's duration, because the worker has not measured it) and the
    queued one nine minutes old (200s). Behind it: a job queued a minute ago,
    and one that is already done.
  */
  const [mine, oldest, newest] = ask(["cap_j4", "cap_j2", "cap_j3"]);
  check("it counts only the work that renders first", mine === 300, String(mine));
  check("the oldest queued job has only the running one ahead of it", oldest === 100, String(oldest));
  check("and the newest has all three ahead of it", newest === 350, String(newest));

  /*
    Priority jumps the queue, so it has to jump this count too — and this is the
    case a predicate that only looked at age gets wrong while looking right.
  */
  psql(`update jobs set priority = 5 where id = 'cap_j3'`);
  const [afterPriority, priorityItself, missing] = ask(["cap_j4", "cap_j3", "cap_nope"]);
  check("a priority job raised behind you counts as ahead", afterPriority === 600, String(afterPriority));
  /*
    And this is the one the first version got wrong. Work that has already
    started is ahead of you whatever its priority — it is holding a machine
    right now, and priority orders what has not been claimed yet. Without that,
    a job raised to the front of the queue reported a wait of zero while a
    render was in progress on the only worker there was.
  */
  check("but the render already in progress is still ahead of it", priorityItself === 100, String(priorityItself));
  check("a job that does not exist is not an error", missing === 0, String(missing));

  psql(`delete from jobs where id like 'cap_j%'; delete from projects where id like 'cap_p%'; delete from auth.users where id = '${USER}';`);
}

await rm(buildDir, { recursive: true, force: true });
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
console.log("Somebody waiting is told how long, or told the truth about why not.");
