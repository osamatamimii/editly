/**
 * The section for people who sell things, end to end.
 *
 * A merchant brings a shop, not a recording: supplier clips of the product,
 * phone clips of somebody holding it, photographs, a price, and a sentence
 * saying what the advertisement should be like. Until this section existed
 * every door in the product was shut to them, and the first version of it was
 * shut in a subtler way: it took photographs only, so a merchant with footage
 * was handed a slideshow made out of the stills sitting beside it.
 *
 * That is the failure this file is written against, and it is the reason the
 * middle section here goes through real HTTP against the real Express bundle
 * and a real database rather than calling the handler. The last time a door
 * was added to this product, every unit check passed while the route sat below
 * `requireAuth` and answered 401 to every correctly formed request. Only a
 * request through the whole stack saw it.
 *
 * The three sections, and what each is worth:
 *
 *   1. **The plan both doors end at.** `lib/product-ad.ts` is pure, so it is
 *      bundled and called. Both of its shapes are checked — the footage
 *      advertisement, and the stills fallback a catalogue product with no
 *      video still needs — and the plans are validated against the real
 *      `EditPlan` contract, which is what the worker will be handed.
 *   2. **The section, through the stack.** Sign in, upload photographs, ask for
 *      an advertisement, and read back the job the worker will pick up. The
 *      plan is read out of the database, not out of the response, because the
 *      response is this route's opinion and the row is what runs.
 *   3. **The door in the browser.** Whether the page is registered, reachable
 *      and pointed at this endpoint. These are textual facts about wiring and
 *      are honest about being that: they prove the route exists in the router
 *      table, not that the screen looks right. `browser-test` runs the front
 *      end in Chromium and is where behaviour is measured.
 *
 * Usage: node tools/product-ads-test.mjs
 * Requires: a local Postgres matching the production schema.
 */
import http from "node:http";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveTestDatabaseUrl } from "./lib/test-db.mjs";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();

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

const buildDir = await mkdtemp(path.join(tmpdir(), "editly-product-ads-"));

// ─── 1. The plan both doors end at ───────────────────────────────────────────

const bundlePure = (entry, outfile) => {
  const built = spawnSync(
    require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/api-server"] }),
    [
      path.join(repoRoot, entry),
      "--bundle", "--platform=node", "--format=esm", "--target=node22",
      `--outfile=${path.join(buildDir, outfile)}`, "--log-level=error",
    ],
    { stdio: "inherit" },
  );
  if (built.status !== 0) {
    console.error(`could not bundle ${entry}`);
    process.exit(1);
  }
  return import(pathToFileURL(path.join(buildDir, outfile)).href);
};

const ad = await bundlePure("artifacts/api-server/src/lib/product-ad.ts", "product-ad.mjs");
const zod = await bundlePure("lib/api-zod/src/index.ts", "zod.mjs");

