/**
 * Proves that one signed-in user cannot see or touch another user's data.
 *
 * This exercises the *real* auth middleware: it spins up a local JWKS endpoint,
 * signs genuine ES256 tokens against it, and points SUPABASE_URL at it. So
 * signature verification, issuer/audience checks, ownership filters and quota
 * counting are all the production code path — nothing is stubbed out.
 *
 * Requires a local Postgres matching the production schema.
 * Usage: node tools/isolation-test.mjs
 */
import http from "node:http";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { resolveTestDatabaseUrl } from "./lib/test-db.mjs";

const require = createRequire(import.meta.url);

// jose is a dependency of the API server, not of this repo's root, so it is
// resolved from there rather than assumed to be hoisted.
const { generateKeyPair, exportJWK, SignJWT } = await import(
  pathToFileURL(require.resolve("jose", { paths: ["artifacts/api-server"] })).href
);

const JWKS_PORT = 4022;
const API_PORT = 4021;
const BASE = `http://127.0.0.1:${API_PORT}`;
const ISSUER_BASE = `http://127.0.0.1:${JWKS_PORT}`;

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";

// ── Stand in for Supabase's JWKS endpoint ────────────────────────────────────
const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
const jwk = { ...(await exportJWK(publicKey)), alg: "ES256", use: "sig", kid: "test-key" };

/**
 * The same stub also stands in for Storage, because deleting a project now
 * depends on it.
 *
 * Reclaiming a project's bytes used to be best-effort with its answer thrown
 * away, so the route returned 204 whatever happened — including on a deployment
 * with no service role key, where nothing was deleted at all. It now refuses
 * rather than confirm something untrue, which means these tests have to give it
 * a Storage that works, and can then assert the order: bytes before rows.
 */
const storageCalls = [];
let storageFailsWith = null;
// Copy fails on its own switch: a deployment whose delete works and whose
// copy does not is exactly the case the promote route has to survive.
let storageCopyFailsWith = null;
/**
 * Fail only the copies whose destination contains this.
 *
 * `storageCopyFailsWith` fails every copy, which means the *first* one fails
 * and the whole request is refused — a real case, and not the one below. A
 * poster is a nicety: its copy failing must leave the project open and the
 * column empty, and telling that apart from the master failing needs a stub
 * that can fail one and not the other.
 */
let storageCopyFailsFor = null;
// The bucket the stub pretends to be, now stateful: list answers a page of
// what is actually under the prefix and delete removes the named keys. The
// sweep in storage.ts drains pages until the prefix answers empty, so a stub
// that answered the same one object forever would spin it to its pass cap. A
// prefix nobody seeded gets one source.mp4 on first sight — which is exactly
// what the old always-one-object stub gave every project.
const storageObjects = new Set();
const storageSeeded = new Set();
let storageDeleteIsALie = false;

const jwksServer = http.createServer((req, res) => {
  if (req.url === "/auth/v1/.well-known/jwks.json") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ keys: [jwk] }));
    return;
  }
  if (req.url?.startsWith("/storage/v1/object/list/")) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = (() => {
        try {
          return JSON.parse(body);
        } catch {
          return {};
        }
      })();
      const prefix = parsed.prefix ?? null;
      storageCalls.push({ op: "list", prefix });
      if (prefix && !storageSeeded.has(prefix)) {
        storageSeeded.add(prefix);
        storageObjects.add(`${prefix}/source.mp4`);
      }
      if (storageFailsWith) return res.writeHead(storageFailsWith).end("{}");
      const limit = typeof parsed.limit === "number" ? parsed.limit : 100;
      const page = [...storageObjects]
        .filter((k) => prefix && k.startsWith(`${prefix}/`))
        .slice(0, limit)
        .map((k) => ({ name: k.slice(prefix.length + 1), id: k }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(page));
    });
    return;
  }
  if (req.method === "POST" && req.url === "/storage/v1/object/copy") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = (() => {
        try {
          return JSON.parse(body);
        } catch {
          return {};
        }
      })();
      storageCalls.push({ op: "copy", from: parsed.sourceKey ?? null, to: parsed.destinationKey ?? null });
      if (storageCopyFailsWith) return res.writeHead(storageCopyFailsWith).end("{}");
      if (storageCopyFailsFor && String(parsed.destinationKey ?? "").includes(storageCopyFailsFor)) {
        return res.writeHead(500).end("{}");
      }
      if (parsed.destinationKey) storageObjects.add(parsed.destinationKey);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ Key: parsed.destinationKey }));
    });
    return;
  }
  if (req.method === "DELETE" && req.url === "/storage/v1/object/videos") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      storageCalls.push({ op: "delete", body });
      if (storageFailsWith) return res.writeHead(storageFailsWith).end("{}");
      if (!storageDeleteIsALie) {
        try {
          for (const k of JSON.parse(body).prefixes ?? []) storageObjects.delete(k);
        } catch {
          // an unparsable body removes nothing, exactly like the real endpoint
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" }).end("[]");
    });
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => jwksServer.listen(JWKS_PORT, r));

// The middleware reads SUPABASE_URL at import time, and build-vercel.mjs bakes
// that value into the bundle. So the bundle has to be rebuilt pointing at the
// local JWKS above — otherwise every request here is checked against the real
// Supabase project and fails as unauthorised.
process.env.SUPABASE_URL = ISSUER_BASE;
// Present, so `storageAdminConfigured` is true and the delete path is the one
// production actually runs. The stub above answers for it.
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-for-tests";
// The webhook is the only endpoint here that grants a paid plan, and it refuses
// to act at all without a secret. Configured so the checks below drive the real
// route rather than its 503.
const FREEMIUS_SECRET = "webhook-secret-for-tests";
process.env.FREEMIUS_SECRET_KEY = FREEMIUS_SECRET;
process.env.FREEMIUS_PLAN_MAP = "9001:creator,9002:pro,9003:studio";
process.env.FREEMIUS_PRODUCT_ID = "36845";
process.env.FREEMIUS_PUBLIC_KEY = "pk_test_public_value";
await resolveTestDatabaseUrl();
// The admin console's allowlist. Set before the bundle is required, because
// `lib/admin.ts` reads it once at import — which is the property under test as
// much as the routing is: an allowlist that can be re-read mid-process is an
// allowlist somebody can race. Alice is an admin here and Bob is not, so every
// check below is the difference between two real signed-in users rather than
// between a user and nobody.
process.env.ADMIN_USER_IDS = ALICE;

console.log("Rebuilding the API bundle against the local test issuer...");
const buildResult = spawnSync(
  process.execPath,
  ["artifacts/api-server/build-vercel.mjs"],
  {
    stdio: ["ignore", "ignore", "inherit"],
    env: {
      ...process.env,
      SUPABASE_URL: ISSUER_BASE,
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key-for-tests",
      FREEMIUS_SECRET_KEY: FREEMIUS_SECRET,
      FREEMIUS_PLAN_MAP: "9001:creator,9002:pro,9003:studio",
    },
  },
);
if (buildResult.status !== 0) {
  console.error("Bundle build failed; cannot run the isolation test.");
  process.exit(1);
}

async function tokenFor(userId, overrides = {}) {
  return new SignJWT({ role: "authenticated", ...overrides })
    .setProtectedHeader({ alg: "ES256", kid: "test-key" })
    .setSubject(userId)
    .setIssuer(`${ISSUER_BASE}/auth/v1`)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
}

const bundle = require("../api/_bundle.js");
const app = bundle.default || bundle;
const server = http.createServer(app);
await new Promise((r) => server.listen(API_PORT, r));

const tokens = { [ALICE]: await tokenFor(ALICE), [BOB]: await tokenFor(BOB) };

let failures = 0;
let checks = 0;

function check(name, condition, detail = "") {
  checks += 1;
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/**
 * Rows this file inserts directly, which nothing in the API can remove.
 *
 * They have to be swept before the run rather than only after it, because the
 * whole point of some of them is to put minutes on Bob's meter — and a leftover
 * pair from an interrupted run puts a free account over its allowance before
 * the first check has executed, which then refuses the project creation four
 * unrelated checks depend on. That is a suite that passes exactly once per
 * database and fails ever after with errors that point at the wrong thing.
 */
/** One-line SQL against the test database, for setup and cleanup only. */
function psqlGlobal(sql) {
  spawnSync("psql", [process.env.DATABASE_URL, "-c", sql], { encoding: "utf8" });
}

const SEEDED_JOBS = ["meter-test-job", "cascade-test-job"];
function sweepSeededJobs() {
  spawnSync(
    "psql",
    [process.env.DATABASE_URL, "-c", `delete from jobs where id in (${SEEDED_JOBS.map((id) => `'${id}'`).join(",")})`],
    { encoding: "utf8" },
  );
}
sweepSeededJobs();

/**
 * Grants this file makes, which nothing in the API can take back.
 *
 * A grant is deliberately permanent — the audit log is not editable, and that
 * is the point of it. Which means this suite would hand Bob another 25 minutes
 * every run and slowly drift the numbers the allowance checks depend on. The
 * checks are written as deltas so they survive that, and this sweeps anyway so
 * the database does not accumulate a test's leavings forever.
 */
/** One-line SQL that returns its output, for asserting on what was written. */
function psqlGlobalRead(query) {
  return spawnSync("psql", [process.env.DATABASE_URL, "-tAc", query], { encoding: "utf8" }).stdout ?? "";
}

function sweepSeededUsers() {
  spawnSync(
    "psql",
    [process.env.DATABASE_URL, "-c", `delete from auth.users where id in ('${ALICE}','${BOB}')`],
    { encoding: "utf8" },
  );
}

function sweepSeededGrants() {
  spawnSync(
    "psql",
    [
      process.env.DATABASE_URL,
      "-c",
      `delete from admin_actions where actor_user_id = '${ALICE}' or subject_user_id in ('${ALICE}','${BOB}')`,
    ],
    { encoding: "utf8" },
  );
}
sweepSeededGrants();
sweepSeededUsers();

async function call(user, path, method = "GET", body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${tokens[user]}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON error page */
  }
  // The headers come back too: `Content-Disposition` on the data export and
  // `x-request-id` on everything are both properties worth asserting, and a
  // helper that discards them makes them unassertable.
  return { status: res.status, json, text, headers: res.headers };
}

console.log("\nToken enforcement");
{
  const none = await fetch(`${BASE}/api/projects`);
  check("no token is rejected", none.status === 401, `got ${none.status}`);

  const garbage = await fetch(`${BASE}/api/projects`, {
    headers: { Authorization: "Bearer not-a-jwt" },
  });
  check("malformed token is rejected", garbage.status === 401, `got ${garbage.status}`);

  // Signed correctly, but by a key the JWKS endpoint does not publish.
  const { privateKey: rogueKey } = await generateKeyPair("ES256", { extractable: true });
  const forged = await new SignJWT({ role: "authenticated" })
    .setProtectedHeader({ alg: "ES256", kid: "test-key" })
    .setSubject(ALICE)
    .setIssuer(`${ISSUER_BASE}/auth/v1`)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(rogueKey);
  const forgedRes = await fetch(`${BASE}/api/projects`, {
    headers: { Authorization: `Bearer ${forged}` },
  });
  check("token signed by an unknown key is rejected", forgedRes.status === 401, `got ${forgedRes.status}`);

  const expired = await new SignJWT({ role: "authenticated" })
    .setProtectedHeader({ alg: "ES256", kid: "test-key" })
    .setSubject(ALICE)
    .setIssuer(`${ISSUER_BASE}/auth/v1`)
    .setAudience("authenticated")
    .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
    .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
    .sign(privateKey);
  const expiredRes = await fetch(`${BASE}/api/projects`, {
    headers: { Authorization: `Bearer ${expired}` },
  });
  check("expired token is rejected", expiredRes.status === 401, `got ${expiredRes.status}`);

  // The health check is the one route with no token, and it has to stay that
  // way — a monitor cannot hold a session. What it must not do is leak: it
  // reports the shape of the schema, never a row, never a user.
  const health = await fetch(`${BASE}/api/healthz`);
  const healthBody = await health.json();
  check("health check needs no token", health.status !== 401 && health.status !== 403, `got ${health.status}`);
  check("and against this database it is healthy", health.status === 200, `got ${health.status} ${JSON.stringify(healthBody)}`);
  check("it says which database state it is in", healthBody?.status === "ok", JSON.stringify(healthBody));
  check("nothing missing", healthBody?.database?.missingColumns?.length === 0, JSON.stringify(healthBody));
  check(
    "and it discloses no data — column names only, no rows, no ids",
    !/[0-9a-f]{8}-[0-9a-f]{4}/.test(JSON.stringify(healthBody)),
    JSON.stringify(healthBody),
  );
  // Whether the console's allowlist reached this deployment. It says yes here
  // because this suite sets ADMIN_USER_IDS before the bundle is required — and
  // the check below proves it is a boolean and not the list, because the one
  // above would catch a uuid but not a count, and a count is still more than
  // this endpoint has any business saying.
  check("it says whether an admin allowlist reached this deployment", healthBody?.capabilities?.admins === true, JSON.stringify(healthBody?.capabilities));
  check(
    "as a yes or no, never a number and never a name",
    typeof healthBody?.capabilities?.admins === "boolean",
    JSON.stringify(healthBody?.capabilities?.admins),
  );

  /*
    And whether the storage credential actually authenticates.

    Not "is a variable set" — that is the field beside it. This one performs a
    real listing against the store and reports `ok`, `unauthorized` or
    `unreachable`, and it is asserted here because its failure mode is the
    silent kind: the probe lists a prefix, the shared key rule requires a
    segment to begin with a letter or a digit, and a prefix that does not —
    `__healthcheck__`, say — is refused before a request is ever made. The page
    would then read `unreachable` forever, on a deployment where storage is
    perfectly fine, and nothing would fail.
  */
  check(
    "it says whether the storage credential actually works",
    healthBody?.capabilities?.storageCheck === "ok",
    JSON.stringify(healthBody?.capabilities?.storageCheck),
  );
  check(
    "having asked storage rather than reading an environment variable",
    storageCalls.some((c) => c.op === "list" && c.prefix !== null),
    JSON.stringify(storageCalls.slice(0, 3)),
  );

  /**
   * And whether a machine that can render is listening.
   *
   * Everything else on this endpoint describes the API. This describes the
   * product: with no worker beating, every render queues and none starts, and
   * the API keeps answering 200 because nothing is wrong with the API. That is
   * the shape of the 12 August outage, which ran two days because the only
   * thing that would have noticed was somebody choosing to look.
   *
   * Asserted in both directions from a seeded heartbeat, because a field that
   * is always true is not a monitor — it is a decoration that will read "fine"
   * on the day it matters.
   */
  psqlGlobal(`delete from worker_heartbeats where worker_id like 'health-test-%'`);
  psqlGlobal(
    `insert into worker_heartbeats (worker_id, last_seen_at) values ('health-test-live', now())`,
  );
  // `newestWorkerSeenAt` caches for ten seconds so that a progress poll cannot
  // become a second database round trip. That cache is shorter than the two
  // minutes that decide online from offline, so it can never change a verdict —
  // but it is longer than the gap between two lines of a test, so the wait is
  // here rather than the cache being weakened for the suite's convenience.
  const PAST_THE_CACHE = 11_000;
  await new Promise((done) => setTimeout(done, PAST_THE_CACHE));
  const live = await (await fetch(`${BASE}/api/healthz`)).json();
  check("it says a render machine is listening", live?.worker?.online === true, JSON.stringify(live?.worker));
  check(
    "and how long ago it last said so",
    typeof live?.worker?.lastSeenAgoSeconds === "number" && live.worker.lastSeenAgoSeconds < 120,
    JSON.stringify(live?.worker),
  );

  // Ten minutes of silence. The worker is declared gone after two, so this is
  // the outage, reproduced.
  psqlGlobal(`update worker_heartbeats set last_seen_at = now() - interval '10 minutes'`);
  await new Promise((done) => setTimeout(done, PAST_THE_CACHE));
  const silent = await (await fetch(`${BASE}/api/healthz`)).json();
  check(
    "and says so when nothing has beaten for ten minutes",
    silent?.worker?.online === false,
    JSON.stringify(silent?.worker),
  );
  check(
    "with the age, because a machine that stopped and one that was never there are different problems",
    typeof silent?.worker?.lastSeenAgoSeconds === "number" && silent.worker.lastSeenAgoSeconds > 300,
    JSON.stringify(silent?.worker),
  );
  check(
    "while the API itself is still reported as fine, because it is",
    silent?.status === "ok",
    JSON.stringify(silent?.status),
  );
  psqlGlobal(`delete from worker_heartbeats where worker_id like 'health-test-%'`);
}

