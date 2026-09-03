/**
 * The section for people who sell things, end to end.
 *
 * A merchant brings photographs, not a recording, and until this slice existed
 * every door in the product was shut to them: the create-project dropzone
 * takes video, `projects.videoPath` is written only by the video upload path,
 * and `start-render.ts` refuses with "Upload a video before rendering." The
 * capability to build an advertisement out of stills was already there and had
 * no way in from a browser.
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
 *      bundled and called. The plan it returns is validated against the real
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
  const ids = ["a1", "a2", "a3"];
  const plan = ad.planForProductAd({ title: "Ceramic kettle", price: "34.00 USD" }, ids, {
    platform: "tiktok",
    targetSeconds: 15,
  });

  check("the reel is first, because everything else is about the reel", plan[0]?.type === "stillsReel", plan[0]?.type);
  check(
    "and it carries the photographs in the order they were given",
    JSON.stringify(plan[0]?.assetIds) === JSON.stringify(ids),
    JSON.stringify(plan[0]?.assetIds),
  );
  check("the reel runs as long as was asked for", plan[0]?.targetSeconds === 15);
  check("the platform asked for is the platform framed for",
    plan.some((op) => op.type === "formatForPlatform" && op.platform === "tiktok"));

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

  // A price nobody gave is a price nobody invents. This is the single most
  // damaging thing an automatic ad builder can get wrong.
  const noPrice = ad.planForProductAd({ title: "Ceramic kettle", price: null }, ids, {
    platform: "reels",
    targetSeconds: 15,
  });
  check(
    "a product with no price gets no price card rather than a made-up one",
    noPrice.filter((op) => op.type === "motionTitle").length === 1,
  );
  check(
    "and nothing anywhere in the plan mentions a currency",
    !/\$|USD|EUR|price/i.test(JSON.stringify(noPrice)),
    JSON.stringify(noPrice),
  );

  // The clamp. At five seconds, `seconds - 3.5` is 1.5, which would put the
  // price card on top of the title.
  const short = ad.planForProductAd({ title: "Kettle", price: "9 JOD" }, ids, {
    platform: "square",
    targetSeconds: 5,
  });
  const shortTitles = short.filter((op) => op.type === "motionTitle");
  check(
    "in a five second ad the price still waits for the title",
    (shortTitles[1]?.at ?? 0) >= (shortTitles[0]?.at ?? 0) + (shortTitles[0]?.durationSeconds ?? 0),
    `${shortTitles[0]?.at}+${shortTitles[0]?.durationSeconds} vs ${shortTitles[1]?.at}`,
  );

  const long = "x".repeat(400);
  const truncated = ad.planForProductAd({ title: long, price: null }, ids, {
    platform: "tiktok",
    targetSeconds: 15,
  });
  check(
    "a title longer than the contract allows is cut here, not refused later",
    (truncated.find((op) => op.type === "motionTitle")?.text ?? "").length <= 120,
  );

  // The contract the worker is handed. A plan that only this file agrees with
  // is a plan that fails at the far end of a queue.
  for (const [label, candidate] of [["with a price", plan], ["without one", noPrice], ["with a long title", truncated]]) {
    const parsed = zod.EditPlan.safeParse({ version: 1, operations: candidate });
    check(`the plan ${label} is a valid EditPlan`, parsed.success, parsed.error?.message?.slice(0, 200));
  }
  check("and it stays well under the twelve operation ceiling", plan.length <= 12, String(plan.length));
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

/** A project, and `count` photographs registered into it in this order. */
async function projectWithPhotos(user, title, count) {
  const created = await call(user, "/api/projects", "POST", { title });
  const id = created.json?.id;
  const paths = [];
  for (let i = 0; i < count; i += 1) {
    const objectPath = `${user}/${id}/asset-${Date.now().toString(36)}-${i}.jpg`;
    const registered = await call(user, `/api/projects/${id}/assets`, "POST", {
      path: objectPath,
      kind: "image",
      label: `photo-${i}.jpg`,
      bytes: 100000 + i,
    });
    if (registered.status !== 201) throw new Error(`could not register photo ${i}: ${registered.text}`);
    paths.push(objectPath);
    /*
      A millisecond between rows, on purpose.

      The route orders the photographs by `created_at`, and Postgres will hand
      several inserts inside one millisecond a timestamp they share. A suite
      that registers twelve photographs in a tight loop and then asserts their
      order would pass or fail on the machine's clock resolution rather than on
      the code, which is the worst kind of flake: it is green on the laptop
      that wrote it.
    */
    await new Promise((r) => setTimeout(r, 3));
  }
  return { id, paths };
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

  const mine = await projectWithPhotos(OWNER, "Kettle", 2);
  const theirs = await call(STRANGER, "/api/product-ads", "POST", { id: mine.id });
  check(
    "a stranger asking for an ad on my project is told there is no such project",
    theirs.status === 404,
    `got ${theirs.status} ${theirs.text}`,
  );
  check(
    "and the refusal does not confirm the project exists",
    !/kettle/i.test(theirs.text),
    theirs.text,
  );
}

