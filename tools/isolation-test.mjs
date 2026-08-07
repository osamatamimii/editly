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

const jwksServer = http.createServer((req, res) => {
  if (req.url === "/auth/v1/.well-known/jwks.json") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ keys: [jwk] }));
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
process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:5432/editly_test";

console.log("Rebuilding the API bundle against the local test issuer...");
const buildResult = spawnSync(
  process.execPath,
  ["artifacts/api-server/build-vercel.mjs"],
  {
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, SUPABASE_URL: ISSUER_BASE },
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

  const health = await fetch(`${BASE}/api/healthz`);
  check("health check stays public", health.status === 200, `got ${health.status}`);
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

  const shallow = await call(ALICE, `/api/projects/${aliceProjectId}`, "PATCH", {
    videoPath: `${ALICE}/source.mp4`,
  });
  check("a key missing the project segment is refused", shallow.status === 400, `got ${shallow.status}`);

  const edited = await call(ALICE, `/api/projects/${aliceProjectId}`, "PATCH", {
    editedVideoPath: `${BOB}/${aliceProjectId}/edited.mp4`,
  });
  check("editedVideoPath is validated too", edited.status === 400, `got ${edited.status}`);

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
  check(
    "the platform comes from what was actually asked for",
    understood.json?.plan?.operations?.find((o) => o.type === "formatForPlatform")?.platform === "tiktok",
    JSON.stringify(understood.json?.plan),
  );

  const unsupported = await call(ALICE, `/api/projects/${aliceProjectId}/messages`, "POST", {
    content: "add some zooms and emojis and a cinematic colour grade",
  });
  const unsupportedTypes = (unsupported.json?.plan?.operations ?? []).map((o) => o.type);
  check("nothing is invented for operations that do not exist", unsupportedTypes.length === 0, JSON.stringify(unsupportedTypes));
  check(
    "and it says so rather than promising",
    /can't|cannot/i.test(unsupported.json?.aiMessage?.content ?? ""),
    unsupported.json?.aiMessage?.content,
  );

  const nonsense = await call(ALICE, `/api/projects/${aliceProjectId}/messages`, "POST", {
    content: "asdfghjkl",
  });
  check(
    "an unparseable request asks for a clearer one",
    /not sure/i.test(nonsense.json?.aiMessage?.content ?? "") && nonsense.json?.plan === null,
    nonsense.json?.aiMessage?.content,
  );
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
}

console.log("\nPer-user statistics and quota");
{
  const alice = await call(ALICE, "/api/stats/dashboard");
  const bob = await call(BOB, "/api/stats/dashboard");
  check("Alice's stats count her project", alice.json?.totalProjects >= 1, JSON.stringify(alice.json));
  check("Bob's stats are empty", bob.json?.totalProjects === 0, JSON.stringify(bob.json));

  const aliceSub = await call(ALICE, "/api/subscription");
  check(
    "quota is counted per user, not globally",
    aliceSub.json?.videosUsedThisMonth === alice.json?.totalProjects,
    JSON.stringify(aliceSub.json),
  );
}

console.log("\nBilling integrity");
{
  const upgrade = await call(ALICE, "/api/subscription", "PATCH", { plan: "scale" });
  check("upgrading without payment is refused", upgrade.status === 402, `got ${upgrade.status}`);

  const after = await call(ALICE, "/api/subscription");
  check("plan unchanged after refused upgrade", after.json?.plan === "starter", JSON.stringify(after.json));

  const same = await call(ALICE, "/api/subscription", "PATCH", { plan: "starter" });
  check("staying on the same tier is allowed", same.status === 200, `got ${same.status}`);
}

console.log("\nCascade cleanup");
{
  const created = await call(BOB, "/api/projects", "POST", { title: "Bob temp" });
  const id = created.json?.id;
  await call(BOB, `/api/projects/${id}/messages`, "POST", { content: "hello" });

  const del = await call(BOB, `/api/projects/${id}`, "DELETE");
  check("owner can delete their own project", del.status === 204, `got ${del.status}`);

  const msgs = await call(BOB, `/api/projects/${id}/messages`);
  check(
    "child messages are removed with the project",
    Array.isArray(msgs.json) && msgs.json.length === 0,
    JSON.stringify(msgs.json),
  );
}

// Leave the database as we found it.
{
  const del = await call(ALICE, `/api/projects/${aliceProjectId}`, "DELETE");
  check("test data cleaned up", del.status === 204, `got ${del.status}`);
}

server.close();
jwksServer.close();

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("Isolation holds.");
