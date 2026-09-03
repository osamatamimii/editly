/**
 * The console's work queue, and the four ways a queue lies.
 *
 * Every other screen on the operations console answers "how many". This one
 * answers "what": one row per render, post, connected account or payment that
 * needs a person, worst first, with the address of whoever it belongs to. That
 * is a different kind of claim from a count, and it can be wrong in ways a
 * count cannot.
 *
 * What is worth testing is not that rows come back. It is:
 *
 *   **That the count is the table and not the page.** The rows are capped per
 *   kind so a hundred failures cannot bury one overdue post; the counts are
 *   `count(*)` over the same condition. A total derived from the rows would be
 *   a lie on exactly the morning it matters, and the page tells the operator
 *   how many it is not showing from the difference between the two.
 *
 *   **That it says which render, and whose.** A row naming a job id and a
 *   truncated uuid is a row whose next step is a database prompt, which is the
 *   whole thing this screen exists to replace. Addresses come through one
 *   SECURITY DEFINER function (migration 0043) and the wiring to it is the
 *   part most likely to break silently: a wrong call shape comes back as an
 *   exception this module deliberately swallows, so the queue draws with every
 *   address missing and nothing anywhere says why. That happened once already,
 *   during the writing of it.
 *
 *   **That a queue behind a working machine is not a fault.** `unattended`
 *   means queued with nothing listening. With a live heartbeat the same rows
 *   are an ordinary queue, and a console that called them a fault would cry
 *   wolf on every busy afternoon.
 *
 *   **That the failure it quotes is the real one.** `jobs.error` is the
 *   sentence the customer was given, and for most failures that sentence is
 *   our own reassurance. The row carries `error_detail`, unedited.
 *
 * The database is real, because every one of those properties is a query.
 *
 * Usage: DATABASE_URL=postgres://... node tools/attention-test.mjs
 * Requires: a Postgres carrying the schema (pnpm run migrate). No keys, no network.
 */
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { resolveTestDatabaseUrl } from "./lib/test-db.mjs";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
// Under `lib/db`, because that is the package `pg` is a dependency of and
// esbuild leaves it external.
const buildDir = await mkdtemp(path.join(repoRoot, "lib/db/.attention-"));
process.on("exit", () => {
  try {
    require("node:fs").rmSync(buildDir, { recursive: true, force: true });
  } catch {
    /* nothing to do at exit but leave it */
  }
});

const DATABASE_URL = await resolveTestDatabaseUrl();
process.env.SUPABASE_URL ??= "http://127.0.0.1:1/not-a-real-project";
process.env.SUPABASE_ANON_KEY ??= "anon-key-for-tests";

const { Pool } = require(require.resolve("pg", { paths: ["lib/db"] }));
const pool = new Pool({ connectionString: DATABASE_URL, max: 2 });

const outfile = path.join(buildDir, "attention.mjs");
const built = spawnSync(
  require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/api-server"] }),
  [
    path.join(repoRoot, "artifacts/api-server/src/lib/attention.ts"),
    "--bundle", "--platform=node", "--format=esm", "--target=node22",
    "--external:pg", "--external:pg-native",
    `--alias:pino=${path.join(repoRoot, "tools/fixtures/pino-stub.mjs")}`,
    `--outfile=${outfile}`, "--log-level=error",
  ],
  { stdio: "inherit" },
);
if (built.status !== 0) process.exit(1);
const { attention } = await import(pathToFileURL(outfile).href);

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

const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BASHIR = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ALICE_EMAIL = "alice@attention.test";
const BASHIR_EMAIL = "bashir@attention.test";
const PROJECT = "att_project";

/**
 * Everything this suite wrote, and nothing else.
 *
 * By id and by user rather than by truncating the tables, because a suite that
 * empties `jobs` is a suite that cannot be run against anything a person cares
 * about, and the first time somebody points DATABASE_URL at a copy of
 * production is the moment that matters.
 */
