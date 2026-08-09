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