section("A project with no photographs");
{
  const created = await call(OWNER, "/api/projects", "POST", { title: "Empty shelf" });
  const empty = await call(OWNER, "/api/product-ads", "POST", { id: created.json?.id });
  check("is refused", empty.status === 422, `got ${empty.status}`);
  check(
    "with the sentence that names the fix rather than the failure",
    /add the product photos/i.test(empty.json?.error ?? ""),
    empty.json?.error,
  );

  // An asset that is not a photograph is not a photograph. Registering an mp3
  // into the project must not make the ad buildable out of nothing.
  await call(OWNER, `/api/projects/${created.json?.id}/assets`, "POST", {
    path: `${OWNER}/${created.json?.id}/asset-music.mp3`,
    kind: "audio",
    label: "bed.mp3",
    bytes: 4000,
  });
  const stillEmpty = await call(OWNER, "/api/product-ads", "POST", { id: created.json?.id });
  check("a project holding only a music bed is still refused", stillEmpty.status === 422, `got ${stillEmpty.status}`);
}

section("Photographs in, a queued render out");
let queued = null;
{
  const project = await projectWithPhotos(OWNER, "Ceramic pour-over kettle", 4);
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
  check("it says how many photographs it used", made.json?.photos === 4, JSON.stringify(made.json));

  const row = psql(`select status from jobs where id = '${made.json?.jobId}'`);
  check("a job is really in the queue", row === "queued", row);

  // The plan the worker will run, read out of the row rather than out of the
  // response: the response is this route's account of itself.
  const planJson = psql(`select plan from jobs where id = '${made.json?.jobId}'`);
  const plan = JSON.parse(planJson || "{}");
  const reel = (plan.operations ?? []).find((op) => op.type === "stillsReel");
  check("the queued plan is built around a stills reel", Boolean(reel), planJson.slice(0, 200));

  const assetIds = psql(
    `select string_agg(id::text, ',' order by created_at asc) from assets where project_id = '${project.id}'`,
  ).split(",");
  check(
    "made of this project's photographs, in the order they were uploaded",
    JSON.stringify(reel?.assetIds) === JSON.stringify(assetIds),
    `${JSON.stringify(reel?.assetIds)} vs ${JSON.stringify(assetIds)}`,
  );
  check(
    "framed for the platform that was asked for, not the default",
    (plan.operations ?? []).some((op) => op.type === "formatForPlatform" && op.platform === "reels"),
    planJson.slice(0, 300),
  );
  check("and the price the merchant typed is on screen verbatim",
    (plan.operations ?? []).some((op) => op.type === "motionTitle" && op.text === "34.00 USD"),
    planJson.slice(0, 400));

  const projectRow = psql(
    `select video_path || '|' || duration || '|' || platform || '|' || title from projects where id = '${project.id}'`,
  );
  const [videoPath, duration, platform, title] = projectRow.split("|");
  check(
    "the project's source is the first photograph, which is what the reel replaces",
    videoPath === project.paths[0],
    `${videoPath} vs ${project.paths[0]}`,
  );
  check("its length is the length that will be billed", Number(duration) === 20, duration);
  check("its platform is recorded", platform === "reels", platform);
  check(
    "and the title falls back to the one the project already had",
    title === "Ceramic pour-over kettle",
    title,
  );
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

section("A project that already holds a video is not a product ad");
{
  const project = await projectWithPhotos(OWNER, "Has a take in it", 2);
  psql(
    `update projects set video_path = '${OWNER}/${project.id}/source.mp4' where id = '${project.id}'`,
  );
  const refused = await call(OWNER, "/api/product-ads", "POST", { id: project.id });
  check("it is refused rather than overwritten", refused.status === 409, `got ${refused.status}`);
  check(
    "and the upload it already holds is still pointed at",
    psql(`select video_path from projects where id = '${project.id}'`).endsWith("source.mp4"),
  );
}

section("More photographs than one ad can hold");
{
  const project = await projectWithPhotos(OWNER, "Fifteen angles", 15);
  const made = await call(OWNER, "/api/product-ads", "POST", { id: project.id, targetSeconds: 15 });
  check("the ad is still accepted", made.status === 202, `got ${made.status} ${made.text}`);
  check("and it says it used twelve", made.json?.photos === 12, JSON.stringify(made.json));

  const plan = JSON.parse(psql(`select plan from jobs where id = '${made.json?.jobId}'`) || "{}");
  const reel = (plan.operations ?? []).find((op) => op.type === "stillsReel");
  check("the reel holds twelve, not fifteen", reel?.assetIds?.length === 12, String(reel?.assetIds?.length));
  check(
    "and the twelve are the first twelve, so the cover shot is still the cover",
    reel?.assetIds?.[0] ===
      psql(`select id from assets where project_id = '${project.id}' order by created_at asc limit 1`),
  );
}

section("A title the merchant sent overrides the project's own");
{
  const project = await projectWithPhotos(OWNER, "untitled-3", 2);
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

// ─── 3. The door in the browser ──────────────────────────────────────────────

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
  check(
    "it takes photographs and not video",
    (page ?? "").includes(".jpg,.jpeg,.png,.webp") && !/accept=\{?"video/.test(page ?? ""),
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