console.log("\nOwnership isolation");
let aliceProjectId;
{
  const created = await call(ALICE, "/api/projects", "POST", { title: "Alice private" });
  check("Alice can create a project", created.status === 201, `got ${created.status} ${created.text.slice(0, 80)}`);
  aliceProjectId = created.json?.id;

  const bobList = await call(BOB, "/api/projects");
  check(
    "Bob's list excludes Alice's project",
    bobList.status === 200 && !JSON.stringify(bobList.json ?? []).includes(aliceProjectId),
    JSON.stringify(bobList.json),
  );

  const reads = await call(BOB, `/api/projects/${aliceProjectId}`);
  check("Bob cannot read Alice's project", reads.status === 404, `got ${reads.status}`);

  const patch = await call(BOB, `/api/projects/${aliceProjectId}`, "PATCH", { title: "hijacked" });
  check("Bob cannot rename Alice's project", patch.status === 404, `got ${patch.status}`);

  const del = await call(BOB, `/api/projects/${aliceProjectId}`, "DELETE");
  check("Bob cannot delete Alice's project", del.status === 404, `got ${del.status}`);

  const survived = await call(ALICE, `/api/projects/${aliceProjectId}`);
  check(
    "Alice's project is intact and unrenamed",
    survived.status === 200 && survived.json?.title === "Alice private",
    JSON.stringify(survived.json),
  );

  const inject = await call(BOB, `/api/projects/${aliceProjectId}/messages`, "POST", { content: "inject" });
  check("Bob cannot post into Alice's chat", inject.status === 404, `got ${inject.status}`);

  await call(ALICE, `/api/projects/${aliceProjectId}/messages`, "POST", { content: "add captions" });
  const peek = await call(BOB, `/api/projects/${aliceProjectId}/messages`);
  check(
    "Bob cannot read Alice's messages",
    peek.status === 200 && Array.isArray(peek.json) && peek.json.length === 0,
    JSON.stringify(peek.json),
  );

  const exp = await call(BOB, `/api/projects/${aliceProjectId}/export`, "POST", { platform: "tiktok" });
  check("Bob cannot export Alice's project", exp.status === 404, `got ${exp.status}`);

  const expStatus = await call(BOB, `/api/projects/${aliceProjectId}/export/status`);
  check("Bob cannot poll Alice's export status", expStatus.status === 404, `got ${expStatus.status}`);
}

console.log("\nClips are the owner's, and their paths reach only the owner");
{
  // A clip row as the worker would write it. Through psql, because the worker
  // writes as the table owner and there is no client route for creating one —
  // that is the point of the read-only endpoint.
  psqlGlobal(`
    INSERT INTO clips (id, project_id, user_id, job_id, idx, start_seconds, end_seconds, output_path, output_seconds, note, thumbnail_path)
    VALUES ('clip-iso-1', '${aliceProjectId}', '${ALICE}', 'job-iso-1', 1, 2, 7,
            '${ALICE}/${aliceProjectId}/clip-job-iso-1-1.mp4', 5, 'the speech runs densest here',
            '${ALICE}/${aliceProjectId}/clip-job-iso-1-1.jpg')`);

  const mine = await call(ALICE, `/api/projects/${aliceProjectId}/clips`);
  check("Alice sees her clip", mine.status === 200 && mine.json?.length === 1, `got ${mine.status} ${mine.text.slice(0, 120)}`);
  check(
    "with the storage path she needs to sign her own playback URL",
    mine.json?.[0]?.outputPath === `${ALICE}/${aliceProjectId}/clip-job-iso-1-1.mp4`,
    JSON.stringify(mine.json?.[0]),
  );
  check(
    "and the stretch it came from",
    mine.json?.[0]?.startSeconds === 2 && mine.json?.[0]?.endSeconds === 7,
    JSON.stringify(mine.json?.[0]),
  );
  check(
    "and the still the panel shows instead of loading the video",
    mine.json?.[0]?.thumbnailPath === `${ALICE}/${aliceProjectId}/clip-job-iso-1-1.jpg`,
    JSON.stringify(mine.json?.[0]?.thumbnailPath),
  );

  const theirs = await call(BOB, `/api/projects/${aliceProjectId}/clips`);
  check(
    "Bob gets the same 404 whether the project exists or not",
    theirs.status === 404,
    `got ${theirs.status}`,
  );

  // Bob cannot delete what he cannot see — and learns nothing from trying.
  const theft = await call(BOB, `/api/projects/${aliceProjectId}/clips/clip-iso-1`, "DELETE");
  check("Bob cannot delete Alice's clip", theft.status === 404, `got ${theft.status}`);
  const survived = await call(ALICE, `/api/projects/${aliceProjectId}/clips`);
  check("and it is still there for Alice", survived.json?.length === 1, JSON.stringify(survived.json));

  // ── Opening a clip as its own project ───────────────────────────────────
  //
  // A clip stops being a dead end here: the bytes are copied into a project
  // of its own, so the piece can be edited like any other upload. What these
  // check is that the copy really is a copy (two prefixes, not one shared
  // file), that a failure leaves nothing behind, and that Bob still cannot.
  {
    const stolen = await call(BOB, `/api/projects/${aliceProjectId}/clips/clip-iso-1/open`, "POST");
    check("Bob cannot open Alice's clip as a project", stolen.status === 404, `got ${stolen.status}`);

    const copyMark = storageCalls.length;
    const opened = await call(ALICE, `/api/projects/${aliceProjectId}/clips/clip-iso-1/open`, "POST");
    check("Alice opens her clip as a project", opened.status === 201, `got ${opened.status} ${opened.text.slice(0, 200)}`);
    const born = opened.json?.id;
    check("which is a new project, not the one it came from", Boolean(born) && born !== aliceProjectId, String(born));
    check(
      "its source is its own copy, under its own prefix",
      opened.json?.videoPath === `${ALICE}/${born}/source.mp4`,
      JSON.stringify(opened.json?.videoPath),
    );
    check("and it is ready to edit, not stuck uploading", opened.json?.status === "ready", String(opened.json?.status));
    check("carrying the clip's length", opened.json?.duration === 5, String(opened.json?.duration));
    check(
      "and named after the clip it came from, since this one had no words",
      typeof opened.json?.title === "string" && /clip 1$/.test(opened.json.title),
      String(opened.json?.title),
    );

    const copies = storageCalls.slice(copyMark).filter((c) => c.op === "copy");
    check(
      "storage was asked to copy the master into the new project",
      copies.some((c) => c.from === `${ALICE}/${aliceProjectId}/clip-job-iso-1-1.mp4` && c.to === `${ALICE}/${born}/source.mp4`),
      JSON.stringify(copies),
    );
    /**
     * The poster is in the answer, not on its way to being.
     *
     * This check used to sleep 300ms first, and the sleep was the tell: the row
     * named `thumbnail_path` before the copy had happened and whether or not it
     * succeeded. A row that names a file which is not there is a card with a
     * broken image on it and nothing anywhere that would notice — so the copy is
     * awaited now, and the assertion needs no wait at all.
     */
    check(
      "the clip's still becomes the new project's poster",
      opened.json?.thumbnailPath === `${ALICE}/${born}/thumb.jpg`,
      JSON.stringify(opened.json?.thumbnailPath),
    );
    // The mirror stays fire-and-forget, and correctly so: no row names it, the
    // player derives the name by convention and falls back when it is missing.
    // So this one is waited *for* rather than slept through.
    const mirrored = await (async () => {
      const until = Date.now() + 3000;
      for (;;) {
        const seen = storageCalls.slice(copyMark).some((c) => c.op === "copy" && String(c.to).endsWith("/source.preview.webm"));
        if (seen || Date.now() > until) return seen;
        await new Promise((r) => setTimeout(r, 100));
      }
    })();
    check(
      "with the preview mirror behind it, for browsers that cannot decode H.264",
      mirrored,
      JSON.stringify(storageCalls.slice(copyMark).filter((c) => c.op === "copy")),
    );

    // The clip is a source, not a sacrifice: nothing about it or its project
    // changes when a copy of it goes somewhere else.
    const stillThere = await call(ALICE, `/api/projects/${aliceProjectId}/clips`);
    check("the clip itself is untouched", stillThere.json?.length === 1, JSON.stringify(stillThere.json));

    const bobsView = await call(BOB, `/api/projects/${born}`);
    check("and the new project is Alice's alone", bobsView.status === 404, `got ${bobsView.status}`);

    /**
     * And a poster that could not be copied is not claimed.
     *
     * The master failing refuses the whole request, above. A poster is a
     * nicety — a card with a grey box is a smaller loss than refusing to open
     * the clip at all — so the project still opens. What it must never do is
     * name a file that is not there, which is a broken image and no way to
     * notice.
     */
    storageCopyFailsFor = "/thumb.jpg";
    const noPoster = await call(ALICE, `/api/projects/${aliceProjectId}/clips/clip-iso-1/open`, "POST");
    storageCopyFailsFor = null;
    check("a clip whose still cannot be copied still opens", noPoster.status === 201, `got ${noPoster.status}`);
    check(
      "and says it has no poster rather than naming one that is not there",
      noPoster.json?.thumbnailPath === null,
      JSON.stringify(noPoster.json?.thumbnailPath),
    );
    check(
      "while its video is its own copy all the same",
      noPoster.json?.videoPath === `${ALICE}/${noPoster.json?.id}/source.mp4`,
      JSON.stringify(noPoster.json?.videoPath),
    );
    await call(ALICE, `/api/projects/${noPoster.json?.id}`, "DELETE");

    // A deployment whose copy fails must not leave a project pointing at a
    // file that was never written.
    const countBefore = (await call(ALICE, "/api/projects")).json?.length ?? -1;
    storageCopyFailsWith = 500;
    const refused = await call(ALICE, `/api/projects/${aliceProjectId}/clips/clip-iso-1/open`, "POST");
    storageCopyFailsWith = null;
    check("a copy that fails is refused, not half-answered", refused.status === 503, `got ${refused.status}`);
    const countAfter = (await call(ALICE, "/api/projects")).json?.length ?? -2;
    check("and takes its own project row back with it", countAfter === countBefore, `${countBefore} → ${countAfter}`);
  }

  // The owner can, and the row goes with the request for the files.
  const before = storageCalls.length;
  const gone = await call(ALICE, `/api/projects/${aliceProjectId}/clips/clip-iso-1`, "DELETE");
  check("Alice deletes her clip", gone.status === 204, `got ${gone.status}`);
  const after = await call(ALICE, `/api/projects/${aliceProjectId}/clips`);
  check("and the row is gone on the next read", after.json?.length === 0, JSON.stringify(after.json));
  await new Promise((r) => setTimeout(r, 300));
  const asked = storageCalls
    .slice(before)
    .some((c) => c.op === "delete" && String(c.body).includes("clip-job-iso-1-1.mp4"));
  check("and storage was asked for the master by name", asked, JSON.stringify(storageCalls.slice(before)));
  check(
    "with its preview mirror beside it",
    storageCalls.slice(before).some((c) => String(c.body).includes("clip-job-iso-1-1.preview.webm")),
    JSON.stringify(storageCalls.slice(before)),
  );
  check(
    "and its still, so nothing of the clip is left behind",
    storageCalls.slice(before).some((c) => String(c.body).includes("clip-job-iso-1-1.jpg")),
    JSON.stringify(storageCalls.slice(before)),
  );

  const again = await call(ALICE, `/api/projects/${aliceProjectId}/clips/clip-iso-1`, "DELETE");
  check("deleting it twice is a 404, not a crash", again.status === 404, `got ${again.status}`);
}

console.log("\nClip dimensions");
{
  // The player is shaped from these before a frame has decoded, so if they do
  // not survive the round trip a vertical clip goes back to being letterboxed
  // into a landscape box — the exact bug they were added to fix.
  const set = await call(ALICE, `/api/projects/${aliceProjectId}`, "PATCH", {
    width: 1080,
    height: 1920,
    duration: 42.5,
  });
  check("the browser's measurements are accepted", set.status === 200, `got ${set.status} ${set.text.slice(0, 120)}`);
  check(
    "and come back unchanged",
    set.json?.width === 1080 && set.json?.height === 1920,
    JSON.stringify({ width: set.json?.width, height: set.json?.height }),
  );

  const reread = await call(ALICE, `/api/projects/${aliceProjectId}`);
  check(
    "they are still there on a fresh read",
    reread.json?.width === 1080 && reread.json?.height === 1920,
    JSON.stringify({ width: reread.json?.width, height: reread.json?.height }),
  );

  const nonsense = await call(ALICE, `/api/projects/${aliceProjectId}`, "PATCH", { width: -4 });
  check("a negative width is refused", nonsense.status === 400, `got ${nonsense.status}`);

  const fractional = await call(ALICE, `/api/projects/${aliceProjectId}`, "PATCH", { height: 12.5 });
  check("so is a fractional height", fractional.status === 400, `got ${fractional.status}`);
}

console.log("\nStorage path ownership");
{
  const good = await call(ALICE, `/api/projects/${aliceProjectId}`, "PATCH", {
    videoPath: `${ALICE}/${aliceProjectId}/source.mp4`,
  });
  check("owner can record a key inside their own folder", good.status === 200, `got ${good.status} ${good.text.slice(0, 100)}`);
  check(
    "the key is stored verbatim",
    good.json?.videoPath === `${ALICE}/${aliceProjectId}/source.mp4`,
    JSON.stringify(good.json?.videoPath),
  );

  const otherUser = await call(ALICE, `/api/projects/${aliceProjectId}`, "PATCH", {
    videoPath: `${BOB}/${aliceProjectId}/source.mp4`,
  });
  check("a key in another user's folder is refused", otherUser.status === 400, `got ${otherUser.status}`);

  const otherProject = await call(ALICE, `/api/projects/${aliceProjectId}`, "PATCH", {
    videoPath: `${ALICE}/some-other-project/source.mp4`,
  });
  check("a key from another project is refused", otherProject.status === 400, `got ${otherProject.status}`);

  const traversal = await call(ALICE, `/api/projects/${aliceProjectId}`, "PATCH", {
    videoPath: `${ALICE}/${aliceProjectId}/../../${BOB}/x.mp4`,
  });
  check("a traversing key is refused", traversal.status === 400, `got ${traversal.status}`);

  // The traversal spelled the other way, which is the first thing anyone tries
  // after `../` bounces. None of these strings contains a dot at all, so a
  // check that looks for a literal ".." passes every one of them — and the
  // worker interpolates the key straight into a URL, where the parser resolves
  // the encoding *before* the request is sent. The worker holds the service
  // role key and bypasses row-level security, so what would actually leave the
  // process is a fetch of Bob's footage, rendered into Alice's project.
  for (const [name, encoded] of [
    ["percent-encoded", `%2e%2e/%2e%2e`],
    ["upper-case percent-encoded", `%2E%2E/%2E%2E`],
    ["half-encoded", `.%2e/.%2e`],
    ["double-encoded", `%252e%252e/%252e%252e`],
  ]) {
    const attempt = await call(ALICE, `/api/projects/${aliceProjectId}`, "PATCH", {
      videoPath: `${ALICE}/${aliceProjectId}/${encoded}/${BOB}/theirs/source.mp4`,
    });
    check(`a ${name} traversal is refused too`, attempt.status === 400, `got ${attempt.status}`);
  }

  // Proof that the encodings above are not theatre: this is what the URL parser
  // does with the key the worker would have been handed.
  const resolved = new URL(
    `https://x.supabase.co/storage/v1/object/videos/${ALICE}/${aliceProjectId}/%2e%2e/%2e%2e/${BOB}/theirs/source.mp4`,
  ).pathname;
  check(
    "and it matters, because the URL parser resolves them into another user's folder",
    resolved === `/storage/v1/object/videos/${BOB}/theirs/source.mp4`,
    resolved,
  );

  const percentAnywhere = await call(ALICE, `/api/projects/${aliceProjectId}`, "PATCH", {
    videoPath: `${ALICE}/${aliceProjectId}/so%75rce.mp4`,
  });
  check(
    "a percent sign in a key is refused wherever it appears, because nothing we write contains one",
    percentAnywhere.status === 400,
    `got ${percentAnywhere.status}`,
  );

  const dotSegment = await call(ALICE, `/api/projects/${aliceProjectId}`, "PATCH", {
    videoPath: `${ALICE}/${aliceProjectId}/./source.mp4`,
  });
  check("and so is a bare dot segment", dotSegment.status === 400, `got ${dotSegment.status}`);

  const backslash = await call(ALICE, `/api/projects/${aliceProjectId}`, "PATCH", {
    videoPath: `${ALICE}/${aliceProjectId}/..\\..\\${BOB}/x.mp4`,
  });
  check("and a backslash, which some parsers treat as a separator", backslash.status === 400, `got ${backslash.status}`);

  const shallow = await call(ALICE, `/api/projects/${aliceProjectId}`, "PATCH", {
    videoPath: `${ALICE}/source.mp4`,
  });
  check("a key missing the project segment is refused", shallow.status === 400, `got ${shallow.status}`);

  const edited = await call(ALICE, `/api/projects/${aliceProjectId}`, "PATCH", {
    editedVideoPath: `${BOB}/${aliceProjectId}/edited.mp4`,
  });
  check("editedVideoPath is validated too", edited.status === 400, `got ${edited.status}`);

  const thumb = await call(ALICE, `/api/projects/${aliceProjectId}`, "PATCH", {
    thumbnailPath: `${BOB}/${aliceProjectId}/thumb.jpg`,
  });
  check("so is the poster frame", thumb.status === 400, `got ${thumb.status}`);

  const ownThumb = await call(ALICE, `/api/projects/${aliceProjectId}`, "PATCH", {
    thumbnailPath: `${ALICE}/${aliceProjectId}/thumb.jpg`,
    duration: 187.4,
  });
  check(
    "the length and poster frame are recorded",
    ownThumb.json?.thumbnailPath === `${ALICE}/${aliceProjectId}/thumb.jpg` && ownThumb.json?.duration === 187.4,
    JSON.stringify({ t: ownThumb.json?.thumbnailPath, d: ownThumb.json?.duration }),
  );

  const intact = await call(ALICE, `/api/projects/${aliceProjectId}`);
  check(
    "refused writes left the stored key untouched",
    intact.json?.videoPath === `${ALICE}/${aliceProjectId}/source.mp4` && intact.json?.editedVideoPath === null,
    JSON.stringify({ v: intact.json?.videoPath, e: intact.json?.editedVideoPath }),
  );
}