section("The plan both doors end at");
{
  const clips = ["v1", "v2"];
  const pics = ["p1", "p2", "p3"];
  const plan = ad.planForProductAd(
    { title: "Ceramic kettle", price: "34.00 USD" },
    { clipIds: clips, photoIds: pics, sourceSeconds: 18 },
    { platform: "tiktok", targetSeconds: 15 },
  );
  const types = plan.map((op) => op.type);

  /*
    The correction this section is written around.

    The first version of this file built a slideshow out of the photographs and
    ignored the footage entirely. A merchant with supplier clips got stills of
    a product that was moving in the folder next door.
  */
  check("footage is the advertisement, not a slideshow of the stills", !types.includes("stillsReel"), types.join(","));
  check("the platform asked for is the platform framed for",
    plan.some((op) => op.type === "formatForPlatform" && op.platform === "tiktok"));

  const cutaways = plan.filter((op) => op.type === "insertBRoll");
  check("everything past the first clip is cut in over it", cutaways.length > 0, String(cutaways.length));
  check(
    "the second clip goes before the photographs, because a moving angle beats a still",
    cutaways[0]?.assetId === "v2",
    cutaways.map((c) => c.assetId).join(","),
  );
  check("and only files that were given are named",
    cutaways.every((c) => [...clips.slice(1), ...pics].includes(c.assetId)),
    cutaways.map((c) => c.assetId).join(","));
  check("the first clip is never cut over itself", !cutaways.some((c) => c.assetId === "v1"));
  check("each cutaway keeps the sound underneath, which is what a cutaway is",
    cutaways.every((c) => c.keepSourceAudio === true));
  check("and fills the frame rather than sitting in a box", cutaways.every((c) => c.fit === "cover"));

  // The hook. A cutaway over the first beat is an advertisement nobody watches
  // past the first beat.
  check("nothing is cut in over the opening", cutaways.every((c) => c.at >= ad.HOOK_SECONDS), cutaways.map((c) => c.at).join(","));
  const overlapping = cutaways.some((c, i) =>
    i > 0 && c.at < cutaways[i - 1].at + cutaways[i - 1].durationSeconds);
  check("and no two of them are on screen at once", !overlapping, cutaways.map((c) => `${c.at}+${c.durationSeconds}`).join(","));

  const titles = plan.filter((op) => op.type === "motionTitle");
  check("the product's own name goes on screen", titles[0]?.text === "Ceramic kettle", titles[0]?.text);
  check("at the top, not buried", (titles[0]?.at ?? 99) < 1, String(titles[0]?.at));
  check("the price is the second card", titles[1]?.text === "34.00 USD", titles[1]?.text);
  check(
    "and it lands after the opening title has left the screen",
    (titles[1]?.at ?? 0) >= (titles[0]?.at ?? 0) + (titles[0]?.durationSeconds ?? 0),
    `${titles[0]?.at}+${titles[0]?.durationSeconds} vs ${titles[1]?.at}`,
  );
  check("it ends on a fade", plan.at(-1)?.type === "fade");

  // A price nobody gave is a price nobody invents. The single most damaging
  // thing an automatic ad builder can get wrong.
  const noPrice = ad.planForProductAd(
    { title: "Ceramic kettle", price: null },
    { clipIds: clips, photoIds: [], sourceSeconds: 18 },
    { platform: "reels", targetSeconds: 15 },
  );
  check(
    "a product with no price gets no price card rather than a made-up one",
    noPrice.filter((op) => op.type === "motionTitle").length === 1,
  );
  check(
    "and nothing anywhere in the plan mentions a currency",
    !/\$|USD|EUR|price/i.test(JSON.stringify(noPrice)),
    JSON.stringify(noPrice),
  );

  const long = "x".repeat(400);
  const truncated = ad.planForProductAd(
    { title: long, price: null },
    { clipIds: clips, photoIds: [], sourceSeconds: null },
    { platform: "tiktok", targetSeconds: 15 },
  );
  check(
    "a title longer than the contract allows is cut here, not refused later",
    (truncated.find((op) => op.type === "motionTitle")?.text ?? "").length <= 120,
  );

  for (const [label, candidate] of [["with a price", plan], ["without one", noPrice], ["with a long title", truncated]]) {
    const parsed = zod.EditPlan.safeParse({ version: 1, operations: candidate });
    check(`the plan ${label} is a valid EditPlan`, parsed.success, parsed.error?.message?.slice(0, 200));
  }
  check("and it stays under the twelve operation ceiling", plan.length <= 12, String(plan.length));
}