async function reset() {
  await pool.query("DELETE FROM scheduled_posts WHERE id LIKE 'att_%'");
  await pool.query("DELETE FROM social_accounts WHERE id LIKE 'att_%'");
  await pool.query("DELETE FROM jobs WHERE id LIKE 'att_%'");
  await pool.query("DELETE FROM billing_events WHERE event_id LIKE 'att_%'");
  await pool.query("DELETE FROM projects WHERE id LIKE 'att_%'");
  for (const who of [ALICE, BASHIR]) {
    await pool.query("DELETE FROM subscriptions WHERE user_id = $1", [who]);
    await pool.query("DELETE FROM auth.users WHERE id = $1", [who]);
  }
  await pool.query("DELETE FROM worker_heartbeats");
}

/**
 * The heartbeat, set to an age rather than to a time.
 *
 * Because that is what every judgement on this screen turns on: the same
 * queued row is an ordinary queue behind a machine seen ten seconds ago and a
 * fault behind one seen an hour ago, and no other input decides it.
 */
async function heartbeat(secondsAgo) {
  await pool.query("DELETE FROM worker_heartbeats");
  if (secondsAgo === null) return;
  await pool.query(
    `insert into worker_heartbeats (worker_id, last_seen_at)
     values ('att-worker', now() - ($1 || ' seconds')::interval)`,
    [String(secondsAgo)],
  );
}

await reset();
await pool.query(
  `insert into auth.users (id, email) values ($1, $2), ($3, $4)
   on conflict (id) do update set email = excluded.email`,
  [ALICE, ALICE_EMAIL, BASHIR, BASHIR_EMAIL],
);
await pool.query(
  `insert into subscriptions (user_id, plan) values ($1, 'free'), ($2, 'creator')
   on conflict (user_id) do update set plan = excluded.plan`,
  [ALICE, BASHIR],
);
await pool.query("insert into projects (id, user_id, title) values ($1, $2, 'attention')", [
  PROJECT,
  ALICE,
]);

/**
 * One render, and one project for it to belong to.
 *
 * A project of its own per job because the schema holds a partial unique index
 * on `(project_id)` over the live statuses: a project can have one render in
 * flight and no more. That is a real rule about the product - two workers
 * encoding one project would write the same output key - and it means a
 * fixture that queues three renders against one project is a fixture that
 * cannot exist, which is worth learning here rather than in a query that
 * happened to be written the same wrong way.
 */
const job = async (id, who, extra = {}) => {
  const project = `${id}_p`;
  await pool.query("insert into projects (id, user_id, title) values ($1, $2, 'attention')", [
    project,
    who,
  ]);
  const columns = ["id", "user_id", "project_id", "plan", "input_path", ...Object.keys(extra)];
  const values = [id, who, project, "{}", "in.mp4", ...Object.values(extra)];
  return pool.query(
    `insert into jobs (${columns.join(",")}) values (${values.map((_, i) => `$${i + 1}`).join(",")})`,
    values,
  );
};

// ─────────────────────────────────────────────────────────────────────────────