console.log("\nThe assistant only promises what it can build");
{
  const understood = await call(ALICE, `/api/projects/${aliceProjectId}/messages`, "POST", {
    content: "cut the dead air out and make it vertical for tiktok",
  });
  const types = (understood.json?.plan?.operations ?? []).map((o) => o.type);
  check(
    "a request it understands becomes a real plan",
    types.includes("removeSilence") && types.includes("formatForPlatform"),
    JSON.stringify(understood.json?.plan),
  );
  // The product's promise as of the owner setting it: one prompt, and the work
  // begins. A sentence that produced a plan on a project with a video must
  // come back with the render it started — and the reply must say it is
  // running, not tell the person which button to press next.
  check(
    "and the sentence starts the render by itself",
    understood.json?.render?.status === "queued",
    JSON.stringify(understood.json?.render ?? null),
  );
  check(
    "and the reply says it is running rather than pointing at a button",
    /rendering now/i.test(understood.json?.aiMessage?.content ?? "") &&
      !/hit generate edit/i.test(understood.json?.aiMessage?.content ?? ""),
    understood.json?.aiMessage?.content,
  );
  // A second understood sentence while that render runs is *told about it*
  // in words rather than failing anywhere a person cannot see.
  const whileBusy = await call(ALICE, `/api/projects/${aliceProjectId}/messages`, "POST", {
    content: "cut the dead air out",
  });
  check(
    "a prompt during a render explains itself instead of erroring",
    whileBusy.status === 201 && /already going/i.test(whileBusy.json?.aiMessage?.content ?? ""),
    whileBusy.json?.aiMessage?.content,
  );
  // "I'll fold this in once it finishes" was, for a while, a sentence with
  // nothing behind it. Now it stores the plan it promised to keep.
  const psqlRead = (sql) =>
    spawnSync("psql", [process.env.DATABASE_URL, "-t", "-A", "-c", sql], { encoding: "utf8" }).stdout.trim();
  check(
    "and the promise is stored, not just spoken",
    psqlRead(`SELECT operations::text FROM render_followups WHERE project_id = '${aliceProjectId}'`).includes(
      "removeSilence",
    ),
    psqlRead(`SELECT count(*) FROM render_followups WHERE project_id = '${aliceProjectId}'`),
  );

  check(
    "the platform comes from what was actually asked for",
    understood.json?.plan?.operations?.find((o) => o.type === "formatForPlatform")?.platform === "tiktok",
    JSON.stringify(understood.json?.plan),
  );

  // Zooms became real, so they must now appear in the plan. Emojis and colour
  // grading did not, so they must still be named as things it will not do.
  const mixed = await call(ALICE, `/api/projects/${aliceProjectId}/messages`, "POST", {
    content: "add some zooms and emojis and a cinematic colour grade",
  });
  const mixedTypes = (mixed.json?.plan?.operations ?? []).map((o) => o.type);
  check("a request it can now honour becomes a real operation", mixedTypes.includes("zoomPunch"), JSON.stringify(mixedTypes));
  check("nothing is invented for the rest", !mixedTypes.includes("colourGrade"), JSON.stringify(mixedTypes));
  check(
    "and it says so rather than promising",
    /can't|cannot/i.test(mixed.json?.aiMessage?.content ?? "") && /emoji/i.test(mixed.json?.aiMessage?.content ?? ""),
    mixed.json?.aiMessage?.content,
  );

  // Both of these were missed by the first cut of the matcher: "emojis" did not
  // match /\bemoji\b/, and "snappier" did not match /snappy/.
  const plurals = await call(ALICE, `/api/projects/${aliceProjectId}/messages`, "POST", {
    content: "make it snappier and add emojis",
  });
  check(
    "word endings do not defeat the matcher",
    (plurals.json?.plan?.operations ?? []).some((o) => o.type === "removeSilence") &&
      /emoji/i.test(plurals.json?.aiMessage?.content ?? ""),
    plurals.json?.aiMessage?.content,
  );

  const nonsense = await call(ALICE, `/api/projects/${aliceProjectId}/messages`, "POST", {
    content: "asdfghjkl",
  });
  check(
    "an unparseable request asks for a clearer one",
    /not sure/i.test(nonsense.json?.aiMessage?.content ?? "") && nonsense.json?.plan === null,
    nonsense.json?.aiMessage?.content,
  );
  // The promise coming due: the poll that sees the render settle starts the
  // stored follow-up. Every prompt above that produced a plan while the queue
  // was busy overwrote the same row — newest wish wins — so exactly one
  // follow-up starts, whatever was asked in between.
  psqlGlobal(
    `UPDATE jobs SET status='done', progress=100, finished_at=now() WHERE project_id = '${aliceProjectId}'`,
  );
  const settlingPoll = await call(ALICE, `/api/projects/${aliceProjectId}/render/status`);
  check(
    "the poll that sees the settle still answers with the settled render",
    settlingPoll.json?.status === "done",
    JSON.stringify(settlingPoll.json?.status),
  );
  const followupPoll = await call(ALICE, `/api/projects/${aliceProjectId}/render/status`);
  check(
    "and the next poll finds the follow-up already rendering",
    followupPoll.json?.status === "queued" && followupPoll.json?.id !== settlingPoll.json?.id,
    JSON.stringify({ status: followupPoll.json?.status, same: followupPoll.json?.id === settlingPoll.json?.id }),
  );
  check(
    "the stored wish was consumed, not copied",
    psqlRead(`SELECT count(*) FROM render_followups WHERE project_id = '${aliceProjectId}'`) === "0",
  );
  const spoken = await call(ALICE, `/api/projects/${aliceProjectId}/messages`);
  check(
    "and the hand-off is said in the conversation where the promise was made",
    (spoken.json ?? []).some((m) => m.role === "assistant" && /follow-up you asked for/i.test(m.content)),
    JSON.stringify((spoken.json ?? []).slice(-2).map((m) => m.content?.slice(0, 60))),
  );
  // A settle with nothing pending must start nothing: the poll asks once,
  // gets the same answer, and the queue stays quiet.
  psqlGlobal(
    `UPDATE jobs SET status='done', progress=100, finished_at=now() WHERE project_id = '${aliceProjectId}'`,
  );
  await call(ALICE, `/api/projects/${aliceProjectId}/render/status`);
  const quiet = await call(ALICE, `/api/projects/${aliceProjectId}/render/status`);
  check(
    "a settle with no follow-up pending starts nothing",
    quiet.json?.status === "done",
    JSON.stringify(quiet.json?.status),
  );

  // Sentences in this section started renders — that is now the point of a
  // sentence. Cleared here so the sections below still measure the button
  // door from a clean queue.
  psqlGlobal(`DELETE FROM jobs WHERE project_id = '${aliceProjectId}'`);
  psqlGlobal(`DELETE FROM render_followups WHERE project_id = '${aliceProjectId}'`);

}

console.log("\nNamed looks");
{
  const list = await call(ALICE, "/api/templates");
  check("the catalogue is served", Array.isArray(list.json) && list.json.length >= 3, `got ${list.status}`);
  check(
    "every entry says what it does",
    (list.json ?? []).every((t) => t.id && t.name && t.description && t.bestFor),
    JSON.stringify(list.json?.[0]),
  );

  const anonymous = await fetch(`${BASE}/api/templates`);
  check("but not to a stranger", anonymous.status === 401, `got ${anonymous.status}`);

  const created = await call(ALICE, "/api/projects", "POST", { title: "Template check" });
  const templateProjectId = created.json?.id;
  await call(ALICE, `/api/projects/${templateProjectId}`, "PATCH", {
    videoPath: `${ALICE}/${templateProjectId}/source.mp4`,
    duration: 42,
  });

  const unknown = await call(ALICE, `/api/projects/${templateProjectId}/render`, "POST", { templateId: "does-not-exist" });
  check("an unknown template is refused", unknown.status === 400, `got ${unknown.status}`);

  const applied = await call(ALICE, `/api/projects/${templateProjectId}/render`, "POST", { templateId: "high-energy" });
  check("a template starts a render", applied.status === 202, `got ${applied.status} ${applied.text.slice(0, 120)}`);
  const ops = (applied.json?.plan?.operations ?? []);
  check(
    "and expands into the operations it promises",
    ops.some((o) => o.type === "removeSilence") &&
      ops.some((o) => o.type === "zoomPunch") &&
      ops.some((o) => o.type === "normalizeLoudness"),
    JSON.stringify(ops.map((o) => o.type)),
  );
  const punch = ops.find((o) => o.type === "zoomPunch");
  check(
    "punches are placed inside the clip, not at fixed times",
    punch && punch.at.length > 0 && punch.at.every((t) => t > 0 && t < 42),
    JSON.stringify(punch?.at),
  );
  // The bug this guards: with no duration recorded, placement fell back to 30
  // seconds and every punch on a long clip landed in the first half minute.
  check(
    "and spread across the whole clip, not just its first 30 seconds",
    punch && punch.at.some((t) => t > 30),
    JSON.stringify(punch?.at),
  );

  // The one look that makes several files rather than one. Its own project,
  // because the queue allows one render in flight per project.
  const clipsLook = await call(ALICE, "/api/projects", "POST", { title: "Clips look check" });
  const clipsLookId = clipsLook.json?.id;
  await call(ALICE, `/api/projects/${clipsLookId}`, "PATCH", {
    videoPath: `${ALICE}/${clipsLookId}/source.mp4`,
    duration: 300,
  });
  const three = await call(ALICE, `/api/projects/${clipsLookId}/render`, "POST", { templateId: "three-clips" });
  check("the clips look starts a render", three.status === 202, `got ${three.status} ${three.text.slice(0, 160)}`);
  const threeOps = three.json?.plan?.operations ?? [];
  const clipsOp = threeOps.find((o) => o.type === "extractClips");
  check("it asks for clips, which is what makes it several files", Boolean(clipsOp), JSON.stringify(threeOps.map((o) => o.type)));
  check("three of them, thirty seconds each", clipsOp?.count === 3 && clipsOp?.targetSeconds === 30, JSON.stringify(clipsOp));
  check(
    "captioned and levelled like anything made to be posted",
    threeOps.some((o) => o.type === "autoCaptions") && threeOps.some((o) => o.type === "normalizeLoudness"),
    JSON.stringify(threeOps.map((o) => o.type)),
  );
  check(
    "and faded, so a piece cut from the middle does not start mid-room",
    threeOps.some((o) => o.type === "fade"),
    JSON.stringify(threeOps.map((o) => o.type)),
  );
  await call(ALICE, `/api/projects/${clipsLookId}`, "DELETE");

  /**
   * The look that cannot be built out of nothing.
   *
   * Every other template is a function of the platform and the running time,
   * so it can be built for any project at all. This one lays the project's own
   * track under the edit and cuts to it, and a project with no audio has no
   * beat to cut to. The two ways to get that wrong are both quiet: place the
   * punches on the speaker's emphasis instead — an edit nobody asked for
   * wearing the name of one they did — or return an empty plan and hand back a
   * video identical to the one that went in. So the refusal is asserted before
   * the success is.
   */
  const beatLook = await call(ALICE, "/api/projects", "POST", { title: "Beat look check" });
  const beatLookId = beatLook.json?.id;
  await call(ALICE, `/api/projects/${beatLookId}`, "PATCH", {
    videoPath: `${ALICE}/${beatLookId}/source.mp4`,
    duration: 60,
  });

  const catalogue = list.json ?? [];
  const beatEntry = catalogue.find((t) => t.id === "on-the-beat");
  check("the catalogue says which look needs a file", beatEntry?.needs === "music", JSON.stringify(beatEntry));
  check(
    "and says nothing of the sort about the ones that need none",
    catalogue.filter((t) => t.id !== "on-the-beat").every((t) => t.needs === null),
    JSON.stringify(catalogue.map((t) => [t.id, t.needs])),
  );

  const noTrack = await call(ALICE, `/api/projects/${beatLookId}/render`, "POST", { templateId: "on-the-beat" });
  check("a beat look on a project with no track is refused", noTrack.status === 400, `got ${noTrack.status}`);
  check(
    "and the refusal names the missing file rather than apologising",
    /audio|track/i.test(noTrack.json?.error ?? ""),
    JSON.stringify(noTrack.json),
  );
  check(
    "and nothing was queued by the attempt",
    Number(psqlGlobalRead(`select count(*) from jobs where project_id = '${beatLookId}'`).trim()) === 0,
    psqlGlobalRead(`select count(*) from jobs where project_id = '${beatLookId}'`).trim(),
  );

  const track = await call(ALICE, `/api/projects/${beatLookId}/assets`, "POST", {
    path: `${ALICE}/${beatLookId}/track.mp3`,
    kind: "audio",
    bytes: 4096,
  });
  check("a track can be registered on the project", track.status === 201, `got ${track.status} ${track.text.slice(0, 120)}`);

  const beat = await call(ALICE, `/api/projects/${beatLookId}/render`, "POST", { templateId: "on-the-beat" });
  check("and then the beat look starts a render", beat.status === 202, `got ${beat.status} ${beat.text.slice(0, 160)}`);
  const beatOps = beat.json?.plan?.operations ?? [];
  const music = beatOps.find((o) => o.type === "addMusic");
  check(
    "it lays the project's own track under the edit",
    music?.assetId === track.json?.id,
    `${JSON.stringify(music)} against ${JSON.stringify(track.json?.id)}`,
  );
  const beatPunch = beatOps.find((o) => o.type === "zoomPunch");
  check("and punches on the beat rather than on the speaker", beatPunch?.on === "beat", JSON.stringify(beatPunch));
  // The one template that hands over an empty list on purpose. Where the beats
  // are is a fact about the audio, and nothing on this side of the wire has
  // heard it — the worker reads the track and fills these in, or finds no
  // steady pulse and says so.
  check(
    "leaving the moments to the worker, which is the only thing that hears the track",
    Array.isArray(beatPunch?.at) && beatPunch.at.length === 0,
    JSON.stringify(beatPunch?.at),
  );
  /**
   * And the other half of the pair, which is what makes the check above mean
   * something.
   *
   * An empty punch list means two different things. For an emphasis punch it
   * means "you decide" — the chat knows the person wants punches and not where
   * they go, so the server spaces them across the clip. For a beat punch it
   * means "the worker decides, once it has heard the track". One line served
   * both for three rounds, which silently turned every beat-synced edit into
   * four evenly spaced zooms; asserting only the beat side would leave the
   * spacing free to disappear next.
   */
  const bothProject = await call(ALICE, "/api/projects", "POST", { title: "Empty punch list check" });
  const bothId = bothProject.json?.id;
  await call(ALICE, `/api/projects/${bothId}`, "PATCH", {
    videoPath: `${ALICE}/${bothId}/source.mp4`,
    duration: 40,
  });
  const spaced = await call(ALICE, `/api/projects/${bothId}/render`, "POST", {
    plan: { version: 1, operations: [{ type: "zoomPunch", on: "emphasis", at: [], amount: 0.12, holdMs: 600 }] },
  });
  const spacedPunch = (spaced.json?.plan?.operations ?? []).find((o) => o.type === "zoomPunch");
  check(
    "an emphasis punch with no moments is spread across the clip instead",
    spacedPunch?.at?.length > 0 && spacedPunch.at.every((t) => t > 0 && t < 40),
    JSON.stringify(spacedPunch),
  );
  await call(ALICE, `/api/projects/${bothId}`, "DELETE");

  await call(ALICE, `/api/projects/${beatLookId}`, "DELETE");

  await call(ALICE, `/api/projects/${templateProjectId}`, "DELETE");
}

