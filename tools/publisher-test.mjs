/**
 * A post goes out once, or it does not go out.
 *
 * The render queue beside this one can afford to be optimistic: a job claimed
 * twice wastes a minute and produces the same file. This queue cannot. A post
 * sent twice is a second identical Reel on somebody's feed at 9pm, and there
 * is no API call that takes it back — the only person who can remove it is
 * them, and the only way they find out is by looking.
 *
 * So this suite is written from that asymmetry. Every check below is about the
 * publisher preferring to send nothing:
 *
 *   - two workers polling the same second must get disjoint sets
 *   - a row mid-flight must never be handed to a second worker
 *   - a post that is hours late must not be sent at all
 *   - and nothing may reach `published` while there is no way to publish
 *
 * The last one is the one worth a suite of its own. Writing `published` is one
 * line shorter than writing why it could not be sent, and a green tick over a
 * post that does not exist is the exact failure this codebase is organised
 * against.
 *
 * Usage: DATABASE_URL=postgres://... node tools/publisher-test.mjs
 * Requires: a Postgres with the production schema. No keys, no network.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { resolveTestDatabaseUrl } from "./lib/test-db.mjs";

const require = createRequire(import.meta.url);
const DATABASE_URL = await resolveTestDatabaseUrl();
process.env.DATABASE_URL = DATABASE_URL;

const { Client } = require(require.resolve("pg", { paths: ["lib/db"] }));

const sqlClient = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 3000 });
try {
  await sqlClient.connect();
} catch (error) {
  console.error(`\nNo database at ${DATABASE_URL}`);
  console.error(`  ${error.message}`);
  console.error(`  Bring one up, then: DATABASE_URL=... node tools/migrate.mjs\n`);
  process.exit(1);
}

const buildDir = await mkdtemp(path.join(tmpdir(), "editly-publisher-"));
const esbuild = require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/api-server"] });
const outfile = path.join(buildDir, "publisher.mjs");
const built = spawnSync(
  esbuild,
  [
    "artifacts/worker/src/publisher.ts",
    "--bundle", "--platform=node", "--format=esm", "--target=node22",
    `--outfile=${outfile}`, "--log-level=error",
    "--external:pg-native",
    // pg reaches for CommonJS globals from inside an ESM bundle, the same way
    // it does in the worker's own build. Same banner, same reason.
    "--banner:js=import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);",
  ],
  { stdio: "inherit" },
);
if (built.status !== 0) {
  console.error("could not bundle the publisher");
  process.exit(1);
}
const { claimDuePosts, refusalToSend, settle, publishDuePosts, surfaceStrandedPosts, TOO_LATE_MINUTES } =
  await import(pathToFileURL(outfile).href);

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

// ── Fixtures ────────────────────────────────────────────────────────────────
// Real rows in a real table, because every property under test is a property of
// a SQL statement. A fake would be testing the fake.

const USER = randomUUID();
const made = { accounts: [], posts: [] };

async function anAccount(over = {}) {
  const id = `acct_${randomUUID()}`;
  await sqlClient.query(
    `insert into social_accounts
       (id, user_id, platform, external_id, handle, access_token, status, status_detail)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      id, USER,
      over.platform ?? "x",
      randomUUID(),
      over.handle ?? "@someone",
      // Not a real token, and deliberately shaped like one: if any assertion
      // below can see this string, a credential reached a caller.
      "token-that-must-never-leave-the-process",
      over.status ?? "ok",
      over.statusDetail ?? null,
    ],
  );
  made.accounts.push(id);
  return id;
}

async function aPost(over = {}) {
  const id = `post_${randomUUID()}`;
  await sqlClient.query(
    `insert into scheduled_posts
       (id, user_id, project_id, account_id, platform, caption, hashtags, scheduled_for, status)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      id, USER,
      over.projectId ?? `proj_${randomUUID()}`,
      over.accountId,
      over.platform ?? "x",
      over.caption ?? "a caption",
      JSON.stringify(over.hashtags ?? []),
      over.scheduledFor ?? new Date(Date.now() - 60_000),
      over.status ?? "scheduled",
    ],
  );
  made.posts.push(id);
  return id;
}

const rowOf = async (id) =>
  (await sqlClient.query(`select * from scheduled_posts where id = $1`, [id])).rows[0];

// ── Claiming ────────────────────────────────────────────────────────────────
section("A due post is claimed exactly once");

{
  const account = await anAccount();
  const ids = [];
  for (let i = 0; i < 6; i += 1) {
    ids.push(await aPost({ accountId: account, scheduledFor: new Date(Date.now() - (i + 1) * 60_000) }));
  }

  // Two workers, same instant. This is the shape of the bug: both read the same
  // due rows, both post them.
  const [a, b] = await Promise.all([claimDuePosts(new Date(), 4), claimDuePosts(new Date(), 4)]);
  const all = [...a, ...b].map((p) => p.id);

  check("everything due was claimed", new Set(all).size === 6, `${all.length} rows, ${new Set(all).size} distinct`);
  check(
    "and no post was claimed by both workers",
    all.length === new Set(all).size,
    // If this fails the product posts twice, and nothing anywhere reports it.
    `${all.length} claims for ${new Set(all).size} posts`,
  );
  check(
    "the second worker was not made to wait behind the first",
    a.length > 0 && b.length > 0,
    `${a.length} and ${b.length} — SKIP LOCKED, not a queue`,
  );
  check(
    "oldest first, so a backlog drains in the order it was promised",
    a[0].scheduledFor <= a[a.length - 1].scheduledFor,
    a.map((p) => p.scheduledFor.toISOString()).join(" "),
  );

  const claimedRow = await rowOf(all[0]);
  check("a claimed row says it is being published", claimedRow.status === "publishing", claimedRow.status);
  check(
    "and its attempt count went up by one, as a number",
    claimedRow.attempts === 1,
    `${JSON.stringify(claimedRow.attempts)} (${typeof claimedRow.attempts})`,
  );

  check(
    "a third worker finds nothing left to take",
    (await claimDuePosts(new Date(), 10)).length === 0,
    "a row in flight must never be handed out again",
  );

  check(
    "the token never comes back with the post",
    !JSON.stringify(a).includes("token-that-must-never-leave-the-process"),
    "the claim joins social_accounts, which is where the credential lives",
  );
}

{
  const account = await anAccount();
  await aPost({ accountId: account, scheduledFor: new Date(Date.now() + 60 * 60_000) });
  check(
    "a post that is not due yet is left alone",
    (await claimDuePosts(new Date(), 10)).length === 0,
    "scheduling something for tomorrow must not send it today",
  );
}

{
  const account = await anAccount();
  const cancelled = await aPost({ accountId: account, status: "cancelled" });
  const published = await aPost({ accountId: account, status: "published" });
  const claimed = await claimDuePosts(new Date(), 10);
  check(
    "a cancelled post is never sent",
    !claimed.some((p) => p.id === cancelled),
    "somebody called it back, and calling it back has to mean something",
  );
  check("nor is one that already went", !claimed.some((p) => p.id === published), "");
}

// ── What it refuses to send ─────────────────────────────────────────────────
section("What it refuses to send, and says why");

{
  const now = new Date("2026-08-30T21:00:00Z");
  const base = {
    id: "p", userId: USER, projectId: "proj", exportId: null, accountId: "acct",
    platform: "x", caption: "hello", hashtags: [], attempts: 1,
    handle: "@someone", accountStatus: "ok", accountStatusDetail: null,
    scheduledFor: new Date("2026-08-30T20:58:00Z"),
  };

  check(
    "two minutes late is still on time enough to send",
    refusalToSend(base, now)?.kind !== "missed",
    JSON.stringify(refusalToSend(base, now)),
  );

  const veryLate = {
    ...base,
    scheduledFor: new Date(now.getTime() - (TOO_LATE_MINUTES + 5) * 60_000),
  };
  const missed = refusalToSend(veryLate, now);
  check("but hours late is not sent at all", missed?.kind === "missed", JSON.stringify(missed));
  check(
    "and the reason says how late it was and that nothing went out",
    /\b\d+ minutes late/.test(missed.reason) && /not sent/.test(missed.reason),
    missed.reason,
  );
  check(
    "without putting a machine timestamp in a sentence somebody reads",
    // The row above it already shows when the post was due, in the reader's
    // own timezone. An ISO string here is a second copy of that, in a shape
    // nobody reads.
    !/\d{4}-\d{2}-\d{2}T/.test(missed.reason),
    missed.reason,
  );
  check(
    "the person is told to schedule it again rather than left guessing",
    /schedule it again/i.test(missed.reason),
    missed.reason,
  );

  const gone = refusalToSend({ ...base, handle: null }, now);
  check("a post to an account that was disconnected fails", gone?.kind === "failed", JSON.stringify(gone));
  check(
    "and says so in words, not in a status code",
    /no longer connected/.test(gone.reason),
    gone.reason,
  );

  const stale = refusalToSend(
    { ...base, accountStatus: "expired", accountStatusDetail: "Reconnect X to keep posting." },
    now,
  );
  check("an expired token fails before anything is attempted", stale?.kind === "failed", "");
  check(
    "and the platform's own words are used when there are any",
    stale.reason === "Reconnect X to keep posting.",
    stale.reason,
  );

  // The one that matters most today: no platform is switched on, so nothing
  // can be sent, and the refusal must say that rather than inventing success.
  const off = refusalToSend(base, now);
  check("with no credentials, a sendable post is still refused", off?.kind === "failed", JSON.stringify(off));
  check("and told it was not posted", /Nothing was posted/.test(off.reason), off.reason);
}

// ── Settling ────────────────────────────────────────────────────────────────
section("Every claimed post leaves `publishing`");

{
  const account = await anAccount();
  const ids = [
    await aPost({ accountId: account }),
    await aPost({ accountId: account, scheduledFor: new Date(Date.now() - 5 * 60 * 60_000) }),
  ];

  const summary = await publishDuePosts(new Date());
  check("both were claimed", summary.claimed === 2, JSON.stringify(summary));
  check(
    "nothing was reported as published, because nothing can be",
    summary.published === 0,
    JSON.stringify(summary),
  );
  check("the late one was recorded as missed", summary.missed === 1, JSON.stringify(summary));

  const rows = await Promise.all(ids.map(rowOf));
  check(
    "no row is left mid-flight",
    rows.every((r) => r.status !== "publishing"),
    rows.map((r) => r.status).join(", "),
  );
  check(
    "no row claims to have been published",
    rows.every((r) => r.status !== "published" && r.published_at === null),
    rows.map((r) => `${r.status}/${r.published_at}`).join(", "),
  );
  check(
    "each carries a sentence rather than a slug",
    rows.every((r) => typeof r.error === "string" && / /.test(r.error) && r.error.length > 30),
    rows.map((r) => r.error).join(" | "),
  );

  const before = await rowOf(ids[0]);
  await settle(ids[0], { kind: "published", externalPostId: "1234", externalUrl: "https://x.com/p/1234" });
  const after = await rowOf(ids[0]);
  check("a published post clears the error it carried", after.error === null, String(before.error));
  check("and keeps the link, so the person can go and look", after.external_url === "https://x.com/p/1234", "");
  check("and records when", after.published_at instanceof Date, String(after.published_at));
}

// ── Stranded ────────────────────────────────────────────────────────────────
section("A post the publisher died holding is surfaced, never retried");

{
  const account = await anAccount();
  const fresh = await aPost({ accountId: account, status: "publishing" });
  const old = await aPost({ accountId: account, status: "publishing" });
  await sqlClient.query(
    `update scheduled_posts set updated_at = now() - interval '2 hours' where id = $1`,
    [old],
  );

  /*
    Counted as "did this row move", not "how many rows moved".

    `surfaceStrandedPosts` sweeps the whole table, and a previous run of this
    file leaves its own `publishing` rows behind. Fifteen minutes later those
    rows are strandable too, so `surfaced === 1` is green when the file is run
    once and red when it is run twice in an afternoon — a test that fails for a
    reason that has nothing to do with the code it is about. The claim being
    made here is about this row.
  */
  const surfaced = await surfaceStrandedPosts(15);
  check("something was surfaced", surfaced >= 1, `${surfaced}`);
  check("the old one is one of them", (await rowOf(old)).status !== "publishing", `${surfaced}`);
  check(
    "and it is not put back in the queue",
    (await rowOf(old)).status === "failed",
    // A render is requeued because rendering twice is free. This row may
    // already be a post on somebody's feed.
    (await rowOf(old)).status,
  );
  check(
    "the reason admits the uncertainty instead of guessing",
    /not known whether it went out/.test((await rowOf(old)).error),
    (await rowOf(old)).error,
  );
  check(
    "a post claimed a second ago is left to finish",
    (await rowOf(fresh)).status === "publishing",
    (await rowOf(fresh)).status,
  );
}