section("A queue behind nothing is a fault; behind a machine it is a queue");
{
  await job("att_q1", BASHIR, { status: "queued", created_at: new Date(Date.now() - 7200_000) });
  await job("att_q2", BASHIR, { status: "queued", created_at: new Date(Date.now() - 60_000) });

  await heartbeat(10);
  let out = await attention();
  check(
    "with a live heartbeat, two queued renders are not on the queue at all",
    out.counts["render-unattended"] === 0 && out.counts["worker-gone"] === 0,
    JSON.stringify(out.counts),
  );

  await heartbeat(3600);
  out = await attention();
  check(
    "with an hour-old heartbeat, the machine itself is the first row",
    out.items[0]?.kind === "worker-gone",
    out.items.map((i) => i.kind).join(", "),
  );
  /*
    And one of the two renders, not both.

    A row queued a minute ago is not evidence that nothing is listening, even
    with a dead heartbeat: `isUnclaimed` waits five minutes before it will say
    so, because a worker restarting between two beats would otherwise put every
    job submitted in that window on the queue as a fault. The two are asserted
    apart rather than counted together, because "both" and "the old one" are
    the same number on a fixture where every row is old.
  */
  check(
    "the render that has waited two hours is unclaimed",
    out.items.some((i) => i.kind === "render-unattended" && i.jobId === "att_q1"),
    out.items.map((i) => `${i.kind}:${i.jobId}`).join(", "),
  );
  check(
    "and the one queued a minute ago is not, because a minute proves nothing",
    !out.items.some((i) => i.jobId === "att_q2"),
    out.items.map((i) => `${i.kind}:${i.jobId}`).join(", "),
  );
  /*
    Oldest first inside a kind, which is the opposite of every other table on
    this console and is right here: those are a record and this is a queue. The
    render that has waited two hours is the one to deal with.
  */
  const unclaimed = out.items.filter((i) => i.kind === "render-unattended");
  check(
    "oldest first, because that is the one somebody is waiting on",
    unclaimed[0]?.jobId === "att_q1",
    unclaimed.map((i) => i.jobId).join(", "),
  );

  await heartbeat(null);
  out = await attention();
  check(
    "a worker never heard from at all is also a fault, and says so with no time",
    out.counts["worker-gone"] === 1 && out.items[0]?.at === null,
    JSON.stringify(out.items[0] ?? null),
  );
}

section("The row says which render failed, and what actually failed");
{
  await heartbeat(10);
  await job("att_f1", BASHIR, {
    status: "failed",
    error: "Rendering failed. We are looking into it.",
    error_detail: "ffmpeg exited 1: moov atom not found",
    finished_at: new Date(),
    updated_at: new Date(),
  });
  const out = await attention();
  const failed = out.items.find((i) => i.kind === "render-failed");
  check("the failure is listed as a thing, not a count", failed?.jobId === "att_f1", JSON.stringify(failed ?? null));
  check(
    "and it quotes what happened rather than what the customer was told",
    failed?.detail === "ffmpeg exited 1: moov atom not found",
    String(failed?.detail),
  );
  /*
    The reassurance is the fallback and not the answer. An operator shown
    "we are looking into it" has been handed our own sentence back, and the
    reason is a log line on Fly instead - which is the shape the August outage
    had.
  */
  await pool.query("update jobs set error_detail = null where id = 'att_f1'");
  const without = await attention();
  check(
    "with nothing better to quote it falls back to that sentence rather than to nothing",
    without.items.find((i) => i.kind === "render-failed")?.detail ===
      "Rendering failed. We are looking into it.",
    String(without.items.find((i) => i.kind === "render-failed")?.detail),
  );
}

section("Every row carries the address of whoever it belongs to");
{
  const out = await attention();
  const withUser = out.items.filter((i) => i.userId !== null);
  check("there are rows to check", withUser.length > 0, String(withUser.length));
  check(
    "and every one of them resolved to an address",
    withUser.every((i) => i.email !== null),
    withUser.filter((i) => i.email === null).map((i) => i.kind).join(", ") || "none missing",
  );
  check(
    "and it is the right one",
    withUser.every((i) => (i.userId === BASHIR ? i.email === BASHIR_EMAIL : i.email === ALICE_EMAIL)),
    JSON.stringify(withUser.map((i) => [i.userId?.slice(0, 4), i.email])),
  );
}