console.log("\nExports are real renders");
{
  // Its own project: an export queues a render, and the render-queue checks
  // below need a project with nothing already in flight.
  const created = await call(ALICE, "/api/projects", "POST", { title: "Export check" });
  const exportProjectId = created.json?.id;
  await call(ALICE, `/api/projects/${exportProjectId}`, "PATCH", {
    videoPath: `${ALICE}/${exportProjectId}/source.mp4`,
  });

  const noVideo = await call(ALICE, "/api/projects", "POST", { title: "No video" });
  const refused = await call(ALICE, `/api/projects/${noVideo.json?.id}/export`, "POST", { platform: "reels" });
  check("exporting a project with no video is refused", refused.status === 409, `got ${refused.status}`);
  await call(ALICE, `/api/projects/${noVideo.json?.id}`, "DELETE");

  const exported = await call(ALICE, `/api/projects/${exportProjectId}/export`, "POST", { platform: "reels" });
  check("an export is accepted", exported.status === 202, `got ${exported.status} ${exported.text.slice(0, 120)}`);
  check("it does not claim to be finished already", exported.json?.status === "processing", JSON.stringify(exported.json?.status));
  check(
    "and it does not hand back a fabricated download URL",
    exported.json?.downloadUrl == null,
    JSON.stringify(exported.json?.downloadUrl),
  );

  const job = await call(ALICE, `/api/projects/${exportProjectId}/render/status`);
  check("the export really queued a render", job.json?.status === "queued", JSON.stringify(job.json?.status));
  check(
    "framed for the platform that was asked for",
    (job.json?.plan?.operations ?? []).some((o) => o.type === "formatForPlatform" && o.platform === "reels"),
    JSON.stringify(job.json?.plan),
  );
  check(
    "and carrying the free-plan watermark",
    (job.json?.plan?.operations ?? []).some((o) => o.type === "watermark"),
    JSON.stringify(job.json?.plan),
  );

  /**
   * And it exports the edit, not the upload.
   *
   * This route rendered the original file with two operations bolted on — cut
   * the silences, frame it for the platform — so the button sitting beside the
   * finished edit, under a heading that says "Export Project", handed back **a
   * different video**: no captions, no punches, no music, no titles, none of
   * the work the person had just done. Nothing failed and nothing said so.
   *
   * The three exceptions are the interesting part, and each one is a decision
   * rather than an omission.
   */
  const carryProject = await call(ALICE, "/api/projects", "POST", { title: "Export carries the edit" });
  const carryId = carryProject.json?.id;
  await call(ALICE, `/api/projects/${carryId}`, "PATCH", {
    videoPath: `${ALICE}/${carryId}/source.mp4`,
    duration: 40,
  });
  // A finished render with a plan worth keeping — captions, a punch, a look,
  // and a platform the export is about to change.
  psqlGlobal(
    `insert into jobs (id, project_id, user_id, status, plan, input_path, created_at, updated_at, finished_at) ` +
      `values ('export-carry-job', '${carryId}', '${ALICE}', 'done', ` +
      `'{"version":1,"operations":[` +
      `{"type":"removeSilence","thresholdDb":-32,"minSilenceMs":400,"paddingMs":70},` +
      `{"type":"autoCaptions","style":"bold-white","animation":"pop","dropFillers":true},` +
      `{"type":"zoomPunch","on":"emphasis","at":[4,9],"amount":0.14,"holdMs":900},` +
      `{"type":"grade","saturation":1,"look":"cinematic"},` +
      `{"type":"formatForPlatform","platform":"tiktok"},` +
      `{"type":"watermark","text":"Edited with Editly","position":"bottom-right"}` +
      `]}'::jsonb, '${ALICE}/${carryId}/source.mp4', now(), now(), now())`,
  );

  const carried = await call(ALICE, `/api/projects/${carryId}/export`, "POST", { platform: "youtube" });
  check("an export of an edited project is accepted", carried.status === 202, `got ${carried.status} ${carried.text.slice(0, 160)}`);
  const carriedJob = await call(ALICE, `/api/projects/${carryId}/render/status`);
  const ops = carriedJob.json?.plan?.operations ?? [];
  const types = ops.map((o) => o.type);
  check(
    "and it carries the edit rather than re-cutting the upload",
    ["autoCaptions", "zoomPunch", "grade"].every((t) => types.includes(t)),
    JSON.stringify(types),
  );
  check(
    "with the punches on the moments the edit chose",
    JSON.stringify(ops.find((o) => o.type === "zoomPunch")?.at) === JSON.stringify([4, 9]),
    JSON.stringify(ops.find((o) => o.type === "zoomPunch")),
  );
  check(
    "the platform is the one asked for now, not the one the edit was made in",
    ops.filter((o) => o.type === "formatForPlatform").length === 1 &&
      ops.find((o) => o.type === "formatForPlatform")?.platform === "youtube",
    JSON.stringify(ops.filter((o) => o.type === "formatForPlatform")),
  );
  // The mark is not the plan's to carry: the policy adds it from the
  // subscription on every path, so a plan that brought its own would either
  // double it or smuggle one past a paying customer.
  check(
    "the mark comes from the subscription, once, not from the plan it copied",
    ops.filter((o) => o.type === "watermark").length === 1,
    JSON.stringify(types),
  );
  // The operations are written against the source clock, so the export starts
  // from the upload. Re-rendering the edited file would cut the silences out of
  // a video whose silences are already gone.
  const exportInput = psqlGlobalRead(
    `select input_path from jobs where project_id = '${carryId}' and id <> 'export-carry-job' limit 1`,
  ).trim();
  check(
    "and it renders the original upload, because that is what the plan describes",
    exportInput === `${ALICE}/${carryId}/source.mp4`,
    `${exportInput} — re-rendering the edited file would cut the silences out of a video whose silences are already gone`,
  );
  psqlGlobal(`delete from jobs where project_id = '${carryId}'`);
  await call(ALICE, `/api/projects/${carryId}`, "DELETE");

  const status = await call(ALICE, `/api/projects/${exportProjectId}/export/status`);
  check("its status stays processing while the worker has not run", status.json?.status === "processing", JSON.stringify(status.json?.status));
  check(
    "no step claims to be done before the worker did it",
    !(status.json?.steps ?? []).every((s) => s.status === "done"),
    JSON.stringify(status.json?.steps),
  );

  const bobExport = await call(BOB, `/api/projects/${exportProjectId}/export/status`);
  check("Bob still cannot see it", bobExport.status === 404, `got ${bobExport.status}`);

  await call(ALICE, `/api/projects/${exportProjectId}`, "DELETE");
}

console.log("\nRender queue");
{
  const plan = { version: 1, operations: [{ type: "removeSilence" }] };

  const bobStart = await call(BOB, `/api/projects/${aliceProjectId}/render`, "POST", { plan });
  check("Bob cannot queue a render on Alice's project", bobStart.status === 404, `got ${bobStart.status}`);

  const bobStatus = await call(BOB, `/api/projects/${aliceProjectId}/render/status`);
  check("Bob cannot poll Alice's render", bobStatus.status === 404, `got ${bobStatus.status}`);

  const queued = await call(ALICE, `/api/projects/${aliceProjectId}/render`, "POST", { plan });
  check("Alice can queue a render on her own project", queued.status === 202, `got ${queued.status} ${queued.text.slice(0, 120)}`);
  check("the queued job starts at zero progress", queued.json?.status === "queued" && queued.json?.progress === 0, JSON.stringify(queued.json));

  const second = await call(ALICE, `/api/projects/${aliceProjectId}/render`, "POST", { plan });
  check("a second concurrent render is refused", second.status === 409, `got ${second.status}`);

  const bad = await call(ALICE, `/api/projects/${aliceProjectId}/render`, "POST", {
    plan: { version: 1, operations: [{ type: "deleteEverything" }] },
  });
  check("an unknown operation is refused", bad.status === 400, `got ${bad.status}`);

  const empty = await call(ALICE, `/api/projects/${aliceProjectId}/render`, "POST", {
    plan: { version: 1, operations: [] },
  });
  check("an empty plan is refused", empty.status === 400, `got ${empty.status}`);

  const status = await call(ALICE, `/api/projects/${aliceProjectId}/render/status`);
  check("Alice sees her own job", status.json?.id === queued.json?.id, JSON.stringify(status.json?.id));

  // A busy queue and an absent one look identical — job queued, progress zero —
  // and mean opposite things to whoever is waiting. This is the line between
  // them, and it is the reason two projects sat at "Processing" for two days.
  const fresh = await call(ALICE, `/api/projects/${aliceProjectId}`);
  check("a job queued just now is not called stalled", fresh.json?.renderStalled === false, JSON.stringify(fresh.json?.renderStalled));

  /*
    The counters, read before and after — not against zero.

    "It is not also counted as processing" was asserted as
    `processingCount === 0`, which is a statement about the whole account
    rather than about this job. Anything else of Alice's that happens to be in
    flight — a leftover row from an earlier run of this suite against the same
    database, which is the normal state of a development machine — made it fail
    on a product that was behaving perfectly. A check that goes red for a
    reason outside what it is testing teaches whoever reads it to ignore it.

    What is actually being claimed is that this one job moves from one bucket
    to the other: still counted, counted once, counted in the right place.
  */
  const beforeAging = (await call(ALICE, "/api/stats/dashboard")).json ?? {};

  const backdate = spawnSync(
    "psql",
    [
      process.env.DATABASE_URL,
      "-c",
      `update jobs set created_at = now() - interval '10 minutes' where project_id = '${aliceProjectId}'`,
    ],
    { encoding: "utf8" },
  );
  check("the job could be backdated for the test", backdate.status === 0, backdate.stderr?.slice(0, 120));

  const aged = await call(ALICE, `/api/projects/${aliceProjectId}`);
  check("ten minutes unclaimed is reported as stalled", aged.json?.renderStalled === true, JSON.stringify(aged.json?.renderStalled));

  const listed = await call(ALICE, "/api/projects");
  const listedProject = listed.json?.find?.((p) => p.id === aliceProjectId);
  check("and the list says the same thing", listedProject?.renderStalled === true, JSON.stringify(listedProject?.renderStalled));

  const stats = await call(ALICE, "/api/stats/dashboard");
  const onCard = stats.json?.recentProjects?.find?.((p) => p.id === aliceProjectId);
  check("so does the dashboard card", onCard?.renderStalled === true, JSON.stringify(onCard?.renderStalled));
  // The counter above the cards has to agree with them.
  check(
    "a stalled render is counted as waiting, not as processing",
    stats.json?.stalledCount === (beforeAging.stalledCount ?? 0) + 1,
    JSON.stringify({ before: beforeAging.stalledCount, after: stats.json?.stalledCount }),
  );
  check(
    "and it is not also counted as processing",
    stats.json?.processingCount === (beforeAging.processingCount ?? 0) - 1,
    // Counted once, and in the new place. Read as a move rather than as a
    // total, so anything else of this account's that is in flight cannot
    // decide the answer.
    JSON.stringify({ before: beforeAging.processingCount, after: stats.json?.processingCount }),
  );

  const claimed = spawnSync(
    "psql",
    [
      process.env.DATABASE_URL,
      "-c",
      `update jobs set locked_at = now(), locked_by = 'test-worker' where project_id = '${aliceProjectId}'`,
    ],
    { encoding: "utf8" },
  );
  check("the job could be claimed for the test", claimed.status === 0, claimed.stderr?.slice(0, 120));

  const working = await call(ALICE, `/api/projects/${aliceProjectId}`);
  check(
    "an old job a worker has claimed is not stalled",
    working.json?.renderStalled === false,
    JSON.stringify(working.json?.renderStalled),
  );

  const bobsView = await call(BOB, "/api/projects");
  check(
    "and none of this leaks Alice's project into Bob's list",
    Array.isArray(bobsView.json) && !bobsView.json.some((p) => p.id === aliceProjectId),
    JSON.stringify(bobsView.json?.length),
  );
}

console.log("\nPer-user statistics and quota");
{
  const alice = await call(ALICE, "/api/stats/dashboard");
  const bob = await call(BOB, "/api/stats/dashboard");
  check("Alice's stats count her project", alice.json?.totalProjects >= 1, JSON.stringify(alice.json));
  check("Bob's stats are empty", bob.json?.totalProjects === 0, JSON.stringify(bob.json));

  // The meter counts minutes of finished video, so a render belonging to Bob
  // must never appear on Alice's bill. This asserted `videosUsedThisMonth`
  // against a project count — a field the API stopped returning when billing
  // moved from videos to minutes, so it compared undefined to a number and
  // could not have been true since.
  // The job needs no project row: the meter sums by user and status, and
  // nothing here joins. That is the same denormalisation that makes every
  // ownership filter a single WHERE.
  const charged = spawnSync(
    "psql",
    [
      process.env.DATABASE_URL,
      "-c",
      `insert into jobs (id, user_id, project_id, status, plan, input_path, output_seconds, finished_at)
       values ('meter-test-job', '${BOB}', 'meter-test-project', 'done', '{"version":1,"operations":[]}'::jsonb,
               '${BOB}/x/source.mp4', 185, now())`,
    ],
    { encoding: "utf8" },
  );
  check("a finished render could be recorded for Bob", charged.status === 0, charged.stderr?.slice(0, 160));

  const bobSub = await call(BOB, "/api/subscription");
  check("Bob is billed for his own render", bobSub.json?.minutesUsedThisMonth === 4, JSON.stringify(bobSub.json));

  const aliceSub = await call(ALICE, "/api/subscription");
  check(
    "and Alice is not billed for it",
    aliceSub.json?.minutesUsedThisMonth === 0,
    JSON.stringify(aliceSub.json),
  );
  check(
    "the meter is minutes of finished video, not a count of projects",
    typeof aliceSub.json?.minutesUsedThisMonth === "number" && aliceSub.json?.videosUsedThisMonth === undefined,
    JSON.stringify(aliceSub.json),
  );

  /*
    And the ceiling that is not ours.

    `maxUploadMinutes` is our rule. `maxUploadBytes` is the bucket's, and it is
    the one that actually refuses a file: on Supabase's free plan it is 50 MB
    per object, roughly roughly a minute of what this renderer encodes, against a
    pricing page that sells four-hour episodes.

    It was a build-time variable in the front end, under a comment claiming
    that moving the ceiling would need no code change. It would have needed a
    redeploy — and until somebody did one, uploads would go on being refused
    for a limit that no longer existed, with that number in the sentence.

    Served now. This deployment cannot reach Storage, so what is under test
    here is the half that matters for correctness: the field is always a usable
    number, because a screen that reads `undefined` here would compare every
    file against NaN and accept all of them.
  */
  check(
    "the upload ceiling Storage enforces is served, not compiled into the page",
    typeof aliceSub.json?.maxUploadBytes === "number" && aliceSub.json.maxUploadBytes > 0,
    JSON.stringify(aliceSub.json?.maxUploadBytes),
  );
  check(
    "and it falls back to a real number when Storage cannot be asked",
    // Not null and not zero: `file.size > null` is false, so a missing ceiling
    // would silently accept every file and fail at the end of the upload.
    aliceSub.json?.maxUploadBytes === 50 * 1024 * 1024,
    JSON.stringify(aliceSub.json?.maxUploadBytes),
  );
}

console.log("\nBilling integrity");
{
  // These used the pre-rename names — `scale` and `starter` — which the schema
  // now rejects, so all three were 400s rather than the refusals they claim to
  // check. Nobody saw it, because this suite needs a Postgres to run at all.
  const upgrade = await call(ALICE, "/api/subscription", "PATCH", { plan: "pro" });
  check("upgrading without payment is refused", upgrade.status === 402, `got ${upgrade.status}`);
  check(
    "and the refusal points at checkout rather than just saying no",
    typeof upgrade.json?.checkout === "string",
    JSON.stringify(upgrade.json),
  );

  const after = await call(ALICE, "/api/subscription");
  check("plan unchanged after refused upgrade", after.json?.plan === "free", JSON.stringify(after.json));

  const same = await call(ALICE, "/api/subscription", "PATCH", { plan: "free" });
  check("staying on the same tier is allowed", same.status === 200, `got ${same.status}`);

  const nonsense = await call(ALICE, "/api/subscription", "PATCH", { plan: "starter" });
  check("a plan name that no longer exists is rejected outright", nonsense.status === 400, `got ${nonsense.status}`);
}

console.log("\nCascade cleanup");
{
  const created = await call(BOB, "/api/projects", "POST", { title: "Bob temp" });
  const id = created.json?.id;
  await call(BOB, `/api/projects/${id}/messages`, "POST", { content: "hello" });

  // Deleting a project must not become a way to reset the meter. Minutes that
  // were produced were produced, so the job rows outlive the project on
  // purpose — the same hole the render policy exists to close would otherwise
  // reopen as "delete your projects and render for free".
  const billed = spawnSync(
    "psql",
    [
      process.env.DATABASE_URL,
      "-c",
      `insert into jobs (id, user_id, project_id, status, plan, input_path, output_seconds, finished_at)
       values ('cascade-test-job', '${BOB}', '${id}', 'done', '{"version":1,"operations":[]}'::jsonb,
               '${BOB}/${id}/source.mp4', 120, now())`,
    ],
    { encoding: "utf8" },
  );
  check("a finished render could be recorded against it", billed.status === 0, billed.stderr?.slice(0, 160));

  const beforeDelete = await call(BOB, "/api/subscription");
  check("the meter sees it", beforeDelete.json?.minutesUsedThisMonth >= 2, JSON.stringify(beforeDelete.json));

  const del = await call(BOB, `/api/projects/${id}`, "DELETE");
  check("owner can delete their own project", del.status === 204, `got ${del.status}`);

  const afterDelete = await call(BOB, "/api/subscription");
  check(
    "and deleting it does not refund the minutes it produced",
    afterDelete.json?.minutesUsedThisMonth === beforeDelete.json?.minutesUsedThisMonth,
    `${beforeDelete.json?.minutesUsedThisMonth} before, ${afterDelete.json?.minutesUsedThisMonth} after`,
  );

  const msgs = await call(BOB, `/api/projects/${id}/messages`);
  check(
    "child messages are removed with the project",
    Array.isArray(msgs.json) && msgs.json.length === 0,
    JSON.stringify(msgs.json),
  );
}