section("Long footage is cut down; short footage is left alone");
{
  const short = ad.planForProductAd(
    { title: "Kettle", price: null },
    { clipIds: ["v1"], photoIds: [], sourceSeconds: 18 },
    { platform: "tiktok", targetSeconds: 15 },
  );
  check(
    "eighteen seconds asked to be fifteen is not worth choosing a highlight out of",
    !short.some((op) => op.type === "extractHighlight"),
    short.map((o) => o.type).join(","),
  );

  const long = ad.planForProductAd(
    { title: "Kettle", price: null },
    { clipIds: ["v1"], photoIds: [], sourceSeconds: 120 },
    { platform: "tiktok", targetSeconds: 15 },
  );
  const cut = long.find((op) => op.type === "extractHighlight");
  check("two minutes of a product rotating on a table is", Boolean(cut), long.map((o) => o.type).join(","));
  check("and it is cut to the length that was asked for", cut?.targetSeconds === 15, String(cut?.targetSeconds));

  // Unknown is not long. A duration nobody measured must not become a cut
  // placed at a second that does not exist.
  const unknown = ad.planForProductAd(
    { title: "Kettle", price: null },
    { clipIds: ["v1"], photoIds: [], sourceSeconds: null },
    { platform: "tiktok", targetSeconds: 15 },
  );
  check(
    "a length nobody measured is not treated as a long one",
    !unknown.some((op) => op.type === "extractHighlight"),
    unknown.map((o) => o.type).join(","),
  );
}

section("No footage at all, which is most of a Shopify catalogue");
{
  const stills = ad.planForProductAd(
    { title: "Ceramic kettle", price: "34.00 USD" },
    { clipIds: [], photoIds: ["p1", "p2", "p3"], sourceSeconds: null },
    { platform: "tiktok", targetSeconds: 15 },
  );
  const reel = stills.find((op) => op.type === "stillsReel");
  check("the photographs become the video", Boolean(reel), stills.map((o) => o.type).join(","));
  check("in the order they were given", JSON.stringify(reel?.assetIds) === JSON.stringify(["p1", "p2", "p3"]));
  check("and it is first, because everything else is about it", stills[0]?.type === "stillsReel");
  check(
    "nothing is cut in over a reel that is itself made of those files",
    !stills.some((op) => op.type === "insertBRoll"),
    stills.map((o) => o.type).join(","),
  );
  const parsed = zod.EditPlan.safeParse({ version: 1, operations: stills });
  check("and the fallback is a valid EditPlan too", parsed.success, parsed.error?.message?.slice(0, 200));
}

section("Where the cutaways land");
{
  const places = ad.cutawayPlacements(3, 15);
  check("three are placed in fifteen seconds", places.length === 3, JSON.stringify(places));
  check("the first waits for the hook", places[0].at >= ad.HOOK_SECONDS, String(places[0]?.at));
  check("they are in order", places.every((p, i) => i === 0 || p.at > places[i - 1].at));
  check(
    "none of them runs past the closing beat, where the price card is",
    places.at(-1).at + places.at(-1).durationSeconds <= 15 - 0.5,
    JSON.stringify(places.at(-1)),
  );
  const taken = places.reduce((sum, p) => sum + p.durationSeconds, 0);
  check(
    "and together they take no more than the share allowed",
    taken <= 15 * ad.CUTAWAY_SHARE + 0.001,
    `${taken}s of 15s`,
  );

  check("more files than there is room for are dropped rather than stacked",
    ad.cutawayPlacements(20, 15).length < 20);
  check("an advertisement too short to hold one gets none", ad.cutawayPlacements(3, 3).length === 0);
  check("and none is placed when none were offered", ad.cutawayPlacements(0, 15).length === 0);
}

// ─── 2. The section, through the stack ───────────────────────────────────────

const { generateKeyPair, exportJWK, SignJWT } = await import(
  pathToFileURL(require.resolve("jose", { paths: ["artifacts/api-server"] })).href
);

const JWKS_PORT = 4042;
const API_PORT = 4041;
const BASE = `http://127.0.0.1:${API_PORT}`;
const ISSUER_BASE = `http://127.0.0.1:${JWKS_PORT}`;

const OWNER = "33333333-3333-4333-8333-333333333333";
const STRANGER = "44444444-4444-4444-8444-444444444444";

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