section("The count is the table; the rows are a sample of it");
{
  /*
    Thirty failures against a cap of twenty-five. The count has to be thirty or
    the page cannot tell an operator that it is not showing everything - and a
    screen that quietly shows twenty-five looks calm for the same reason a
    screen showing nothing does.
  */
  for (let i = 0; i < 30; i += 1) {
    await job(`att_many_${i}`, BASHIR, {
      status: "failed",
      error_detail: `failure number ${i}`,
      finished_at: new Date(Date.now() - i * 1000),
      updated_at: new Date(Date.now() - i * 1000),
    });
  }
  const out = await attention();
  check(
    "the count is every failure in the table",
    out.counts["render-failed"] === 31,
    String(out.counts["render-failed"]),
  );
  check(
    "and the rows are capped, so one noisy kind cannot bury a quiet one",
    out.items.filter((i) => i.kind === "render-failed").length === 25,
    String(out.items.filter((i) => i.kind === "render-failed").length),
  );
  await pool.query("DELETE FROM jobs WHERE id LIKE 'att_many_%'");
}

section("The other queue: posts, and the accounts they go to");
{
  await pool.query(
    `insert into social_accounts (id, user_id, platform, external_id, handle, access_token, status, status_detail)
     values ('att_sa_ok', $1, 'youtube', 'ext-1', '@fine', 'token', 'ok', null),
            ('att_sa_bad', $1, 'instagram', 'ext-2', '@thestudio', 'token', 'reauth', 'the platform refused the token')`,
    [ALICE],
  );
  await pool.query(
    `insert into scheduled_posts (id, user_id, project_id, account_id, platform, scheduled_for, status, updated_at)
     values ('att_p_late', $1, $2, 'att_sa_ok', 'youtube', now() - interval '2 hours', 'scheduled', now()),
            ('att_p_soon', $1, $2, 'att_sa_ok', 'youtube', now() + interval '30 minutes', 'scheduled', now()),
            ('att_p_stuck', $1, $2, 'att_sa_ok', 'youtube', now() - interval '3 hours', 'publishing', now() - interval '40 minutes')`,
    [ALICE, PROJECT],
  );
  const out = await attention();
  check("a post past its time is one row", out.counts["post-overdue"] === 1, JSON.stringify(out.counts));
  check(
    "a post due in half an hour is not a fault",
    !out.items.some((i) => i.postId === "att_p_soon"),
    out.items.map((i) => i.postId).filter(Boolean).join(", "),
  );
  check(
    "a post claimed by a publisher that never came back is its own kind",
    out.counts["post-stranded"] === 1 &&
      out.items.some((i) => i.kind === "post-stranded" && i.postId === "att_p_stuck"),
    JSON.stringify(out.counts),
  );
  check(
    "the overdue row names the platform, which is half of what to do about it",
    out.items.find((i) => i.kind === "post-overdue")?.platform === "youtube",
    String(out.items.find((i) => i.kind === "post-overdue")?.platform),
  );
  /*
    And the account whose token stopped working is one row, once, rather than
    one row per post that will fail as it comes due. Every post scheduled to it
    fails at its own moment, and seeing the cause beforehand is the difference.
  */
  const broken = out.items.find((i) => i.kind === "account-disconnected");
  check("a refused token is a row about the account", out.counts["account-disconnected"] === 1, JSON.stringify(out.counts));
  check(
    "and it names the handle, because that is the whole question",
    broken?.handle === "@thestudio",
    String(broken?.handle),
  );
  check(
    "the account that still works is not on the queue",
    !out.items.some((i) => i.handle === "@fine"),
    "",
  );
}

section("A payment that arrived and did nothing");
{
  await pool.query(
    `insert into billing_events (event_id, type, email, received_at, applied_at, outcome)
     values ('att_e_ok', 'subscription.created', $1, now(), now(), null),
            ('att_e_bad', 'subscription.created', 'stranger@attention.test', now(), null, 'no account for that email')`,
    [BASHIR_EMAIL],
  );
  const out = await attention();
  check(
    "an unapplied event is on the queue",
    out.counts["billing-unapplied"] === 1,
    JSON.stringify(out.counts),
  );
  const row = out.items.find((i) => i.kind === "billing-unapplied");
  check(
    "and carries the address that paid and the reason it did not land",
    row?.email === "stranger@attention.test" && row?.detail === "no account for that email",
    JSON.stringify(row ?? null),
  );
  check("an applied one is not", !out.items.some((i) => i.detail === "att_e_ok"), "");
}