console.log("\nThe way off the mailing list works without a session, and not by being looked at");
{
  /*
    This is the endpoint a legal requirement rests on, and the two ways it can
    be wrong both look like success.

    It has to work with **no session**: the person following the link is in an
    email client, possibly on another device, and asking them to sign in to
    stop receiving mail is how a requirement becomes a complaint.

    And the `GET` must **not** unsubscribe. A link in an email is followed by
    corporate mail scanners, link previewers and antivirus proxies before it
    ever reaches a person. A GET that acted would quietly unsubscribe people who
    never opened the letter, and nothing would report it: the mail stops, and
    they conclude the product forgot them.
  */
  const TOKEN = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
  spawnSync(
    "psql",
    [
      process.env.DATABASE_URL,
      "-c",
      `insert into mail_settings (user_id, token) values ('${ALICE}', '${TOKEN}')
       on conflict (user_id) do update set token = excluded.token, news_opt_out = false`,
    ],
    { encoding: "utf8" },
  );

  const open = (path, method = "GET", body) =>
    fetch(BASE + path, {
      method,
      ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
    }).then(async (res) => ({ status: res.status, json: await res.json().catch(() => null) }));

  const read = await open(`/api/mail/unsubscribe/${TOKEN}`);
  check("the link answers with no bearer token at all", read.status === 200, `got ${read.status}`);
  check("and says they are on the list", read.json?.subscribed === true, JSON.stringify(read.json));

  const stillOn = spawnSync(
    "psql",
    [process.env.DATABASE_URL, "-tAc", `select news_opt_out from mail_settings where token = '${TOKEN}'`],
    { encoding: "utf8" },
  ).stdout.trim();
  check(
    "and looking at it changed nothing, because scanners look",
    stillOn === "f",
    "a GET that unsubscribes unsubscribes everybody whose mail passes a scanner",
  );

  const off = await open(`/api/mail/unsubscribe/${TOKEN}`, "POST");
  check("a bare POST is what one-click sends, and it unsubscribes", off.json?.subscribed === false, JSON.stringify(off.json));

  const again = await open(`/api/mail/unsubscribe/${TOKEN}`, "POST");
  check(
    "pressing twice is the same answer, not a toggle back on",
    again.json?.subscribed === false,
    JSON.stringify(again.json),
  );

  const back = await open(`/api/mail/unsubscribe/${TOKEN}`, "POST", { resubscribe: true });
  check("and there is a way back, for the mis-tap that is the commonest reason to be here", back.json?.subscribed === true, JSON.stringify(back.json));

  /*
    A wrong token and an unknown one get the same answer, so this cannot be
    walked to find out whether a string is live.
  */
  const unknown = await open("/api/mail/unsubscribe/ffffffffffffffffffffffffffffffff");
  const malformed = await open("/api/mail/unsubscribe/not-a-token");
  check("an unknown token is a 404", unknown.status === 404, `got ${unknown.status}`);
  check("a malformed one is the same 404", malformed.status === 404, `got ${malformed.status}`);
  check(
    "with the same sentence, so neither can be told from the other",
    unknown.json?.message === malformed.json?.message && typeof unknown.json?.message === "string",
    `${unknown.json?.message} / ${malformed.json?.message}`,
  );

  spawnSync("psql", [process.env.DATABASE_URL, "-c", `delete from mail_settings where token = '${TOKEN}'`], {
    encoding: "utf8",
  });
}

console.log("\nAsking what we hold answers, and never hands back a credential");
{
  /*
    The export is the one endpoint whose whole job is to hand somebody a file
    full of their own data, which makes it the one place a live credential can
    walk out looking like a feature.

    `social_accounts` holds access and refresh tokens for YouTube, Meta, TikTok
    and X. A JSON file containing one is a working key to that channel for as
    long as the file exists — and an export is a file people keep, forward, and
    attach to support tickets. `account-test` proves the redaction rule against
    the schema; this proves it against the running server, with a real row and
    a token string nothing else in the response could produce.
  */
  const SECRET = "ya29-do-not-export-me-0af31c";
  const seeded = spawnSync(
    "psql",
    [
      process.env.DATABASE_URL,
      "-c",
      `insert into social_accounts (id, user_id, platform, external_id, handle, display_name, access_token, refresh_token, page_access_token, expires_at)
       values ('export-leak-check', '${ALICE}', 'youtube', 'chan-1', '@alice', 'Alice on YouTube',
               '${SECRET}', '${SECRET}-refresh', '${SECRET}-page', now() + interval '30 days')
       on conflict (id) do update set access_token = excluded.access_token`,
    ],
    { encoding: "utf8" },
  );

  // Asserted, because a failed seed makes every check below pass against an
  // empty table — which is the shape of a leak test that never tested anything.
  check("a connection with live tokens exists to be exported", seeded.status === 0, seeded.stderr?.slice(0, 200));

  const exported = await call(ALICE, "/api/account/export");
  check("the export answers", exported.status === 200, `got ${exported.status}`);

  const raw = JSON.stringify(exported.json ?? {});
  check(
    "and the token is not anywhere in it",
    !raw.includes(SECRET),
    "a live platform credential left in a file the customer keeps",
  );

  const account = exported.json?.tables?.socialAccounts?.[0];
  check("the connection itself is in it", Boolean(account), JSON.stringify(exported.json?.tables?.socialAccounts));
  check(
    "with the field present rather than dropped, so it does not claim we hold nothing",
    account !== undefined && "accessToken" in account,
    JSON.stringify(account),
  );
  check(
    "and a marker in its place that says what it is",
    /credential/i.test(String(account?.accessToken ?? "")),
    String(account?.accessToken),
  );
  check("the display name is untouched", account?.displayName === "Alice on YouTube", JSON.stringify(account));
  // All three of them, because they are three different keys to three different
  // things and a rule that catches two is a rule that leaks the third.
  check("the refresh token is refused too", /credential/i.test(String(account?.refreshToken ?? "")), String(account?.refreshToken));
  check("and the Page token, which opens somebody else's Page", /credential/i.test(String(account?.pageAccessToken ?? "")), String(account?.pageAccessToken));

  /*
    And it is theirs and only theirs. Every read in the route is by `userId`
    with no join, which is the property that makes this true; this is the
    assertion that it stayed true.
  */
  const bobExport = await call(BOB, "/api/account/export");
  check("somebody else's export does not contain it", !JSON.stringify(bobExport.json ?? {}).includes(SECRET));
  check(
    "and does not contain their projects either",
    (bobExport.json?.tables?.projects ?? []).every((project) => project.userId === BOB),
    JSON.stringify((bobExport.json?.tables?.projects ?? []).map((p) => p.userId)),
  );

  check(
    "it says what is deliberately not in it",
    Array.isArray(exported.json?.notIncluded) && exported.json.notIncluded.length >= 2,
    JSON.stringify(exported.json?.notIncluded),
  );
  check(
    "and comes as a file rather than a page",
    /attachment; filename="editly-data-/.test(exported.headers?.get?.("content-disposition") ?? ""),
    exported.headers?.get?.("content-disposition"),
  );

  spawnSync("psql", [process.env.DATABASE_URL, "-c", "delete from social_accounts where id = 'export-leak-check'"], {
    encoding: "utf8",
  });
}

console.log("\nDeleting a project is never reported as done while the video is still here");
{
  // The route used to delete the row first and reclaim the bytes best-effort,
  // discarding the answer — so a Storage outage, or a deployment without the
  // service role key, returned 204 while every byte stayed on our disks with
  // nothing left pointing at it. `account-deletion.ts` has refused in exactly
  // this situation from the start, for the reason written there: a refusal can
  // be acted on, a false confirmation cannot. This is the path people use.
  const made = await call(ALICE, "/api/projects", "POST", { title: "Storage refusal" });
  const id = made.json?.id;
  await call(ALICE, `/api/projects/${id}`, "PATCH", { videoPath: `${ALICE}/${id}/source.mp4` });

  storageCalls.length = 0;
  storageFailsWith = 503;
  const refused = await call(ALICE, `/api/projects/${id}`, "DELETE");
  check("a project whose bytes will not go is not deleted", refused.status === 503, `got ${refused.status}`);
  check(
    "and the message says nothing was deleted, rather than apologising vaguely",
    /nothing has been deleted/i.test(refused.json?.error ?? ""),
    refused.json?.error,
  );

  const stillThere = await call(ALICE, `/api/projects/${id}`);
  check("the row is still there, so they can try again", stillThere.status === 200, `got ${stillThere.status}`);
  check(
    "with its key intact, because the row is what names the object",
    stillThere.json?.videoPath === `${ALICE}/${id}/source.mp4`,
    JSON.stringify(stillThere.json?.videoPath),
  );

  storageFailsWith = null;
  storageCalls.length = 0;
  const gone = await call(ALICE, `/api/projects/${id}`, "DELETE");
  check("and when storage answers, it deletes", gone.status === 204, `got ${gone.status}`);
  check(
    "having actually asked storage to remove the object",
    storageCalls.some((c) => c.op === "delete"),
    JSON.stringify(storageCalls),
  );
  check(
    "under this project's own prefix and nobody else's",
    storageCalls.find((c) => c.op === "list")?.prefix === `${ALICE}/${id}`,
    JSON.stringify(storageCalls.find((c) => c.op === "list")),
  );

  // An empty project has nothing in the bucket to orphan, so refusing to delete
  // it would be refusing to do something that cannot go wrong.
  const empty = await call(ALICE, "/api/projects", "POST", { title: "Nothing in it" });
  storageFailsWith = 503;
  const emptyGone = await call(ALICE, `/api/projects/${empty.json?.id}`, "DELETE");
  storageFailsWith = null;
  check(
    "a project that never held a file deletes even when storage is unreachable",
    emptyGone.status === 204,
    `got ${emptyGone.status}`,
  );
}

console.log("\nDeleting a project sweeps every page of its bytes, not just the first");
{
  // The sweep used to ask Storage once — one page of a hundred — and report
  // everything gone. One clips render writes up to a dozen objects, so a
  // project a person actually used could hold more than a page, and every
  // object past the hundredth quietly survived its own deletion while the
  // route said 204. The fix drains pages until the prefix answers empty, and
  // this measures it against an inventory bigger than two pages.
  const made = await call(ALICE, "/api/projects", "POST", { title: "Two hundred files" });
  const id = made.json?.id;
  await call(ALICE, `/api/projects/${id}`, "PATCH", { videoPath: `${ALICE}/${id}/source.mp4` });

  const prefix = `${ALICE}/${id}`;
  storageSeeded.add(prefix);
  for (let i = 0; i < 237; i++) {
    storageObjects.add(`${prefix}/clip-fill-${String(i).padStart(3, "0")}.mp4`);
  }

  storageCalls.length = 0;
  const gone = await call(ALICE, `/api/projects/${id}`, "DELETE");
  check("a project holding 237 objects deletes", gone.status === 204, `got ${gone.status}`);
  const leftovers = [...storageObjects].filter((k) => k.startsWith(`${prefix}/`));
  check(
    "and not one of its objects survives the sweep",
    leftovers.length === 0,
    `${leftovers.length} left, e.g. ${leftovers.slice(0, 3).join(", ")}`,
  );
  check(
    "which took more than one page to do",
    storageCalls.filter((c) => c.op === "delete").length >= 3,
    JSON.stringify(storageCalls.map((c) => c.op)),
  );

  // And a Storage that answers 200 while removing nothing must exhaust the
  // sweep's patience into a refusal — never into a confirmed deletion. A cap
  // that gave up quietly with `removed: true` would be the same lie with more
  // steps.
  const lie = await call(ALICE, "/api/projects", "POST", { title: "Storage that lies" });
  const lieId = lie.json?.id;
  await call(ALICE, `/api/projects/${lieId}`, "PATCH", { videoPath: `${ALICE}/${lieId}/source.mp4` });
  storageDeleteIsALie = true;
  const refused = await call(ALICE, `/api/projects/${lieId}`, "DELETE");
  storageDeleteIsALie = false;
  check(
    "a delete that removes nothing is never reported as done",
    refused.status === 503,
    `got ${refused.status}`,
  );
  const cleanup = await call(ALICE, `/api/projects/${lieId}`, "DELETE");
  check("and succeeds once storage tells the truth again", cleanup.status === 204, `got ${cleanup.status}`);
}