// The middleware reads SUPABASE_URL at import time and build-vercel.mjs bakes
// it into the bundle, so the bundle is rebuilt against the local issuer above.
process.env.SUPABASE_URL = ISSUER_BASE;
await resolveTestDatabaseUrl();

console.log("\nRebuilding the API bundle against the local test issuer...");
const buildResult = spawnSync(process.execPath, ["artifacts/api-server/build-vercel.mjs"], {
  stdio: ["ignore", "ignore", "inherit"],
  env: { ...process.env, SUPABASE_URL: ISSUER_BASE },
});
if (buildResult.status !== 0) {
  console.error("Bundle build failed; cannot run the product ads test.");
  process.exit(1);
}

const tokenFor = (userId) =>
  new SignJWT({ role: "authenticated" })
    .setProtectedHeader({ alg: "ES256", kid: "test-key" })
    .setSubject(userId)
    .setIssuer(`${ISSUER_BASE}/auth/v1`)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);

const bundle = require("../api/_bundle.js");
const app = bundle.default || bundle;
const server = http.createServer(app);
await new Promise((r) => server.listen(API_PORT, r));

const tokens = { [OWNER]: await tokenFor(OWNER), [STRANGER]: await tokenFor(STRANGER) };

async function call(user, route, method = "GET", body) {
  const res = await fetch(BASE + route, {
    method,
    headers: {
      ...(user ? { Authorization: `Bearer ${tokens[user]}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* an infrastructure page, which the status already tells us about */
  }
  return { status: res.status, json, text };
}

const psql = (sql) =>
  (spawnSync("psql", [process.env.DATABASE_URL, "-tAc", sql], { encoding: "utf8" }).stdout ?? "").trim();

/** Everything these users own, so a rerun starts from the same place. */
function sweep() {
  for (const id of [OWNER, STRANGER]) {
    spawnSync("psql", [process.env.DATABASE_URL, "-c", `delete from jobs where user_id = '${id}'`]);
    spawnSync("psql", [process.env.DATABASE_URL, "-c", `delete from assets where user_id = '${id}'`]);
    spawnSync("psql", [process.env.DATABASE_URL, "-c", `delete from projects where user_id = '${id}'`]);
  }
}
sweep();

/**
 * A project, with `clips` clips and `photos` photographs registered into it in
 * that order.
 *
 * Rows only: this route reads the library, never the bytes, so a real file
 * would prove nothing here that `overlay-test` does not already prove against
 * ffmpeg itself.
 */
async function projectWith(user, title, { clips = 0, photos = 0, clipSeconds = 18 } = {}) {
  const created = await call(user, "/api/projects", "POST", { title });
  const id = created.json?.id;
  const paths = { clips: [], photos: [] };
  const files = [
    ...Array.from({ length: clips }, (_, i) => ({ kind: "video", i, ext: "mp4" })),
    ...Array.from({ length: photos }, (_, i) => ({ kind: "image", i, ext: "jpg" })),
  ];
  for (const [n, file] of files.entries()) {
    const objectPath = `${user}/${id}/asset-${Date.now().toString(36)}-${n}.${file.ext}`;
    const registered = await call(user, `/api/projects/${id}/assets`, "POST", {
      path: objectPath,
      kind: file.kind,
      label: `${file.kind}-${file.i}.${file.ext}`,
      bytes: 100000 + n,
      // The browser measures this before it uploads, and the route judges the
      // month's allowance against it. Sent here for the clips only, exactly as
      // the page does.
      ...(file.kind === "video" ? { durationSeconds: clipSeconds } : {}),
    });
    if (registered.status !== 201) throw new Error(`could not register ${file.kind} ${file.i}: ${registered.text}`);
    paths[file.kind === "video" ? "clips" : "photos"].push(objectPath);
    /*
      A millisecond between rows, on purpose.

      The route orders the material by `created_at`, and Postgres will hand
      several inserts inside one millisecond a timestamp they share. A suite
      that registers a dozen files in a tight loop and then asserts their order
      would pass or fail on the machine's clock resolution rather than on the
      code, which is the worst kind of flake: it is green on the laptop that
      wrote it.
    */
    await new Promise((r) => setTimeout(r, 3));
  }
  return { id, ...paths };
}

section("The endpoint is a door, and it is locked");
{
  const anonymous = await fetch(`${BASE}/api/product-ads`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "whatever" }),
  });
  check("no token is refused", anonymous.status === 401, `got ${anonymous.status}`);

  const noId = await call(OWNER, "/api/product-ads", "POST", {});
  check("a request with no project is refused as a bad request", noId.status === 400, `got ${noId.status}`);

  const mine = await projectWith(OWNER, "Kettle", { clips: 1 });
  const theirs = await call(STRANGER, "/api/product-ads", "POST", { id: mine.id });
  check(
    "a stranger asking for an ad on my project is told there is no such project",
    theirs.status === 404,
    `got ${theirs.status} ${theirs.text}`,
  );
  check("and the refusal does not confirm the project exists", !/kettle/i.test(theirs.text), theirs.text);
}

section("A clip is required, and photographs alone are refused");
{
  const empty = await projectWith(OWNER, "Empty shelf", {});
  const nothing = await call(OWNER, "/api/product-ads", "POST", { id: empty.id });
  check("an empty project is refused", nothing.status === 422, `got ${nothing.status}`);
  check(
    "and told to start with a clip",
    /add a clip of the product to start/i.test(nothing.json?.error ?? ""),
    nothing.json?.error,
  );

  /*
    The case the first version of this section was built entirely around, and
    the one it now refuses.

    A merchant who uploads six photographs and no footage is not asking for a
    slideshow; they have footage and did not know it was wanted. So the refusal
    names what to add and promises what will happen to what they already gave.
  */
  const stillsOnly = await projectWith(OWNER, "Six angles", { photos: 6 });
  const refused = await call(OWNER, "/api/product-ads", "POST", { id: stillsOnly.id });
  check("photographs with no clip are refused", refused.status === 422, `got ${refused.status}`);
  check(
    "with the sentence that names the fix and keeps their photos in it",
    /add at least one clip/i.test(refused.json?.error ?? "") && /photos/i.test(refused.json?.error ?? ""),
    refused.json?.error,
  );
  check(
    "and nothing was queued for it",
    psql(`select count(*) from jobs where project_id = '${stillsOnly.id}'`) === "0",
  );

  // Audio is not footage. Registering a music bed must not make the ad
  // buildable out of nothing.
  await call(OWNER, `/api/projects/${empty.id}/assets`, "POST", {
    path: `${OWNER}/${empty.id}/asset-music.mp3`,
    kind: "audio",
    label: "bed.mp3",
    bytes: 4000,
  });
  const stillNothing = await call(OWNER, "/api/product-ads", "POST", { id: empty.id });
  check("a project holding only a music bed is still refused", stillNothing.status === 422, `got ${stillNothing.status}`);
}

section("Clips and photos in, a queued render out");
let queued = null;
{
  const project = await projectWith(OWNER, "Ceramic pour-over kettle", { clips: 2, photos: 3, clipSeconds: 24 });
  const made = await call(OWNER, "/api/product-ads", "POST", {
    id: project.id,
    price: "34.00 USD",
    platform: "reels",
    targetSeconds: 20,
  });
  queued = made;

  check("the ad is accepted", made.status === 202, `got ${made.status} ${made.text}`);
  const parsed = zod.CreateProductAdResponse.safeParse(made.json);
  check("and the answer matches the contract it declares", parsed.success, parsed.error?.message?.slice(0, 200));
  check("it says how many clips it used", made.json?.clips === 2, JSON.stringify(made.json));
  check("and how many photographs", made.json?.photos === 3, JSON.stringify(made.json));

  const row = psql(`select status from jobs where id = '${made.json?.jobId}'`);
  check("a job is really in the queue", row === "queued", row);

  // The plan the worker will run, read out of the row rather than out of the
  // response: the response is this route's account of itself.
  const planJson = psql(`select plan from jobs where id = '${made.json?.jobId}'`);
  const plan = JSON.parse(planJson || "{}");
  const types = (plan.operations ?? []).map((op) => op.type);

  check("the queued plan is not a slideshow", !types.includes("stillsReel"), types.join(","));
  check(
    "framed for the platform that was asked for, not the default",
    (plan.operations ?? []).some((op) => op.type === "formatForPlatform" && op.platform === "reels"),
    planJson.slice(0, 300),
  );
  check("and the price the merchant typed is on screen verbatim",
    (plan.operations ?? []).some((op) => op.type === "motionTitle" && op.text === "34.00 USD"),
    planJson.slice(0, 400));

  const assetIds = psql(
    `select string_agg(id::text, ',' order by created_at asc) from assets where project_id = '${project.id}'`,
  ).split(",");
  const cutaways = (plan.operations ?? []).filter((op) => op.type === "insertBRoll");
  check("the extra material is cut in over the footage", cutaways.length > 0, String(cutaways.length));
  check(
    "and every cutaway names a file that is really in this project",
    cutaways.every((c) => assetIds.includes(c.assetId)),
    `${cutaways.map((c) => c.assetId).join(",")} vs ${assetIds.join(",")}`,
  );
  check(
    "the first clip is the advertisement, so it is never cut over itself",
    !cutaways.some((c) => c.assetId === assetIds[0]),
    assetIds[0],
  );

  const projectRow = psql(
    `select video_path || '|' || duration || '|' || platform || '|' || title from projects where id = '${project.id}'`,
  );
  const [videoPath, duration, platform, title] = projectRow.split("|");
  check(
    "the project's source is the first clip, not the first photograph",
    videoPath === project.clips[0],
    `${videoPath} vs ${project.clips[0]}`,
  );
  check(
    "its length is the footage's own, because that is what gets decoded and billed",
    Number(duration) === 24,
    duration,
  );
  check("its platform is recorded", platform === "reels", platform);
  check("and the title falls back to the one the project already had", title === "Ceramic pour-over kettle", title);
}

section("It goes through the same policy as every other render");
{
  // The one-render-at-a-time rule belongs to `start-render.ts`, and the point
  // of this check is that this route did not find a way around it.
  const again = await call(OWNER, "/api/product-ads", "POST", {
    id: queued.json?.projectId,
    targetSeconds: 20,
  });
  check("asking again while one is queued is refused", again.status === 409, `got ${again.status}`);
  check("and it names the job already running", again.json?.jobId === queued.json?.jobId, JSON.stringify(again.json));
}

section("The sentence decides the advertisement");
{
  /*
    The half a row of buttons cannot do.

    "Cut it fast with subtitles", "keep her voice, no music", "خلّيه هادي" are
    three advertisements out of one set of clips. The sentence goes through the
    planner a chat message goes through — the model where there is a key, the
    keyword matcher where there is none, which is what runs here — and whatever
    it asks for wins over this route's defaults.
  */
  const project = await projectWith(OWNER, "Kettle", { clips: 1 });
  const made = await call(OWNER, "/api/product-ads", "POST", {
    id: project.id,
    price: "34.00 USD",
    description: "cut out the silences and level the audio",
    targetSeconds: 15,
  });
  check("the ad is accepted", made.status === 202, `got ${made.status} ${made.text}`);

  const plan = JSON.parse(psql(`select plan from jobs where id = '${made.json?.jobId}'`) || "{}");
  const types = (plan.operations ?? []).map((op) => op.type);
  check("what they asked for is in the plan", types.includes("removeSilence"), types.join(","));
  check("all of it", types.includes("normalizeLoudness"), types.join(","));
  check("and the advertisement is still built around it", types.includes("formatForPlatform"), types.join(","));
  check("with the price they typed still on screen",
    (plan.operations ?? []).some((op) => op.type === "motionTitle" && op.text === "34.00 USD"),
    types.join(","));
}

section("Their words on screen beat ours, and the price survives both");
{
  /*
    `withDirection` works by operation type, and the product's name and its
    price are both `motionTitle`. So a sentence asking for any words on screen
    would have dropped both of ours, including the number the advertisement is
    asking the viewer to accept — a merchant who typed a price into a field
    labelled Price and got a video with no price in it.
  */
  const project = await projectWith(OWNER, "Kettle", { clips: 1 });
  const made = await call(OWNER, "/api/product-ads", "POST", {
    id: project.id,
    title: "Ceramic kettle",
    price: "34.00 USD",
    description: 'put the words "Free shipping" on screen',
    targetSeconds: 15,
  });
  check("accepted", made.status === 202, `got ${made.status} ${made.text}`);

  const plan = JSON.parse(psql(`select plan from jobs where id = '${made.json?.jobId}'`) || "{}");
  const titles = (plan.operations ?? []).filter((op) => op.type === "motionTitle");
  check("their words are on screen", titles.some((t) => /free shipping/i.test(t.text)), JSON.stringify(titles));
  check("the price they typed is still there too", titles.some((t) => t.text === "34.00 USD"), JSON.stringify(titles));
  check(
    "and ours did not also pile on top, so the screen is not three cards deep",
    titles.length === 2,
    JSON.stringify(titles.map((t) => t.text)),
  );
}

section("A project that already holds somebody's own upload");
{
  const project = await projectWith(OWNER, "Has a take in it", { clips: 1 });
  psql(`update projects set video_path = '${OWNER}/${project.id}/source.mp4' where id = '${project.id}'`);
  const refused = await call(OWNER, "/api/product-ads", "POST", { id: project.id });
  check("is refused rather than overwritten", refused.status === 409, `got ${refused.status}`);
  check(
    "and the upload it already holds is still pointed at",
    psql(`select video_path from projects where id = '${project.id}'`).endsWith("source.mp4"),
  );
}

section("More material than one ad can hold");
{
  const project = await projectWith(OWNER, "Everything at once", { clips: 2, photos: 15 });
  const made = await call(OWNER, "/api/product-ads", "POST", { id: project.id, targetSeconds: 15 });
  check("the ad is still accepted", made.status === 202, `got ${made.status} ${made.text}`);
  check("and it says it used twelve of the photographs", made.json?.photos === 12, JSON.stringify(made.json));

  const plan = JSON.parse(psql(`select plan from jobs where id = '${made.json?.jobId}'`) || "{}");
  const cutaways = (plan.operations ?? []).filter((op) => op.type === "insertBRoll");
  check(
    "and far fewer than that reach the screen, because a fifteen second ad has room for a few",
    cutaways.length > 0 && cutaways.length <= 5,
    String(cutaways.length),
  );
  check("the plan stays inside the twelve operation ceiling", (plan.operations ?? []).length <= 12,
    String((plan.operations ?? []).length));
  const parsed = zod.EditPlan.safeParse(plan);
  check("and what was queued is a valid EditPlan", parsed.success, parsed.error?.message?.slice(0, 200));
}

section("A title the merchant sent overrides the project's own");
{
  const project = await projectWith(OWNER, "untitled-3", { clips: 1 });
  const made = await call(OWNER, "/api/product-ads", "POST", {
    id: project.id,
    title: "Hand-thrown mug",
    targetSeconds: 10,
  });
  check("accepted", made.status === 202, `got ${made.status} ${made.text}`);
  const plan = JSON.parse(psql(`select plan from jobs where id = '${made.json?.jobId}'`) || "{}");
  check(
    "and it is their words on screen",
    (plan.operations ?? []).some((op) => op.type === "motionTitle" && op.text === "Hand-thrown mug"),
  );
  check(
    "the project is renamed to match, so the dashboard says what the video is",
    psql(`select title from projects where id = '${project.id}'`) === "Hand-thrown mug",
  );
}

section("The door in the browser");
{
  const read = (p) => (existsSync(path.join(repoRoot, p)) ? readFileSync(path.join(repoRoot, p), "utf8") : null);

  const page = read("artifacts/editly/src/pages/product-ads.tsx");
  check("the section has a page", page !== null);

  const app = read("artifacts/editly/src/App.tsx") ?? "";
  check("the app knows how to load it", app.includes('import("@/pages/product-ads")'));
  check('and registers it at "/ads"', /<Route path="\/ads">/.test(app));
  check(
    "behind the same gate as every other signed-in screen",
    /<Route path="\/ads">\s*<Protected component=\{ProductAdsPage\} \/>/.test(app),
    "route is not wrapped in Protected",
  );

  const dashboard = read("artifacts/editly/src/pages/dashboard.tsx") ?? "";
  check(
    "the dashboard has a way in, so the page is not a URL only we know",
    dashboard.includes('setLocation("/ads")'),
  );

  check("the page asks this endpoint for the ad", (page ?? "").includes('"/api/product-ads"'));
  check(
    "and registers each photograph through the assets route the server checks",
    /\/api\/projects\/\$\{[^}]+\}\/assets/.test(page ?? ""),
  );
  /*
    It takes footage, and this check used to assert the opposite.

    When the section was photographs-only it read "it takes photographs and not
    video", and after the page was rewritten to take both it went on passing —
    the new accept list contains the old one as a substring. A check that
    survives the change it was written to notice is worse than no check, so it
    now names the extensions on both sides.
  */
  for (const ext of [".mp4", ".mov", ".webm", ".jpg", ".png", ".webp"]) {
    check(`the dropzone takes ${ext}`, (page ?? "").includes(ext), "not in the accept list");
  }
  check(
    "and the button will not build an ad with no clip in it",
    /disabled=\{clips\.length === 0/.test(page ?? ""),
    "the build button is not gated on having a clip",
  );
  check(
    "with the reason said next to it rather than after they press",
    /product-ad-needs-clip/.test(page ?? ""),
  );
  check(
    "the sentence they write is sent with the request",
    /description: description\.trim\(\)/.test(page ?? ""),
  );
  /*
    Measured in the browser, because nothing downstream can.

    The route judges the month's allowance against `projects.duration`, and the
    only place a clip's length can be read without downloading it is the
    browser that already holds the file. A page that uploaded clips without it
    would silently bill every advertisement at its target length.
  */
  check(
    "and each clip's length is measured before it is uploaded",
    /readVideoFacts/.test(page ?? "") && /durationSeconds: facts\.duration/.test(page ?? ""),
  );

  /*
    One ceiling, two files.

    The page refuses a thirteenth photograph before it is uploaded and the
    route drops anything past the twelfth. If those two numbers drift, the
    merchant uploads photographs that are silently not in their video — which
    is the quiet kind of wrong this repository keeps finding.
  */
  const pageMax = Number((page ?? "").match(/const MAX_PHOTOS = (\d+)/)?.[1]);
  const serverMax = Number(
    (read("artifacts/api-server/src/lib/shopify/product.ts") ?? "").match(/MAX_IMAGES = (\d+)/)?.[1],
  );
  check(
    "the page refuses at exactly the number the server drops at",
    Number.isFinite(pageMax) && pageMax === serverMax,
    `page ${pageMax} vs server ${serverMax}`,
  );
}

sweep();
server.close();
jwksServer.close();
await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log("The section for people who sell things has a hole in it.");
  process.exit(1);
}
console.log("Photographs, a name and a price go in; a queued advertisement comes out.");