// ── How often it asks ───────────────────────────────────────────────────────
section("The sweep does not run on every poll of the render loop");
{
  const worker = readFileSync(path.join(process.cwd(), "artifacts/worker/src/index.ts"), "utf8");

  /*
    The render loop polls every five seconds. Hanging both halves of the
    scheduled-post sweep off it is twenty-four queries a minute, forever,
    against a table that is empty — on a database whose plan is counted in
    connections and rows read.

    Read out of the source rather than measured, because measuring it means
    running a worker for a minute to count queries, and what is worth
    protecting here is the *decision*: that somebody who adds a third sweep
    later finds this rule sitting next to the two that already obey it.
  */
  check(
    "the due sweep has an interval of its own",
    /DUE_SWEEP_EVERY_MS\s*=\s*[\d_]+/.test(worker),
    "",
  );
  check(
    "and the stranded sweep a longer one, because it looks for rows fifteen minutes old",
    (() => {
      const due = Number((worker.match(/DUE_SWEEP_EVERY_MS\s*=\s*([\d_]+)/) ?? [])[1]?.replace(/_/g, ""));
      const stranded = worker.match(/STRANDED_SWEEP_EVERY_MS\s*=\s*([^;]+);/)?.[1] ?? "";
      const strandedMs = Function(`return ${stranded.replace(/_/g, "")}`)();
      return Number.isFinite(due) && Number.isFinite(strandedMs) && strandedMs > due * 4;
    })(),
    "",
  );
  check(
    "and both are actually consulted before anything is asked of the database",
    /if \(now - lastDueSweep < DUE_SWEEP_EVERY_MS\) return;/.test(worker) &&
      /if \(now - lastStrandedSweep >= STRANDED_SWEEP_EVERY_MS\)/.test(worker),
    // A constant nothing reads is a comment with a semicolon after it.
    "",
  );
}

// ── Clean up ────────────────────────────────────────────────────────────────
await sqlClient.query(`delete from scheduled_posts where user_id = $1`, [USER]);
await sqlClient.query(`delete from social_accounts where user_id = $1`, [USER]);
await sqlClient.end();
await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("A post goes out once, or it does not go out.");