console.log("\nA payment cannot be lost, reordered, or applied twice");
{
  const { createHmac: hmac } = await import("node:crypto");
  const psql = (sql, params = []) =>
    spawnSync("psql", [process.env.DATABASE_URL, "-tAc", sql, ...params.flatMap((p) => ["-v", p])], {
      encoding: "utf8",
    }).stdout.trim();

  const ALICE_EMAIL = "alice@example.test";
  const STRANGER_EMAIL = "paid-with-this-one@example.test";

  psql(`INSERT INTO auth.users (id, email) VALUES ('${ALICE}', '${ALICE_EMAIL}') ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`);
  psql(`DELETE FROM billing_events`);
  psql(`DELETE FROM subscriptions WHERE user_id = '${ALICE}'`);

  const send = async (body) => {
    const raw = JSON.stringify(body);
    const res = await fetch(`${BASE}/api/billing/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-signature": hmac("sha256", "webhook-secret-for-tests").update(raw).digest("hex"),
      },
      body: raw,
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };

  const planOf = (userId) => psql(`SELECT plan FROM subscriptions WHERE user_id = '${userId}'`);

  // 1. A real payment.
  const paid = await send({
    id: "evt-1",
    type: "license.created",
    created: "2026-08-15 12:00:00",
    objects: { license: { id: "L-PRO", plan_id: 9002, updated: "2026-08-15 12:00:00" }, user: { email: ALICE_EMAIL } },
  });
  check("a signed payment is accepted", paid.status === 200, JSON.stringify(paid));
  check("and the plan is granted", planOf(ALICE) === "pro", planOf(ALICE));
  check(
    "with the licence and the time recorded, which is what the next event is judged against",
    psql(`SELECT license_id FROM subscriptions WHERE user_id = '${ALICE}'`) === "L-PRO",
    psql(`SELECT license_id, plan_source_at FROM subscriptions WHERE user_id = '${ALICE}'`),
  );
  check("and the event is written down", psql(`SELECT outcome FROM billing_events WHERE event_id = 'fs_evt-1'`) === "applied");

  // 2. The bug. The cancellation of the *superseded* Creator licence, retried
  //    after the Pro event landed.
  const stale = await send({
    id: "evt-0",
    type: "license.cancelled",
    created: "2026-08-15 11:00:00",
    objects: { license: { id: "L-CREATOR", plan_id: 9001, updated: "2026-08-15 11:00:00" }, user: { email: ALICE_EMAIL } },
  });
  check("a retried cancellation is answered rather than retried forever", stale.status === 200, JSON.stringify(stale));
  check("but it does not take the plan away", planOf(ALICE) === "pro", planOf(ALICE));
  check("and the reason is on the row", psql(`SELECT outcome FROM billing_events WHERE event_id = 'fs_evt-0'`).length > 0);

  // 3. The same event delivered twice does nothing the second time.
  await send({
    id: "evt-1",
    type: "license.created",
    created: "2026-08-15 12:00:00",
    objects: { license: { id: "L-PRO", plan_id: 9002 }, user: { email: ALICE_EMAIL } },
  });
  check(
    "a redelivery of an event we have seen is one row, not two",
    psql(`SELECT count(*)::int FROM billing_events WHERE event_id = 'fs_evt-1'`) === "1",
    psql(`SELECT count(*)::int FROM billing_events WHERE event_id = 'fs_evt-1'`),
  );

  // 4. A real cancellation of the live licence still works. Every refusal above
  //    has to let this through, or we have built a product nobody can leave.
  const real = await send({
    id: "evt-2",
    type: "license.cancelled",
    created: "2026-09-01 00:00:00",
    objects: { license: { id: "L-PRO", plan_id: 9002 }, user: { email: ALICE_EMAIL } },
  });
  check("a cancellation of the live licence is applied", real.status === 200 && planOf(ALICE) === "free", planOf(ALICE));

  // 4b. The lookup that starts all of this must work *as the role the
  //     application actually connects with*. In production that is
  //     `editly_app`, and `auth.users` lives in a schema it cannot touch —
  //     querying it directly threw "permission denied" on every webhook, after
  //     the event was recorded and before anything was decided, so upgrades
  //     limped through the claim-on-read path and cancellations never applied
  //     at all. The suite missed it because psql here connects as a superuser.
  //     These two checks measure with the real role: the definer function
  //     answers, and the direct read it replaces is refused.
  // `psql -tAc` echoes "SET" for the role change before the query's result,
  // so the answer is the last line of stdout — and for the refused query, the
  // last line is the echo itself, because the SELECT produced only stderr.
  const asAppRole = (sql) => psql(`SET ROLE editly_app; ${sql}`).split("\n").pop();
  check(
    "the app role can ask who owns an email, through the definer function",
    asAppRole(`SELECT public.user_id_for_email('${ALICE_EMAIL}')`) === ALICE,
    asAppRole(`SELECT public.user_id_for_email('${ALICE_EMAIL}')`),
  );
  check(
    "and still cannot read auth.users itself",
    asAppRole(`SELECT count(*) FROM auth.users`) === "SET",
    "a row count coming back would mean the role can read the identity table directly",
  );
  // 4c. And the roles PostgREST hands to the outside world must NOT be able
  //     to ask it. Supabase's default privileges grant EXECUTE on every new
  //     public function to `anon` and `authenticated` directly — grants in
  //     their own right, which 0020's revoke-from-PUBLIC never touched. That
  //     put the function on /rest/v1/rpc for anyone holding the public anon
  //     key: an oracle mapping any email to whether an account exists here.
  //     0023 is the revoke; these measure it with the real roles.
  const asRole = (role, sql) => psql(`SET ROLE ${role}; ${sql}`).split("\n").pop();
  check(
    "the anonymous role cannot turn an email into an account",
    asRole("anon", `SELECT public.user_id_for_email('${ALICE_EMAIL}')`) === "SET",
    "an answer here is an email-enumeration oracle behind the public anon key",
  );
  check(
    "nor can a merely signed-in one",
    asRole("authenticated", `SELECT public.user_id_for_email('${ALICE_EMAIL}')`) === "SET",
    "signing up should not buy a directory of everyone else's addresses",
  );

  // 5. Somebody pays with an address that has no account. This used to be a 200
  //    with nothing written down anywhere: the money arrived and the record did
  //    not, and support had no way to reconcile it.
  const orphan = await send({
    id: "evt-3",
    type: "license.created",
    created: "2026-09-02 00:00:00",
    objects: { license: { id: "L-NEW", plan_id: 9003 }, user: { email: STRANGER_EMAIL } },
  });
  check("a payment from an unknown address is accepted, not retried forever", orphan.status === 200);
  check(
    "and it is kept, with the address on it, instead of forgotten",
    psql(`SELECT email FROM billing_events WHERE event_id = 'fs_evt-3'`) === STRANGER_EMAIL,
    psql(`SELECT email, outcome, user_id FROM billing_events WHERE event_id = 'fs_evt-3'`),
  );
  check(
    "unclaimed, so it can still be handed over",
    psql(`SELECT user_id IS NULL FROM billing_events WHERE event_id = 'fs_evt-3'`) === "t",
  );

  // 6. And handed over the moment an account with that address reads its plan.
  psql(`UPDATE auth.users SET email = '${STRANGER_EMAIL}' WHERE id = '${ALICE}'`);
  const claimingToken = await tokenFor(ALICE, { email: STRANGER_EMAIL });
  const claimed = await fetch(`${BASE}/api/subscription`, {
    headers: { Authorization: `Bearer ${claimingToken}` },
  }).then((r) => r.json());

  check("the waiting payment is applied on the next read", claimed.plan === "studio", JSON.stringify(claimed));
  check("the plan is really written, not just reported", planOf(ALICE) === "studio", planOf(ALICE));
  check(
    "and the event stops being unclaimed, so it is not re-examined forever",
    psql(`SELECT user_id FROM billing_events WHERE event_id = 'fs_evt-3'`) === ALICE,
    psql(`SELECT user_id, outcome FROM billing_events WHERE event_id = 'fs_evt-3'`),
  );

  psql(`DELETE FROM billing_events`);
  psql(`DELETE FROM subscriptions WHERE user_id = '${ALICE}'`);
  psql(`DELETE FROM auth.users WHERE id = '${ALICE}'`);
}

console.log("\nA failure on our side is a sentence, not a stack");
{
  // There was no error middleware at all, so every throw fell through to
  // Express's default handler. That handler sends HTML — which the generated
  // client parses as JSON and fails on, so a database blip reached the browser
  // as a parse error rather than as a status anybody could branch on — and it
  // sends the stack outside production, naming our files, our tables and
  // sometimes the query, to whoever made the request.

  // A body that is not JSON. This reaches the parser, which throws, which is
  // the shortest real path to the handler.
  const malformed = await fetch(`${BASE}/api/projects`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tokens[ALICE]}`, "Content-Type": "application/json" },
    body: "{not json at all",
  });
  const malformedText = await malformed.text();

  check("a body that is not JSON is a 400, not a 500", malformed.status === 400, `got ${malformed.status}`);
  check(
    "answered as JSON, because that is what the client parses",
    (malformed.headers.get("content-type") ?? "").includes("application/json"),
    malformed.headers.get("content-type"),
  );
  check("with no HTML in it", !/<html|<pre>/i.test(malformedText), malformedText.slice(0, 120));
  check("and no stack trace", !/\bat \/|\.ts:\d+|\.js:\d+/.test(malformedText), malformedText.slice(0, 200));
  check(
    "no path from this machine",
    !malformedText.includes("/home/") && !malformedText.includes("node_modules"),
    malformedText.slice(0, 200),
  );

  let parsed = null;
  try {
    parsed = JSON.parse(malformedText);
  } catch {
    /* the check below reports it */
  }
  check("the body is an object with an error string", typeof parsed?.error === "string", malformedText.slice(0, 200));
  check(
    "and a request id, so support can find the log line without the customer describing it",
    typeof parsed?.requestId === "string" && parsed.requestId.length > 0,
    JSON.stringify(parsed),
  );

  /*
    And it is a *different* id each time, which it was not.

    Nothing set one, so it was pino-http's default: an integer starting at 1
    and incrementing per process. On Vercel every invocation is a fresh
    process, so essentially every request in production was request number 1 —
    including the one in the 500 body this file just checked for. The field was
    populated, the shape was right, and support asking for it got "1" and a
    month of logs that all say 1.

    The shape check above passes either way, which is precisely why it needed
    this one beside it.
  */
  const again = await fetch(`${BASE}/api/projects`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tokens[ALICE]}`, "Content-Type": "application/json" },
    body: "{also not json",
  });
  const secondId = JSON.parse(await again.text())?.requestId;
  check(
    "and two failures do not share one",
    typeof secondId === "string" && secondId !== parsed?.requestId,
    `${parsed?.requestId} then ${secondId}`,
  );
  check(
    "it is long enough to be worth searching for",
    String(parsed?.requestId ?? "").length >= 8,
    String(parsed?.requestId),
  );

  /*
    It is on every response, not only the ones that failed.

    A person reporting "it was slow" or "it showed me the wrong thing" has no
    error body to read an id out of. The browser's network tab has this header.
  */
  const fine = await fetch(`${BASE}/api/projects`, {
    headers: { Authorization: `Bearer ${tokens[ALICE]}` },
  });
  const header = fine.headers.get("x-request-id");
  check("a successful response carries the id too", typeof header === "string" && header.length >= 8, String(header));

  /*
    And a caller's own id is honoured, so a report from another system joins up
    — but only if it is a string that is safe in a log line and in a header.
    Newlines forge log entries; a colon and a space forge a header.
  */
  const traced = await fetch(`${BASE}/api/projects`, {
    headers: { Authorization: `Bearer ${tokens[ALICE]}`, "x-request-id": "trace-abc123" },
  });
  check("a caller's own id is kept", traced.headers.get("x-request-id") === "trace-abc123", String(traced.headers.get("x-request-id")));

  const forged = await fetch(`${BASE}/api/projects`, {
    headers: { Authorization: `Bearer ${tokens[ALICE]}`, "x-request-id": "ok id with spaces" },
  });
  const forgedBack = forged.headers.get("x-request-id");
  check(
    "and one that is not is replaced rather than echoed",
    forgedBack !== "ok id with spaces" && String(forgedBack).length >= 8,
    String(forgedBack),
  );

  // A disallowed origin is a refusal, not an outage. It used to be a 500,
  // which makes an ordinary configuration mistake look like the product is
  // down.
  const badOrigin = await fetch(`${BASE}/api/projects`, {
    headers: { Authorization: `Bearer ${tokens[ALICE]}`, Origin: "https://not-our-frontend.example" },
  });
  const originText = await badOrigin.text();
  check("a disallowed origin is refused, not reported as broken", badOrigin.status === 403, `got ${badOrigin.status}`);
  check("in words rather than in a stack", !/\bat \/|node_modules/.test(originText), originText.slice(0, 160));

  // And the origins that are allowed still are — a handler that refuses
  // everything would pass every check above.
  const goodOrigin = await fetch(`${BASE}/api/projects`, {
    headers: { Authorization: `Bearer ${tokens[ALICE]}`, Origin: "http://localhost:5173" },
  });
  check("our own frontend still gets through", goodOrigin.status === 200, `got ${goodOrigin.status}`);
}

console.log("\nOne person cannot spend everybody's money");
{
  // There was no rate limiting anywhere, and the gap is not about scale — the
  // quota caps minutes of finished video and caps nothing else. Turning a
  // sentence into an edit plan is a paid model call that produces no minutes at
  // all, so it was unlimited, on the free plan, to anybody with a loop.
  const { spawnSync: run } = await import("node:child_process");
  const sql = (q) => run("psql", [process.env.DATABASE_URL, "-tAc", q], { encoding: "utf8" }).stdout.trim();

  // The arithmetic on its own, without a clock or a database. Bundled from the
  // real module so a change to it fails here rather than in production.
  const { mkdtemp: mkd, rm: rmd } = await import("node:fs/promises");
  const { tmpdir: tmp } = await import("node:os");
  const nodePath = await import("node:path");
  const rlDir = await mkd(nodePath.join(tmp(), "editly-rl-"));
  const rlOut = nodePath.join(rlDir, "rate-limit.mjs");
  const bundled = spawnSync(
    require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/api-server"] }),
    [
      "artifacts/api-server/src/lib/rate-limit.ts",
      "--bundle", "--platform=node", "--format=esm", "--target=node22",
      // The database, the framework and the logger are reached for at call
      // time; the arithmetic above them is what is under test here.
      "--external:@workspace/db", "--external:express",
      `--alias:pino=${nodePath.join(process.cwd(), "tools/fixtures/pino-stub.mjs")}`,
      `--outfile=${rlOut}`, "--log-level=error",
    ],
    { stdio: "inherit" },
  );
  check("the limiter bundles on its own", bundled.status === 0, "esbuild failed");

  const { verdictFor, LIMITS } = await import(pathToFileURL(rlOut).href);
  const started = new Date(Date.now() - 60_000);

  check("under the limit is allowed", verdictFor(5, started, 40, 600_000).allowed === true);
  check(
    "the request that reaches the limit exactly is still allowed — the limit is a ceiling, not a fence",
    verdictFor(40, started, 40, 600_000).allowed === true,
  );
  check("the one after it is not", verdictFor(41, started, 40, 600_000).allowed === false);
  check("what is left is reported honestly", verdictFor(38, started, 40, 600_000).remaining === 2);
  check("and never goes negative", verdictFor(99, started, 40, 600_000).remaining === 0);
  check(
    "the wait is what is left of the window, in seconds",
    verdictFor(41, started, 40, 600_000).retryAfterSeconds === 540,
    String(verdictFor(41, started, 40, 600_000).retryAfterSeconds),
  );
  check(
    "a window that has already run out asks for one second, not zero",
    verdictFor(41, new Date(Date.now() - 700_000), 40, 600_000).retryAfterSeconds === 1,
  );
  check(
    "a timestamp from the future is clock skew, not an hour-long lockout",
    verdictFor(41, new Date(Date.now() + 60_000), 40, 600_000).retryAfterSeconds <= 600,
  );
  // The floor is not one number, and it used to be — a flat 30, which was true
  // of every limit written while every limited action was one people repeat.
  // Joining a waiting list is a one-time act: six is six times over, and a
  // check demanding thirty there is asserting a number rather than the rule
  // the number came from. The rule is the ratio, and each limit now records
  // what one person doing the thing legitimately needs.
  check(
    "every limit sits at least five times above what one person needs",
    Object.values(LIMITS).every((l) => l.limit >= 5 * l.perPerson && l.windowMs >= 60_000),
    JSON.stringify(Object.values(LIMITS).map((l) => [l.name, l.perPerson, l.limit])),
  );
  check(
    "and every limit says what one person needs, so the ceiling can be read against something",
    Object.values(LIMITS).every((l) => Number.isFinite(l.perPerson) && l.perPerson >= 1),
    JSON.stringify(Object.values(LIMITS).map((l) => [l.name, l.perPerson])),
  );
  check(
    "and every one says what to do rather than quoting a number of milliseconds",
    Object.values(LIMITS).every((l) => l.message.length > 30 && !/\d+\s*ms/.test(l.message)),
  );

  /*
    And every limit is used by something.

    A borrowed limit is the failure this catches from the other side: two
    unrelated routes counting into one bucket, so tuning either moves the
    other. Scheduling posts borrowed `create-project` and the stock library
    borrowed `write` — whose own comment calls it "the small writes of an
    ordinary session", while `/stock/file/:id` proxies two hundred megabytes.

    What is checkable without guessing at intent is the other half: a limit
    nobody mounts is dead policy, and a route that reaches for one by name
    finds only the names that exist. Both halves of the table are read here, so
    adding an entry and forgetting to mount it fails.
  */
  {
    const routes = readdirSync(path.join(process.cwd(), "artifacts/api-server/src/routes"))
      .filter((f) => f.endsWith(".ts"))
      .map((f) => readFileSync(path.join(process.cwd(), "artifacts/api-server/src/routes", f), "utf8"))
      .join("\n");
    const unused = Object.keys(LIMITS).filter((key) => !routes.includes(`LIMITS.${key}`));
    check(
      "every limit in the table is mounted on a route",
      unused.length === 0,
      `${unused.join(", ")} exists and guards nothing`,
    );
  }

  /*
    And the doors that open before anybody has proved who they are.

    `routes/index.ts` mounts a handful of routers above `requireAuth`, because a
    payment provider, a platform's OAuth redirect and an uptime monitor all
    arrive with no token of ours. Above that line there is nobody to count
    against, so a limiter here has to key on the address; below it, the ordinary
    per-user limiter does the work.

    The OAuth callback had nothing at all. It is a plain GET anybody can cause,
    and every hit spends a signature verification and then a token exchange with
    Google or Meta, which is our rate budget at those platforms being spent by
    somebody else. Nothing failed while that was true; it simply had no floor.

    Two are exempt on purpose and the reasons are written here rather than
    remembered. `/billing/webhook` must never refuse a real payment event to
    save a little work, and it verifies an HMAC before it touches anything.
    `/healthz` reads only caches, which is why the two functions it calls say so
    in their own comments.
  */
  {
    const dir = path.join(process.cwd(), "artifacts/api-server/src/routes");
    const index = readFileSync(path.join(dir, "index.ts"), "utf8");
    const above = index.slice(0, index.indexOf("router.use(requireAuth)"));

    /*
      Which router in which file, read from the imports rather than listed here
      so a new pre-auth router is covered the day somebody mounts one.

      The distinction that matters is default versus named: `social.ts` exports
      both `socialCallbackRouter`, which is mounted above the line, and a
      default router mounted below it. Reading the whole file would report the
      authenticated half as unlimited, which it is not.
    */
    const mounted = [...above.matchAll(/router\.use\((\w+)\)/g)].map((m) => m[1]);
    const targets = [];
    for (const name of mounted) {
      const asDefault = index.match(new RegExp(`import\\s+${name}\\b[^;]*from\\s*"\\./([\\w-]+)"`));
      if (asDefault) {
        targets.push({ file: asDefault[1], identifier: "router" });
        continue;
      }
      const asNamed = index.match(new RegExp(`import[^;]*\\{[^}]*\\b${name}\\b[^}]*\\}[^;]*from\\s*"\\./([\\w-]+)"`));
      if (asNamed) targets.push({ file: asNamed[1], identifier: name });
    }

    check("the pre-auth routers were found", targets.length >= 5, JSON.stringify(targets));

    /** Public by design, and each one says why above. */
    const EXEMPT = [
      /\/billing\/webhook/,
      /\/healthz/,
      /*
        Shopify's four compliance webhooks, exempt on the same argument as the
        billing one and not a weaker version of it.

        Two of them are erasure requests with a thirty-day legal clock, and one
        is the uninstall that stops us acting on a shop that has left. Refusing
        a real one of those to save a little work is the failure; a 429 there is
        not backpressure, it is an obligation dropped. And like the billing
        webhook they verify an HMAC over the raw bytes before touching
        anything, so an unsigned flood costs one comparison and reaches no
        query.

        `/shopify/ads` is deliberately *not* here. It creates a project and
        pulls a dozen photographs, and it is limited — on the shop's own
        account id, through `rateLimitBy`, into the same `createProject` window
        a person pressing the button spends.
      */
      /\/shopify\/webhooks\//,
    ];

    const unlimited = [];
    for (const { file, identifier } of targets) {
      const source = readFileSync(path.join(dir, `${file}.ts`), "utf8");
      const pattern = new RegExp(`\\b${identifier}\\.(get|post|put|patch|delete)\\(\\s*([\\s\\S]{0,200})`, "g");
      for (const [, method, rest] of source.matchAll(pattern)) {
        const routePath = rest.match(/"([^"]+)"/)?.[1] ?? "?";
        if (EXEMPT.some((re) => re.test(routePath))) continue;
        // `rateLimitBy` counts as a limiter: it is the same window under a key
        // the caller's own door provides, for a route where `req.userId` is
        // never set because the authentication is not Supabase's.
        if (!/rateLimit(By|ByIp)?\(/.test(rest)) unlimited.push(`${method.toUpperCase()} ${routePath}`);
      }
    }
    check(
      "every route reachable without a token is rate limited, or exempt for a written reason",
      unlimited.length === 0,
      `${unlimited.join(", ")} is open to anybody with no floor under it`,
    );
  }
  await rmd(rlDir, { recursive: true, force: true });

  // And against the real app. The limit is lowered in the table rather than in
  // the code: what is under test is that the middleware is mounted and that the
  // counter is shared, not that 40 is 40.
  const made = await call(ALICE, "/api/projects", "POST", { title: "Rate limit" });
  const projectId = made.json?.id;
  check("a project can still be created normally", made.status === 201, `got ${made.status}`);

  // Everybody's, not just Alice's: the suite has been creating projects for
  // both of them all the way down this file, and what is under test here is the
  // limiter, not how busy the tests have been.
  sql(`DELETE FROM rate_limits`);
  const first = await call(ALICE, `/api/projects/${projectId}/messages`, "POST", { content: "cut the silences" });
  check("the first message goes through", first.status === 201 || first.status === 200, `got ${first.status}`);
  check(
    "and it was counted, in a row shared by every copy of the app",
    sql(`SELECT count FROM rate_limits WHERE bucket = '${ALICE}:chat'`) === "1",
    sql(`SELECT bucket, count FROM rate_limits WHERE bucket LIKE '${ALICE}:%'`),
  );

  // Put the counter one under the limit and send two more.
  sql(`UPDATE rate_limits SET count = 39, window_start = now() WHERE bucket = '${ALICE}:chat'`);
  const last = await call(ALICE, `/api/projects/${projectId}/messages`, "POST", { content: "again" });
  check("the last one inside the limit is served", last.status === 201 || last.status === 200, `got ${last.status}`);

  const refused = await call(ALICE, `/api/projects/${projectId}/messages`, "POST", { content: "and again" });
  check("the one past it is refused", refused.status === 429, `got ${refused.status}`);
  check("as a limit, with a flag the client can branch on", refused.json?.rateLimited === true, JSON.stringify(refused.json));
  check(
    "saying what to do rather than apologising vaguely",
    /minute/i.test(refused.json?.error ?? ""),
    refused.json?.error,
  );
  check("and how long to wait", Number(refused.json?.retryAfterSeconds) > 0, JSON.stringify(refused.json));

  // A limit is per person and per endpoint. Both halves matter: one noisy user
  // must not lock anybody else out, and hitting the chat limit must not stop
  // them from opening a project they already have.
  //
  // Asserted on the buckets rather than by making Bob create something: by this
  // point in the suite Bob's month is deliberately spent, so a refusal from him
  // would be the quota talking, not the limiter — and a check that cannot tell
  // those two apart is a check that will mislead somebody later.
  const buckets = sql(`SELECT string_agg(bucket, ',' ORDER BY bucket) FROM rate_limits`);
  check(
    "the counter is keyed by the person, so Alice's noise is Alice's alone",
    buckets.includes(`${ALICE}:chat`) && !buckets.includes(`${BOB}:chat`),
    buckets,
  );
  const bobReads = await call(BOB, "/api/projects");
  check("and somebody else is served normally", bobReads.status === 200, `got ${bobReads.status}`);

  const stillReads = await call(ALICE, `/api/projects/${projectId}`);
  check("the limited person can still read their own work", stillReads.status === 200, `got ${stillReads.status}`);

  const separateBucket = await call(ALICE, `/api/projects/${projectId}`, "PATCH", { title: "Renamed" });
  check(
    "and a different endpoint has a different budget",
    separateBucket.status === 200,
    `got ${separateBucket.status}`,
  );
  const aliceBuckets = sql(`SELECT string_agg(bucket, ',' ORDER BY bucket) FROM rate_limits WHERE bucket LIKE '${ALICE}:%'`);
  check(
    "which is a separate row, not a shared counter",
    aliceBuckets.includes(":chat") && aliceBuckets.includes(":write"),
    aliceBuckets,
  );

  // The window rolls. Ageing the row is the same thing as waiting ten minutes.
  sql(`UPDATE rate_limits SET window_start = now() - interval '20 minutes' WHERE bucket = '${ALICE}:chat'`);
  const afterWindow = await call(ALICE, `/api/projects/${projectId}/messages`, "POST", { content: "after the window" });
  check("the window rolls rather than locking somebody out forever", afterWindow.status !== 429, `got ${afterWindow.status}`);
  check(
    "and the count starts again rather than carrying on",
    Number(sql(`SELECT count FROM rate_limits WHERE bucket = '${ALICE}:chat'`)) === 1,
    sql(`SELECT count FROM rate_limits WHERE bucket = '${ALICE}:chat'`),
  );

  // One row per person per endpoint, reused. A table that grows per request is
  // a table somebody discovers in a year.
  check(
    "the table is bounded by people and endpoints, not by requests",
    Number(sql(`SELECT count(*)::int FROM rate_limits WHERE bucket LIKE '${ALICE}:%'`)) <= 4,
    sql(`SELECT bucket, count FROM rate_limits WHERE bucket LIKE '${ALICE}:%'`),
  );

  sql(`DELETE FROM rate_limits`);
  await call(ALICE, `/api/projects/${projectId}`, "DELETE");
}

// ── The admin console is a door, not a curtain ──────────────────────────────
console.log("\nThe admin console answers everyone but its allowlist with 404");
{
  const PATHS = ["/api/admin/overview", "/api/admin/accounts", "/api/admin/jobs", "/api/admin/actions"];

  for (const path of PATHS) {
    const bob = await call(BOB, path);
    check(`Bob gets 404 on ${path} — not 403, which would confirm it exists`, bob.status === 404, `got ${bob.status}`);
  }

  // The four that change something. A gate that covers the reads and not the
  // writes is not a gate, and this is the direction that would cost real money.
  const WRITES = [
    [`/api/admin/jobs/whatever/requeue`, { reason: "trying it on" }],
    [`/api/admin/accounts/${ALICE}/minutes`, { minutes: 600, reason: "trying it on" }],
    [`/api/admin/accounts/${ALICE}/plan`, { plan: "studio", reason: "trying it on" }],
    [`/api/admin/accounts/${ALICE}/suspend`, { suspended: true, reason: "trying it on" }],
  ];
  for (const [path, body] of WRITES) {
    const bob = await call(BOB, path, "POST", body);
    check(`Bob cannot POST ${path}`, bob.status === 404, `got ${bob.status}`);
  }
  const aliceStillFree = await call(ALICE, "/api/subscription");
  check(
    "and none of it landed — Bob could not give himself, or Alice, a plan",
    aliceStillFree.json?.plan !== "studio",
    JSON.stringify(aliceStillFree.json?.plan),
  );

  const anon = await fetch(`${BASE}/api/admin/overview`);
  check("and an anonymous caller is refused before the allowlist is even consulted", anon.status === 401, `got ${anon.status}`);

  const overview = await call(ALICE, "/api/admin/overview");
  check("the admin is let in", overview.status === 200, `got ${overview.status}`);
  check(
    "the queue is reported in the three states that mean different things",
    typeof overview.json?.queue?.processing === "number" &&
      typeof overview.json?.queue?.waiting === "number" &&
      typeof overview.json?.queue?.unattended === "number",
    JSON.stringify(overview.json?.queue),
  );
  check(
    "the worker's own answer is carried, not inferred from the queue",
    typeof overview.json?.worker?.online === "boolean",
    JSON.stringify(overview.json?.worker),
  );
  check(
    "revenue is what the plans actually cost, summed",
    typeof overview.json?.revenue?.monthlyRecurringUsd === "number" &&
      Array.isArray(overview.json?.revenue?.byPlan),
    JSON.stringify(overview.json?.revenue),
  );
  check(
    "and nothing on the overview carries a video, a path or a signed URL",
    !/\bvideoPath|storagePath|outputPath|signedUrl|https:\/\/[^"]*\/storage\//.test(
      JSON.stringify(overview.json),
    ),
    JSON.stringify(overview.json).slice(0, 200),
  );

  // Seeded first, and that is the point of this check rather than a detail of
  // it. The accounts list reads `auth.users` through a definer function, and
  // the first version of the route read the driver's result object as if it
  // were the row array — which does not throw, it yields nothing. Against an
  // empty stand-in table that is indistinguishable from working, and it
  // shipped: the console showed "Nobody yet." beside a card counting one
  // account. An empty fixture cannot tell an empty answer from a broken one.
  psqlGlobal(
    `insert into auth.users (id, email) values ('${ALICE}', 'alice@example.com') on conflict (id) do nothing`,
  );

  const accounts = await call(ALICE, "/api/admin/accounts?limit=5");
  check("the accounts page is served", accounts.status === 200, `got ${accounts.status}`);
  check(
    "and it actually contains the account that exists",
    (accounts.json?.accounts ?? []).some((a) => a.email === "alice@example.com"),
    JSON.stringify(accounts.json?.accounts),
  );
  check(
    "with a total counted independently of the page — a total derived from a page lies on page two",
    typeof accounts.json?.total === "number" && accounts.json.total >= (accounts.json?.accounts?.length ?? 0),
    JSON.stringify({ total: accounts.json?.total, page: accounts.json?.accounts?.length }),
  );
  check(
    "and a total that is not zero when somebody is there",
    (accounts.json?.total ?? 0) >= 1,
    String(accounts.json?.total),
  );
  check(
    "each row carries what the account has used, joined from our own tables",
    typeof accounts.json?.accounts?.[0]?.minutesUsedThisMonth === "number" &&
      typeof accounts.json?.accounts?.[0]?.plan === "string",
    JSON.stringify(accounts.json?.accounts?.[0]),
  );

  const found = await call(ALICE, "/api/admin/accounts?q=alice");
  check(
    "searching by address finds them",
    (found.json?.accounts ?? []).some((a) => a.email === "alice@example.com"),
    JSON.stringify(found.json?.accounts),
  );
  const absent = await call(ALICE, "/api/admin/accounts?q=nobody-by-this-name");
  check(
    "and searching for somebody who is not there finds nobody",
    (absent.json?.accounts ?? []).length === 0 && absent.json?.total === 0,
    JSON.stringify(absent.json),
  );

  const jobs = await call(ALICE, "/api/admin/jobs?limit=5");
  check("the jobs page is served", jobs.status === 200, `got ${jobs.status}`);
  check(
    "every job carries its error verbatim or null — never a reassuring rewrite",
    (jobs.json?.jobs ?? []).every((job) => job.error === null || typeof job.error === "string"),
    JSON.stringify((jobs.json?.jobs ?? []).slice(0, 2)),
  );
  /**
   * The render that worked and did nothing.
   *
   * The console could see a render succeed and could read the message when one
   * failed. The case that actually arrives in support is neither: it finished,
   * it is green, and it did not do what was asked. There is no error on that
   * row and never will be — the only record is what the renderer wrote as it
   * decided, and until now that never left the worker.
   */
  const notedJobId = "admin-notes-test-job";
  psqlGlobal(
    `insert into jobs (id, project_id, user_id, status, plan, input_path, notes, created_at, updated_at) ` +
      `values ('${notedJobId}', '${aliceProjectId}', '${ALICE}', 'done', ` +
      `'{"version":1,"operations":[]}'::jsonb, '${ALICE}/${aliceProjectId}/source.mp4', ` +
      `'["there is no music under this edit, so there was no beat to cut to"]'::jsonb, now(), now())`,
  );
  const noted = await call(ALICE, "/api/admin/jobs?limit=200");
  const notedRow = (noted.json?.jobs ?? []).find((job) => job.id === notedJobId);
  check("the console can read what a render said it did", Boolean(notedRow), `job ${notedJobId} not in the page`);
  check(
    "verbatim, which is the only reason it is worth showing",
    notedRow?.notes?.[0] === "there is no music under this edit, so there was no beat to cut to",
    JSON.stringify(notedRow?.notes),
  );
  check(
    "and a render that said nothing carries null rather than a missing field",
    (noted.json?.jobs ?? []).every((job) => job.notes === null || Array.isArray(job.notes)),
    JSON.stringify((noted.json?.jobs ?? []).map((j) => j.notes).slice(0, 3)),
  );
  psqlGlobal(`delete from jobs where id = '${notedJobId}'`);

  /*
    The render that failed, and the two different sentences about it.

    `jobs.error` is written for the person waiting on the video, so anything
    that is not a plan, length or transfer problem reads "Rendering failed. We
    are looking into it." This console was reading that column and calling it
    the error — its own schema said "carried verbatim rather than prettified" —
    so every failure worth opening the console for arrived already stripped of
    its answer, which lived in a log line on Fly instead.

    Both are checked here, and so is the thing that makes a second column safe:
    that it reaches the console and nowhere else.
  */
  const detailJobId = "admin-detail-test-job";
  psqlGlobal(
    `insert into jobs (id, project_id, user_id, status, plan, input_path, error, error_detail, created_at, updated_at) ` +
      `values ('${detailJobId}', '${aliceProjectId}', '${ALICE}', 'failed', ` +
      `'{"version":1,"operations":[]}'::jsonb, '${ALICE}/${aliceProjectId}/source.mp4', ` +
      `'Rendering failed. We are looking into it.', ` +
      `'TypeError: Cannot read properties of undefined (reading ''duration'')', now(), now())`,
  );
  const detailed = await call(ALICE, "/api/admin/jobs?limit=200");
  const detailRow = (detailed.json?.jobs ?? []).find((job) => job.id === detailJobId);
  check("the console can read what actually went wrong", Boolean(detailRow), `job ${detailJobId} not in the page`);
  check(
    "unedited, because the whole point is that it was not written for a customer",
    detailRow?.errorDetail === "TypeError: Cannot read properties of undefined (reading 'duration')",
    JSON.stringify(detailRow?.errorDetail),
  );
  check(
    "beside what the customer was told, which is a different question",
    detailRow?.error === "Rendering failed. We are looking into it.",
    JSON.stringify(detailRow?.error),
  );

  // And the reason a second column is allowed to exist at all: no route a
  // customer can reach hands it back. `serializeJob` names its fields one at a
  // time, and this is the check that says so out loud.
  const ownStatus = await call(ALICE, `/api/projects/${aliceProjectId}/export/status`);
  const ownMessages = await call(ALICE, `/api/projects/${aliceProjectId}/messages`);
  const ownProject = await call(ALICE, `/api/projects/${aliceProjectId}`);
  for (const [what, response] of [
    ["the export status", ownStatus],
    ["the conversation", ownMessages],
    ["the project", ownProject],
  ]) {
    const body = JSON.stringify(response.json ?? {});
    check(
      `${what} never carries the operator's copy of the failure`,
      !/errorDetail|error_detail/.test(body),
      body.slice(0, 200),
    );
  }
  psqlGlobal(`delete from jobs where id = '${detailJobId}'`);

  const failedOnly = await call(ALICE, "/api/admin/jobs?status=failed&limit=5");
  check(
    "and filtering by status returns only that status",
    failedOnly.status === 200 && (failedOnly.json?.jobs ?? []).every((job) => job.status === "failed"),
    JSON.stringify((failedOnly.json?.jobs ?? []).map((j) => j.status)),
  );

  // ── The console's vocabulary is the queue's vocabulary ────────────────────
  //
  // This file spelled a running job `"processing"`, in four places, and not one
  // of them raised anything: a status nothing writes simply matches nothing.
  // The overview's queue card never fetched running jobs, so "Rendering now"
  // could only ever be zero; `?status=running` was not a known filter, so the
  // filter was dropped and *every* job came back as though it matched; and the
  // refusal that stops an admin requeueing a job a live worker is holding
  // compared against a string the worker never sets, so it was unreachable
  // code and two workers could be put on the same job.
  //
  // A filter for a status that exists must not answer with rows that are not in
  // it — which is the shape of the bug, not the spelling of it.
  {
    const runningJobId = "admin-running-test-job";
    // Its own project: `jobs_one_active_per_project` is a partial unique index,
    // and Alice's project already has an active job by this point in the file.
    const runningHome = await call(ALICE, "/api/projects", "POST", { title: "a render in flight" });
    const runningProjectId = runningHome.json?.id;
    psqlGlobal(
      `insert into jobs (id, project_id, user_id, status, progress, plan, input_path, attempts, locked_at, created_at, updated_at) ` +
        `values ('${runningJobId}', '${runningProjectId}', '${ALICE}', 'running', 40, ` +
        `'{"version":1,"operations":[]}'::jsonb, '${ALICE}/${runningProjectId}/source.mp4', 1, now(), now(), now())`,
    );
    const running = await call(ALICE, "/api/admin/jobs?status=running&limit=50");
    check(
      "a filter for `running` is a filter the console knows",
      running.status === 200 && (running.json?.jobs ?? []).every((job) => job.status === "running"),
      JSON.stringify((running.json?.jobs ?? []).map((j) => j.status)),
    );
    check(
      "and it finds the running job rather than answering empty",
      (running.json?.jobs ?? []).some((job) => job.id === runningJobId),
      JSON.stringify((running.json?.jobs ?? []).map((j) => j.id)),
    );

    const overview = await call(ALICE, "/api/admin/overview");
    check(
      "and the queue card counts it, rather than reading zero while a machine works",
      (overview.json?.queue?.processing ?? 0) + (overview.json?.queue?.unattended ?? 0) >= 1,
      JSON.stringify(overview.json?.queue),
    );

    // A status nobody writes must not be quietly treated as "no filter".
    const nonsense = await call(ALICE, "/api/admin/jobs?status=processing&limit=50");
    check(
      "and a status the queue does not use returns nothing, not everything",
      (nonsense.json?.jobs ?? []).length === 0,
      `${(nonsense.json?.jobs ?? []).length} rows came back for a status that is never written`,
    );

    psqlGlobal(`delete from jobs where id = '${runningJobId}'`);
    await call(ALICE, `/api/projects/${runningProjectId}`, "DELETE");
  }

  // ── Acting, and being unable to act without saying why ────────────────────
  {
    const before = await call(ALICE, "/api/admin/actions?limit=1");
    const countBefore = before.json?.total ?? 0;

    const noReason = await call(ALICE, `/api/admin/accounts/${BOB}/minutes`, "POST", { minutes: 10 });
    check("an action with no reason is refused", noReason.status === 400, `got ${noReason.status}`);
    const thinReason = await call(ALICE, `/api/admin/accounts/${BOB}/minutes`, "POST", {
      minutes: 10,
      reason: "eh",
    });
    check("and so is a reason too short to mean anything", thinReason.status === 400, `got ${thinReason.status}`);

    const afterRefusals = await call(ALICE, "/api/admin/actions?limit=1");
    check(
      "a refused action writes nothing — the log records what happened, not what was attempted",
      (afterRefusals.json?.total ?? 0) === countBefore,
      `${afterRefusals.json?.total} vs ${countBefore}`,
    );

    // Minutes. The grant is the audit row: there is no other table, so the
    // meter and the log cannot disagree about whether one was made.
    const usageBefore = await call(BOB, "/api/subscription");
    const includedBefore = usageBefore.json?.minutesIncluded ?? 0;
    const grantedBefore = usageBefore.json?.minutesGranted ?? 0;

    const granted = await call(ALICE, `/api/admin/accounts/${BOB}/minutes`, "POST", {
      minutes: 25,
      reason: "goodwill after the outage",
    });
    check("a grant with a reason is accepted", granted.status === 204, `got ${granted.status}`);

    const usageAfter = await call(BOB, "/api/subscription");
    check(
      "and the meter can see it — the allowance actually grew",
      (usageAfter.json?.minutesIncluded ?? 0) === includedBefore + 25,
      `${usageAfter.json?.minutesIncluded} vs ${includedBefore}`,
    );
    check(
      "and says how much of the allowance was given rather than paid for",
      (usageAfter.json?.minutesGranted ?? 0) - grantedBefore === 25,
      `${usageAfter.json?.minutesGranted} vs ${grantedBefore}`,
    );

    const log = await call(ALICE, "/api/admin/actions?limit=5");
    const entry = (log.json?.actions ?? []).find((a) => a.action === "grant_minutes");
    check("the grant is in the log", Boolean(entry), JSON.stringify(log.json?.actions?.slice(0, 2)));
    check("with the reason as typed", entry?.reason === "goodwill after the outage", entry?.reason);
    check("and the name of whoever did it", entry?.actorUserId === ALICE, entry?.actorUserId);
    check("against the person it was done to", entry?.subjectUserId === BOB, entry?.subjectUserId);

    // Suspension stops new work and destroys nothing.
    const suspended = await call(ALICE, `/api/admin/accounts/${BOB}/suspend`, "POST", {
      suspended: true,
      reason: "chargeback while we sort it out",
    });
    check("an account can be suspended", suspended.status === 204, `got ${suspended.status}`);

    const bobProject = await call(BOB, "/api/projects", "POST", { title: "still mine" });
    check(
      "a suspended account still has its work and can still make a project",
      bobProject.status === 201,
      `got ${bobProject.status}`,
    );
    const bobRender = await call(BOB, `/api/projects/${bobProject.json?.id}/render`, "POST", {
      plan: { version: 1, operations: [{ type: "removeSilence" }] },
    });
    check("but cannot start a render", bobRender.status === 403, `got ${bobRender.status}`);
    check(
      "and is told plainly that nothing was deleted",
      /nothing has been deleted/i.test(bobRender.json?.error ?? ""),
      bobRender.json?.error,
    );

    // The other door.
    //
    // Suspension was enforced in `start-render`, which the editor's button and
    // the chat both go through — and Export has its own route. It read the
    // whole subscription row, used only the plan from it, and queued the job:
    // 202, rendered, billed, with nothing anywhere reporting that a suspended
    // account was still consuming render capacity. The suspension *looked*
    // applied; one of the two doors was not locked.
    //
    // The refusal lives in `decideRender` now, which both doors already had to
    // call, so this is a check on the arrangement rather than on somebody
    // remembering. A third door would inherit it.
    const bobExport = await call(BOB, `/api/projects/${bobProject.json?.id}/export`, "POST", {
      platform: "tiktok",
    });
    check(
      "and cannot start one through Export either",
      bobExport.status === 403,
      `got ${bobExport.status}: ${JSON.stringify(bobExport.json)}`,
    );
    check(
      "with the same sentence, because it is the same refusal",
      /nothing has been deleted/i.test(bobExport.json?.error ?? ""),
      bobExport.json?.error,
    );

    // The third door, which was open.
    //
    // Opening a clip creates a project row and copies a video file, and it was
    // the one path in the product that could do both with no limiter and no
    // policy check at all. A suspended account could keep minting projects and
    // stored copies through it, one per call, for as long as it had ever run a
    // clips render. Same refusal, from the same `decideRender`, for the same
    // reason the Export door got it.
    psqlGlobal(`
      INSERT INTO clips (id, project_id, user_id, job_id, idx, start_seconds, end_seconds, output_path, output_seconds, note, thumbnail_path)
      VALUES ('clip-iso-susp', '${bobProject.json?.id}', '${BOB}', 'job-iso-1', 1, 1, 6,
              '${BOB}/${bobProject.json?.id}/clip-susp-1.mp4', 5, null, null)`);
    const bobOpen = await call(
      BOB,
      `/api/projects/${bobProject.json?.id}/clips/clip-iso-susp/open`,
      "POST",
    );
    check(
      "and cannot open a clip into a new project either",
      bobOpen.status === 403,
      `got ${bobOpen.status}: ${JSON.stringify(bobOpen.json)}`,
    );
    check(
      "with that same sentence again, because it is that same refusal",
      /nothing has been deleted/i.test(bobOpen.json?.error ?? ""),
      bobOpen.json?.error,
    );
    // And nothing was created on the way to being refused.
    check(
      "and no project was written before the refusal",
      psqlGlobalRead(
        `select count(*) from projects where user_id = '${BOB}' and title like '%clip%'`,
      ).trim() === "0",
      psqlGlobalRead(`select id, title from projects where user_id = '${BOB}'`),
    );
    psqlGlobal(`DELETE FROM clips WHERE id = 'clip-iso-susp'`);

    const restored = await call(ALICE, `/api/admin/accounts/${BOB}/suspend`, "POST", {
      suspended: false,
      reason: "sorted, restoring the account",
    });
    check("and it can be restored", restored.status === 204, `got ${restored.status}`);
    await call(BOB, `/api/projects/${bobProject.json?.id}`, "DELETE");

    // A finished render is never requeued: that would bill for it twice.
    const finished = await call(ALICE, "/api/admin/jobs?status=done&limit=1");
    const doneJob = (finished.json?.jobs ?? [])[0];
    if (doneJob) {
      const twice = await call(ALICE, `/api/admin/jobs/${doneJob.id}/requeue`, "POST", {
        reason: "seeing whether it lets me",
      });
      check("a finished render cannot be requeued", twice.status === 409, `got ${twice.status}`);
    } else {
      check("a finished render cannot be requeued — none present to try", true);
    }
    const missingJob = await call(ALICE, "/api/admin/jobs/not-a-real-job/requeue", "POST", {
      reason: "checking the missing case",
    });
    check("and a job that does not exist is a 404", missingJob.status === 404, `got ${missingJob.status}`);
  }

  // The allowlist itself, on its own. The unset case is the one that matters:
  // it must mean *nobody*, never everybody and never the first user, because
  // that failure is silent and looks fine everywhere except production.
  const { mkdtemp: mkd } = await import("node:fs/promises");
  const { tmpdir: tmp } = await import("node:os");
  const nodePath = await import("node:path");
  const adminDir = await mkd(nodePath.join(tmp(), "editly-admin-"));

  const bundleAdmin = (outfile) =>
    spawnSync(
      require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/api-server"] }),
      [
        "artifacts/api-server/src/lib/admin.ts",
        "--bundle", "--platform=node", "--format=esm", "--target=node22",
        `--outfile=${outfile}`, "--log-level=error",
      ],
      { stdio: "inherit" },
    );

  const withList = nodePath.join(adminDir, "admin-with-list.mjs");
  const withoutList = nodePath.join(adminDir, "admin-without-list.mjs");
  check("the allowlist bundles on its own", bundleAdmin(withList).status === 0 && bundleAdmin(withoutList).status === 0);

  process.env.ADMIN_USER_IDS = `${ALICE}, ${BOB.toUpperCase()}`;
  const listed = await import(pathToFileURL(withList).href);
  check("an id on the list is an admin", listed.isAdmin(ALICE) === true);
  check("and matching is case-insensitive, because ids get pasted", listed.isAdmin(BOB) === true);
  check("anyone else is not", listed.isAdmin("33333333-3333-4333-8333-333333333333") === false);
  check("neither is nobody", listed.isAdmin(null) === false && listed.isAdmin("") === false);
  check("and the count is reported without the ids", listed.adminCount() === 2);

  delete process.env.ADMIN_USER_IDS;
  const unset = await import(pathToFileURL(withoutList).href);
  check("with no list configured, nobody is an admin", unset.isAdmin(ALICE) === false);
  check("not the first user either", unset.isAdmin(BOB) === false);
  check("and the count says so", unset.adminCount() === 0);
  process.env.ADMIN_USER_IDS = ALICE;
}

