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
      const prefix = (() => {
        try {
          return JSON.parse(body).prefix;
        } catch {
          return null;
        }
      })();
      storageCalls.push({ op: "list", prefix });
      if (storageFailsWith) return res.writeHead(storageFailsWith).end("{}");
      res.writeHead(200, { "Content-Type": "application/json" });
      // One object per project, which is enough for the route to have something
      // to delete and therefore something to fail at.
      res.end(JSON.stringify([{ name: "source.mp4", id: "obj-1" }]));
    });
    return;
  }
  if (req.method === "DELETE" && req.url === "/storage/v1/object/videos") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      storageCalls.push({ op: "delete", body });
      if (storageFailsWith) return res.writeHead(storageFailsWith).end("{}");
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
process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:5432/editly_test";

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
  return { status: res.status, json, text };
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
  // Sentences in this section started renders — that is now the point of a
  // sentence. Cleared here so the sections below still measure the button
  // door from a clean queue.
  psqlGlobal(`DELETE FROM jobs WHERE project_id = '${aliceProjectId}'`);

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
  check("a stalled render is counted as waiting, not as processing", stats.json?.stalledCount >= 1, JSON.stringify(stats.json?.stalledCount));
  check(
    "and it is not also counted as processing",
    stats.json?.processingCount === 0,
    JSON.stringify(stats.json?.processingCount),
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
  check(
    "every limit is well above what the product's own copy invites",
    Object.values(LIMITS).every((l) => l.limit >= 30 && l.windowMs >= 60_000),
    JSON.stringify(Object.values(LIMITS).map((l) => [l.name, l.limit])),
  );
  check(
    "and every one says what to do rather than quoting a number of milliseconds",
    Object.values(LIMITS).every((l) => l.message.length > 30 && !/\d+\s*ms/.test(l.message)),
  );
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

// Leave the database as we found it.
{
  const del = await call(ALICE, `/api/projects/${aliceProjectId}`, "DELETE");
  check("test data cleaned up", del.status === 204, `got ${del.status}`);
  sweepSeededJobs();
}

server.close();
jwksServer.close();

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("Isolation holds.");