section("Who is at their ceiling, counted across the table rather than a page");
{
  /*
    The accounts screen shows fifty rows ordered by when each was made, so this
    was a question it could not answer at all - and a sortable column there
    would have answered it from an arbitrary fifty.

    Alice is on free, five minutes a month. Six minutes of billed render is
    over; four is eighty per cent of it and not over.
  */
  await job("att_spend", ALICE, {
    status: "done",
    billed_seconds: 360,
    finished_at: new Date(),
  });
  let out = await attention();
  let over = out.items.find((i) => i.kind === "minutes-spent");
  check("an account past its allowance is a row", out.counts["minutes-spent"] === 1, JSON.stringify(out.counts));
  check(
    "and it carries both numbers, because one of them is not a conversation",
    over?.used === 6 && over?.included === 5,
    JSON.stringify([over?.used, over?.included]),
  );

  await pool.query("update jobs set billed_seconds = 240 where id = 'att_spend'");
  out = await attention();
  check(
    "at eighty per cent it is a warning rather than a fault",
    out.counts["minutes-spent"] === 0 && out.counts["minutes-nearly-spent"] === 1,
    JSON.stringify(out.counts),
  );
  check(
    "and a warning is not counted among the things that are broken",
    out.items.find((i) => i.kind === "minutes-nearly-spent")?.severity === "warning",
    String(out.items.find((i) => i.kind === "minutes-nearly-spent")?.severity),
  );

  await pool.query("update jobs set billed_seconds = 30 where id = 'att_spend'");
  out = await attention();
  check(
    "half a minute of a five minute plan is nobody's problem",
    out.counts["minutes-spent"] === 0 && out.counts["minutes-nearly-spent"] === 0,
    JSON.stringify(out.counts),
  );
}

section("Worst first, and the order is the order somebody would work in");
{
  await heartbeat(3600);
  const out = await attention();
  const order = out.items.map((i) => i.kind);
  const rank = [
    "worker-gone",
    "render-unattended",
    "post-overdue",
    "post-stranded",
    "billing-unapplied",
    "render-failed",
    "account-disconnected",
    "minutes-spent",
    "minutes-nearly-spent",
  ];
  const positions = order.map((kind) => rank.indexOf(kind));
  check(
    "no kind appears before a worse one",
    positions.every((n, i) => i === 0 || n >= positions[i - 1]),
    order.join(" > "),
  );
  /*
    And every row has every field, so a missing value is never an absent key.
    The console reads `item.used` on rows that have no cap and `item.handle` on
    rows that are not accounts, and `undefined` where `null` was meant is the
    difference between an empty cell and a screen that does not draw.
  */
  const shape = [
    "id", "kind", "severity", "at", "userId", "email",
    "jobId", "postId", "platform", "handle", "detail", "used", "included",
  ];
  check(
    "and every field is present on every row, even where it is null",
    out.items.every((item) => shape.every((key) => key in item)),
    JSON.stringify(out.items.find((item) => !shape.every((key) => key in item)) ?? null),
  );
  check(
    "and every id is unique, because the screen keys its rows on them",
    new Set(out.items.map((i) => i.id)).size === out.items.length,
    String(out.items.length),
  );
}

section("Nothing wrong is a different answer from nothing known");
{
  await reset();
  await heartbeat(10);
  const out = await attention();
  check("an idle healthy platform has an empty queue", out.items.length === 0, JSON.stringify(out.items));
  check(
    "and every count present and zero, rather than absent",
    Object.keys(out.counts).length === 9 &&
      Object.values(out.counts).every((n) => n === 0),
    JSON.stringify(out.counts),
  );
}

await reset();
await pool.end();

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log("the queue is not telling the truth about the platform");
  process.exit(1);
}
console.log("The queue lists what needs somebody, and counts what it is not showing.");