// ── The one public write in the product ─────────────────────────────────────
console.log("\nThe waiting list takes anyone, and is the only thing that does");
{
  psqlGlobal(`delete from waitlist where email like '%@iso-test.invalid'`);
  psqlGlobal(`delete from rate_limits where bucket like 'ip:%'`);

  const join = (body, headers = {}) =>
    fetch(`${BASE}/api/waitlist`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

  // No token at all. Every other write in this file is 401 without one; this is
  // the single exception, and it is the point of a waiting list.
  const first = await join({ email: "Someone@ISO-test.invalid ", source: "editlyai.io" });
  check("somebody with no account can join", first.status === 201, `got ${first.status}`);
  check("and is told they are on it", first.json?.joined === true, JSON.stringify(first.json));
  check(
    "with the size of the list, not a position we would have to break later",
    typeof first.json?.total === "number" && first.json.total >= 1,
    JSON.stringify(first.json),
  );

  const stored = psqlGlobalRead(
    `select email, source from waitlist where email = 'someone@iso-test.invalid'`,
  );
  check(
    "the address is stored trimmed and lowercased, so the primary key can do its job",
    stored.includes("someone@iso-test.invalid"),
    stored,
  );
  check("and the page it came from is kept", stored.includes("editlyai.io"), stored);

  // Signing up twice is somebody clicking again, not an error.
  const again = await join({ email: "someone@iso-test.invalid" });
  check("signing up twice is not an error", again.status === 201, `got ${again.status}`);
  const rows = psqlGlobalRead(
    `select count(*)::int from waitlist where email = 'someone@iso-test.invalid'`,
  );
  check("and does not make a second row", rows.trim() === "1", rows);

  const bad = await join({ email: "not-an-address" });
  check("an address that is not one is refused", bad.status === 400, `got ${bad.status}`);
  const empty = await join({});
  check("and so is no address at all", empty.status === 400, `got ${empty.status}`);

  // The source is a label, not a payload: bounded server-side whatever arrives.
  await join({ email: "long-source@iso-test.invalid", source: "x".repeat(400) });
  const sourceLength = psqlGlobalRead(
    `select coalesce(length(source),0)::int from waitlist where email = 'long-source@iso-test.invalid'`,
  );
  check("a source longer than the column expects is cut, not stored whole", Number(sourceLength.trim()) <= 120, sourceLength);

  // Open with no limit is an invitation to fill the table. The limiter here
  // keys on the address rather than the user, because there is no user.
  psqlGlobal(`delete from rate_limits where bucket like 'ip:%'`);
  let limited = null;
  for (let i = 0; i < 9 && limited === null; i += 1) {
    const attempt = await join(
      { email: `flood-${i}@iso-test.invalid` },
      { "x-forwarded-for": "203.0.113.7, 70.41.3.18" },
    );
    if (attempt.status === 429) limited = attempt;
  }
  check("a script looping on it is stopped", limited !== null, "never rate limited");
  check(
    "and told what happened rather than left guessing",
    typeof limited?.json?.error === "string" && limited.json.error.length > 0,
    JSON.stringify(limited?.json),
  );
  const bucket = psqlGlobalRead(`select bucket from rate_limits where bucket like 'ip:203.0.113.7:%'`);
  /*
    And the platform's own header wins over the client's.

    `x-forwarded-for` is a header the caller can send, and this used to take its
    first entry — so anybody who set their own got a fresh bucket per request
    and walked past both public limiters. Vercel writes
    `x-vercel-forwarded-for` itself and strips any copy arriving from outside,
    which makes it the one address on the request a caller cannot choose.
  */
  psqlGlobal(`delete from rate_limits where bucket like 'ip:%'`);
  await join(
    { email: "spoof@iso-test.invalid" },
    { "x-vercel-forwarded-for": "198.51.100.9", "x-forwarded-for": "203.0.113.99" },
  );
  const trusted = psqlGlobalRead(`select bucket from rate_limits where bucket like 'ip:198.51.100.9:%'`);
  const spoofed = psqlGlobalRead(`select bucket from rate_limits where bucket like 'ip:203.0.113.99:%'`);
  check(
    "the platform's address is the one counted",
    Boolean(trusted) && !spoofed,
    `trusted=${trusted ?? "none"} spoofed=${spoofed ?? "none"}`,
  );
  psqlGlobal(`delete from rate_limits where bucket like 'ip:%'`);
  check(
    "keyed on the client address, not on the edge node that forwarded it",
    bucket.includes("203.0.113.7") && !bucket.includes("70.41.3.18"),
    bucket,
  );

  // A different address is a different person and is not punished for it.
  const other = await join(
    { email: "elsewhere@iso-test.invalid" },
    { "x-forwarded-for": "198.51.100.4" },
  );
  check("somebody else at another address still gets through", other.status === 201, `got ${other.status}`);

  // The list is written by anyone and read by nobody but the console.
  const bobsPeek = await call(BOB, "/api/admin/waitlist");
  check("a signed-in stranger cannot read the list", bobsPeek.status === 404, `got ${bobsPeek.status}`);
  const anonPeek = await fetch(`${BASE}/api/admin/waitlist`);
  check("and neither can somebody with no account", anonPeek.status === 401, `got ${anonPeek.status}`);

  const list = await call(ALICE, "/api/admin/waitlist");
  check("the console can", list.status === 200, `got ${list.status}`);
  check(
    "and sees the addresses that joined",
    (list.json?.entries ?? []).some((e) => e.email === "someone@iso-test.invalid"),
    JSON.stringify(list.json?.entries?.slice(0, 3)),
  );
  check("newest first", (() => {
    const dates = (list.json?.entries ?? []).map((e) => new Date(e.createdAt).getTime());
    return dates.every((d, i) => i === 0 || dates[i - 1] >= d);
  })(), JSON.stringify(list.json?.entries?.slice(0, 3)));

  psqlGlobal(`delete from waitlist where email like '%@iso-test.invalid'`);
  psqlGlobal(`delete from rate_limits where bucket like 'ip:%'`);
}

// Leave the database as we found it.
{
  const del = await call(ALICE, `/api/projects/${aliceProjectId}`, "DELETE");
  check("test data cleaned up", del.status === 204, `got ${del.status}`);
  sweepSeededJobs();
  sweepSeededGrants();
  sweepSeededUsers();
}

server.close();
jwksServer.close();

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("Isolation holds.");
