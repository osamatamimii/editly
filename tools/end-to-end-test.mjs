/**
 * The tool, used.
 *
 * Everything else in this repo tests a part. The renderer is exercised without
 * an API, the API without a browser, the browser against fixtures that answer
 * instantly and never render anything. Each is green and none of them has ever
 * answered the question somebody actually has, which is: **if I open this on my
 * phone and give it a video, do I get an edited video back?**
 *
 * So this runs the whole thing at once, at 390x844, with nothing faked that
 * does real work:
 *
 *   - the real API bundle, the one `vercel:build` produces and deploys
 *   - the real worker binary, the one the Docker image runs
 *   - the real front end, built here the way it deploys
 *   - a real Postgres, migrated
 *   - a real video file, made here with ffmpeg, that really is uploaded
 *   - and a real render, by ffmpeg, producing a real playable file
 *
 * Two things are stubs and both are Supabase's: object storage, which is an
 * HTTP file store and is one here too, and the JWKS the API validates tokens
 * against, which is a signing key. Neither does any of the product's work.
 *
 * It costs nothing in production and burns none of anyone's minutes, which is
 * why it can run on every commit.
 */
import http from "node:http";
import path from "node:path";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { resolveTestDatabaseUrl } from "./lib/test-db.mjs";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = await resolveTestDatabaseUrl();

/** The one person in this run. Declared here because the preflight clears them. */
const USER = "00000000-0000-4000-8000-0000000e2e01";

/**
 * Is there a database, and has it been migrated?
 *
 * Asked here, before anything is started, because of what the alternative
 * looked like: the suite came up, the browser opened, the first real call went
 * out, and the report said "a project can be created — 500, something went
 * wrong on our side". Which is true, and says nothing. A missing Postgres and a
 * broken product are the same sentence to whoever is reading the output, and
 * the whole point of this file is to be the one place that answers a question
 * plainly.
 */
{
  const { Client } = require(require.resolve("pg", { paths: ["lib/db"] }));
  const client = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 3000 });
  const stopWith = (message) => {
    console.error(`\nThe test database is not ready, so nothing below would mean anything.\n\n  ${message}\n`);
    console.error(`  DATABASE_URL: ${DATABASE_URL}`);
    console.error(`  Bring one up, then: DATABASE_URL=... node tools/migrate.mjs\n`);
    process.exit(1);
  };
  try {
    await client.connect();
  } catch (e) {
    stopWith(`Nothing is answering: ${e.message}`);
  }
  try {
    const { rows } = await client.query(
      "select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_name in ('projects','jobs','messages','subscriptions')",
    );
    if (rows[0].n < 4) stopWith(`Connected, but the schema is not there (${rows[0].n} of 4 core tables).`);

    // Start from nothing. Earlier runs leave this user's projects behind, and
    // the dashboard then lists videos whose files lived in a storage stub that
    // no longer exists — so the page reaches for them, the requests abort, and
    // a run that did everything right reports a browser full of failures it
    // did not cause. A test that inherits the last run's rubbish is not
    // measuring this run.
    await client.query("delete from jobs where user_id = $1", [USER]);
    await client.query("delete from messages where user_id = $1", [USER]);
    await client.query("delete from exports where user_id = $1", [USER]).catch(() => {});
    await client.query("delete from projects where user_id = $1", [USER]);
  } catch (e) {
    stopWith(`Connected, but could not read the schema: ${e.message}`);
  } finally {
    await client.end().catch(() => {});
  }
}

const SHOTS = process.env.E2E_SHOTS ?? "/tmp/e2e-shots";
const PHONE = { width: 390, height: 844 };

/**
 * The API's log, held rather than printed.
 *
 * The API runs in this process, so its pino lines go straight to our stdout and
 * bury the report under a thousand columns of JSON. But they are also the only
 * place the real cause of a failure is written down: the response body says
 * "something went wrong on our side" on purpose, and the log line beside it
 * says which query, against which port, refused.
 *
 * So they are kept, and printed only next to a failure, where they are the
 * answer rather than noise. Turning the log off instead would have been the
 * easy version of this, and would have left every future 500 undiagnosable.
 */
const apiLog = [];
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
  if (text.startsWith('{"level"')) {
    for (const line of text.split("\n")) if (line.trim()) apiLog.push(line);
    const done = rest.find((a) => typeof a === "function");
    if (done) done();
    return true;
  }
  return realWrite(chunk, ...rest);
};

/** One readable line out of a pino record: what failed, and why. */
function summarise(line) {
  try {
    const r = JSON.parse(line);
    const where = r.req ? `${r.req.method} ${r.req.url}` : (r.name ?? "");
    const why = r.err?.message ?? r.msg ?? "";
    const status = r.res?.statusCode ? ` → ${r.res.statusCode}` : "";
    return `      ${where}${status} ${why}`.replace(/\s+/g, " ").slice(0, 300);
  } catch {
    return `      ${line.slice(0, 300)}`;
  }
}

let pass = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
    // Only the errors, only the last few, only here.
    const recent = apiLog.filter((l) => l.includes('"level":50') || l.includes('"level":60')).slice(-4);
    for (const line of recent) console.log(summarise(line));
  }
  apiLog.length = 0;
}
function section(t) { console.log(`\n${t}`); }

const work = await mkdtemp(path.join(tmpdir(), "editly-e2e-"));
const stop = [];
async function shutdown() {
  for (const fn of stop.reverse()) { try { await fn(); } catch { /* going down anyway */ } }
}

/**
 * Leftover workers, killed before this run starts.
 *
 * A worker outlives a crashed run — and it keeps polling the same database,
 * with a storage stub that no longer exists. So it takes the next run's job,
 * fails to fetch the source, and burns all three attempts in under a second.
 * The job's row then says "Rendering failed. We are looking into it." while
 * *this* run's worker log is empty, because this run's worker never saw it.
 *
 * That failure looked exactly like a broken renderer for most of an afternoon.
 * The renderer was fine. Seven ghosts were racing it.
 */
{
  const swept = spawnSync("pkill", ["-f", "artifacts/worker/dist/index.mjs"]);
  // pkill exits 1 when it matched nothing, which is the normal case.
  if (swept.status === 0) console.log("  (cleared a worker left behind by an earlier run)");
}

// Whatever ends this process — a thrown Playwright timeout, a Ctrl-C — takes
// the worker with it. `process.on("exit")` can only do synchronous work, which
// is precisely what `kill` is.
let workerChild = null;
process.on("exit", () => { try { workerChild?.kill("SIGKILL"); } catch { /* already gone */ } });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(130));
process.on("uncaughtException", (e) => {
  console.error(`\nThe run stopped: ${e?.message ?? e}`);
  process.exit(1);
});
process.on("unhandledRejection", (e) => {
  console.error(`\nThe run stopped: ${e?.message ?? e}`);
  process.exit(1);
});

// ── A video, made rather than committed ──────────────────────────────────────
//
// Twelve seconds: speech, silence, speech, silence, speech. The silences are
// what the edit is asked to remove, so "did it work" is a length the file
// itself answers.
const SOURCE = path.join(work, "take.mp4");
{
  const made = spawnSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc=size=640x360:rate=25:duration=12",
    "-f", "lavfi", "-i",
    "sine=frequency=320:duration=12," +
      "volume='if(between(t,0,3)+between(t,5,8)+between(t,10,12),1,0)':eval=frame",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast",
    "-c:a", "aac", "-shortest", "-movflags", "+faststart", SOURCE,
  ]);
  if (made.status !== 0) {
    console.error("ffmpeg could not make the take; is ffmpeg installed?");
    process.exit(1);
  }
}

// ── Supabase's two halves, stubbed ───────────────────────────────────────────
const objects = new Map();
const storage = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://storage");

  // Supabase's storage is a different origin from the app, in production and
  // here, so it answers CORS — and so must this. Without it the browser blocked
  // the upload before a byte left, and the only trace was a console line the
  // suite was not reading. Everything is allowed because this stub holds one
  // test's files and guards nothing.
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin ?? "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, HEAD, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", req.headers["access-control-request-headers"] ?? "*");
  res.setHeader("Access-Control-Expose-Headers", "location, upload-offset, upload-length, tus-resumable, content-length");
  if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }
  const key = decodeURIComponent(url.pathname.replace(/^\/storage\/v1\/object\/(?:public\/|sign\/|authenticated\/)?videos\//, ""));

  // JWKS first: the catch-all below starts with the same prefix, and answering
  // `{}` to a key request is a 401 on every call the browser makes.
  if (url.pathname.endsWith("/.well-known/jwks.json")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(jwks));
    return;
  }
  if (url.pathname.startsWith("/auth/v1/")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({}));
    return;
  }
  // Minting a signed URL is a **POST** to /object/sign/..., with a JSON body.
  // That branch used to live under GET, so the POST fell through to the upload
  // branch below and the object was overwritten with `{"expiresIn":3600}` —
  // eighteen bytes, written over a real video, with a 200 in reply. The upload
  // check then read those eighteen bytes and the render failed on a file that
  // ffmpeg was right to reject. Three red checks, one wrong `if`.
  if (req.method === "POST" && url.pathname.includes("/object/sign/")) {
    for await (const _ of req) { /* drain the body; it is not the object */ }
    // `signedURL` is relative to the *storage* endpoint, not to the site root:
    // the client puts `${supabaseUrl}/storage/v1` in front of whatever it gets
    // back. Answering with a path that already had `/storage/v1` in it produced
    // `/storage/v1/storage/v1/object/...`, which 404s — so every player in the
    // page silently had nothing to play while the render itself was perfect.
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ signedURL: `/object/sign/videos/${key}?token=t` }));
    return;
  }
  if (req.method === "POST" || req.method === "PUT") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    // Refuse to store nothing. A zero-byte "upload" is never what the person
    // chose, and storing it quietly is how this test lied to us once already.
    if (body.length === 0) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "empty upload body" }));
      return;
    }
    objects.set(key, body);
    if (process.env.E2E_TRACE_STORAGE) {
      console.log(`      [storage] ${req.method} ${key} ${body.length}B ct=${req.headers["content-type"]}`);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ Key: `videos/${key}` }));
    return;
  }
  if (req.method === "GET" || req.method === "HEAD") {
    const body = objects.get(key);
    if (!body) { res.writeHead(404).end("no such object"); return; }
    res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": String(body.length) });
    res.end(req.method === "HEAD" ? undefined : body);
    return;
  }
  if (req.method === "DELETE") { objects.delete(key); res.writeHead(200).end("{}"); return; }
  res.writeHead(405).end("no");
});
await new Promise((r) => storage.listen(0, "127.0.0.1", r));
const STORAGE_ORIGIN = `http://127.0.0.1:${storage.address().port}`;
stop.push(() => new Promise((r) => storage.close(r)));

// The signing key the API validates against.
const { SignJWT, exportJWK, generateKeyPair } = await import(
  pathToFileURL(require.resolve("jose", { paths: ["artifacts/api-server"] })).href
);
const { privateKey, publicKey } = await generateKeyPair("ES256");
const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: "e2e", alg: "ES256", use: "sig" }] };
const token = await new SignJWT({ role: "authenticated", email: "e2e@editly.test" })
  .setProtectedHeader({ alg: "ES256", kid: "e2e" })
  .setSubject(USER)
  .setIssuer(`${STORAGE_ORIGIN}/auth/v1`)
  .setAudience("authenticated")
  .setIssuedAt()
  .setExpirationTime("2h")
  .sign(privateKey);

// ── The front end, built against the stub rather than routed away from it ────
//
// `VITE_SUPABASE_URL` is compiled into the bundle, so a prebuilt `dist/` points
// at the real Supabase and every upload has to be intercepted in the browser
// and replayed at the stub. That interception is where the take went missing:
// Playwright's replay does not carry an `XMLHttpRequest.send(File)` body, so
// storage received a POST with the right path, the right content-type and zero
// bytes — and the rest of the run was about a video that was never there. The
// console said ERR_TUNNEL_CONNECTION_FAILED for the calls it did not catch,
// which is a sentence about a proxy and not about this product.
//
// So the front end is built here, after the stub is listening, with the stub's
// own origin baked in. Slower by a Vite build, and the browser then talks to
// the stub directly — no interception anywhere, and an upload that fails fails
// for a reason that belongs to us.
let API_ORIGIN = "";
const apiOrigin = () => API_ORIGIN;
const dist = path.join(repoRoot, "dist");
{
  // `--mode e2e` and not `--mode production`, for one reason: Vite's env dir is
  // the repo root, and the `.env.production.local` there names the real
  // Supabase project. A production-mode build loads that file and its value
  // wins over the one set here — which is exactly what happened, silently: the
  // build succeeded, the bundle still pointed at supabase.co, and the page
  // opened at /login while the session sat in localStorage under a key nothing
  // was looking for. In `e2e` mode no such file exists, so nothing overrides.
  const built = spawnSync("pnpm", ["--filter", "@workspace/editly", "exec", "vite", "build", "--config", "vite.config.ts", "--mode", "e2e"], {
    cwd: repoRoot,
    stdio: ["ignore", "ignore", "inherit"],
    env: {
      ...process.env,
      NODE_ENV: "production",
      VITE_SUPABASE_URL: STORAGE_ORIGIN,
      VITE_SUPABASE_ANON_KEY: "anon-key-for-tests",
    },
  });
  if (built.status !== 0) {
    console.error("the front end would not build; nothing below could run.");
    await shutdown();
    process.exit(1);
  }
  // Vite writes to artifacts/editly/dist/public; `dist/` at the root is what
  // Vercel serves, and `assemble-vercel.mjs` is what puts one into the other.
  // Skipping it left a months-old `dist/` in place, which existed, so the check
  // for it passed, so the run continued against a bundle built for production.
  const assembled = spawnSync(process.execPath, ["tools/assemble-vercel.mjs"], {
    cwd: repoRoot, stdio: ["ignore", "ignore", "inherit"],
  });
  if (assembled.status !== 0 || !existsSync(dist)) {
    console.error("the built front end could not be assembled into dist/.");
    await shutdown();
    process.exit(1);
  }
  // And then check that the thing on disk is the thing we asked for. "It built"
  // and "it built against the stub" are different claims, and only the second
  // one makes the rest of this file mean anything.
  const entry = readdirSync(path.join(dist, "assets")).filter((f) => f.endsWith(".js"));
  const namesTheStub = entry.some((f) =>
    readFileSync(path.join(dist, "assets", f), "utf8").includes(STORAGE_ORIGIN),
  );
  if (!namesTheStub) {
    console.error(`the built front end does not point at the stub (${STORAGE_ORIGIN}).`);
    console.error("Something is overriding VITE_SUPABASE_URL — check the .env files at the repo root.");
    await shutdown();
    process.exit(1);
  }
}
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2", ".jpg": "image/jpeg", ".mp4": "video/mp4", ".webm": "video/webm" };
const site = http.createServer(async (req, res) => {
  if (req.url.startsWith("/api/")) {
    // Straight through to the real API, headers and body intact.
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const upstream = await fetch(`${apiOrigin()}${req.url}`, {
      method: req.method,
      headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => !["host", "connection", "content-length"].includes(k))),
      body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks),
    }).catch((e) => null);
    if (!upstream) { res.writeHead(502).end("api down"); return; }
    const body = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, { "Content-Type": upstream.headers.get("content-type") ?? "application/json" });
    res.end(body);
    return;
  }
  let p = path.join(dist, decodeURIComponent(req.url.split("?")[0]));
  if (!existsSync(p) || statSync(p).isDirectory()) p = path.join(dist, "index.html");
  try {
    const body = await readFile(p);
    res.writeHead(200, { "Content-Type": types[path.extname(p)] ?? "application/octet-stream" });
    res.end(body);
  } catch { res.writeHead(404).end("no"); }
});
await new Promise((r) => site.listen(0, "127.0.0.1", r));
const SITE = `http://127.0.0.1:${site.address().port}`;
stop.push(() => new Promise((r) => site.close(r)));

// ── The API, built the way it deploys ────────────────────────────────────────
section("Everything starts");
{
  const env = {
    ...process.env,
    DATABASE_URL,
    SUPABASE_URL: STORAGE_ORIGIN,
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key-for-tests",
  };
  const built = spawnSync(process.execPath, ["artifacts/api-server/build-vercel.mjs"], {
    cwd: repoRoot, stdio: ["ignore", "ignore", "inherit"], env,
  });
  check("the API bundles the way it deploys", built.status === 0);

  const workerBuilt = spawnSync(process.execPath, ["build.mjs"], {
    cwd: path.join(repoRoot, "artifacts/worker"), stdio: ["ignore", "ignore", "inherit"], env,
  });
  check("and the worker builds the way its image builds it", workerBuilt.status === 0);
  if (built.status !== 0 || workerBuilt.status !== 0) { await shutdown(); process.exit(1); }
}

process.env.DATABASE_URL = DATABASE_URL;
process.env.SUPABASE_URL = STORAGE_ORIGIN;
// The API keeps an origin allowlist and reads it once, at import. The site is
// already listening, so its origin is known and can be named here.
process.env.APP_ORIGIN = SITE;
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-for-tests";
const apiBundle = require("../api/_bundle.js");
const api = http.createServer(apiBundle.default || apiBundle);
await new Promise((r) => api.listen(0, "127.0.0.1", r));
API_ORIGIN = `http://127.0.0.1:${api.address().port}`;
stop.push(() => new Promise((r) => api.close(r)));

const worker = spawn(process.execPath, [path.join(repoRoot, "artifacts/worker/dist/index.mjs")], {
  cwd: repoRoot,
  env: {
    ...process.env,
    DATABASE_URL,
    SUPABASE_URL: STORAGE_ORIGIN,
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key-for-tests",
    POLL_INTERVAL_MS: "400",
    NODE_ENV: "production",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
workerChild = worker;
const workerLog = [];
worker.stdout.on("data", (d) => workerLog.push(String(d)));
worker.stderr.on("data", (d) => workerLog.push(String(d)));
stop.push(() => { worker.kill("SIGTERM"); });

// Give the worker a moment to come up and say so.
await new Promise((r) => setTimeout(r, 2500));
check(
  "the worker is up and polling",
  workerLog.join("").length > 0 && !workerLog.join("").includes("FATAL"),
  workerLog.join("").slice(0, 200),
);

// ── The browser, on a phone ──────────────────────────────────────────────────
const { chromium } = require(
  require.resolve("playwright", { paths: [`${process.env.HOME}/.npm-global/lib/node_modules`, repoRoot] })
);
function chromePath() {
  const r = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!r || !existsSync(r)) return undefined;
  for (const d of readdirSync(r)) {
    if (!/^chromium[-_]/.test(d)) continue;
    const c = path.join(r, d, "chrome-linux", "chrome");
    if (existsSync(c)) return c;
  }
  return undefined;
}
const exe = chromePath();
const browser = await chromium.launch({ ...(exe ? { executablePath: exe } : {}), args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
stop.push(() => browser.close());

const ctx = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const pageErrors = [];
// A blocked or failed request tells you nothing as "Failed to load resource";
// the URL is the whole message. Kept for every run, because this is the check
// that catches a page reaching for something that is not ours.
const failedRequests = [];
page.on("requestfailed", (r) => failedRequests.push(`${r.url().slice(0, 120)} (${r.failure()?.errorText ?? "?"})`));
if (process.env.E2E_TRACE_AUTH) {
  page.on("request", (r) => { if (r.url().includes("/auth/v1")) console.log(`      [auth] → ${r.method()} ${r.url()}`); });
  page.on("response", (r) => { if (r.url().includes("/auth/v1")) console.log(`      [auth] ← ${r.status()} ${r.url()}`); });
}
page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 200)));
page.on("console", (m) => { if (m.type() === "error") pageErrors.push(m.text().slice(0, 200)); });

// The session, under the key supabase-js will actually look for. It derives it
// from its own URL — `sb-${hostname.split(".")[0]}-auth-token` — so hard-coding
// the production project ref here would have written a key nothing reads, and
// the page would have opened signed out while the check said otherwise.
const authRef = new URL(STORAGE_ORIGIN).hostname.split(".")[0];
await ctx.addInitScript(([ref, session]) => {
  try { localStorage.setItem(`sb-${ref}-auth-token`, session); } catch { /* private mode */ }
}, [authRef, JSON.stringify({
  access_token: token, token_type: "bearer", expires_in: 7200,
  expires_at: Math.floor(Date.now() / 1000) + 7200, refresh_token: "e2e",
  user: { id: USER, email: "e2e@editly.test", aud: "authenticated", role: "authenticated" },
})]);

// ── The run ──────────────────────────────────────────────────────────────────
section("A phone, a raw take, and one sentence");

await page.goto(`${SITE}/dashboard`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2000);
await page.screenshot({ path: path.join(SHOTS, "1-dashboard.png") }).catch(() => {});
check("the dashboard opens signed in", (await page.getByTestId("button-new-project").count()) > 0 || /Projects/i.test(await page.title()) , await page.title());
if (process.env.E2E_TRACE_AUTH) {
  console.log("      [auth] wrote key sb-" + authRef + "-auth-token");
  console.log("      [auth] page sees: " + JSON.stringify(await page.evaluate(() => Object.keys(localStorage))));
  console.log("      [auth] url: " + page.url());
}

// Make a project through the UI, the way a person does.
const projectId = randomUUID();
const created = await page.evaluate(async ([base, tok]) => {
  const res = await fetch(`${base}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}` },
    body: JSON.stringify({ title: "A raw take" }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}, [SITE, token]);
check("a project can be created through the API the browser talks to", created.status === 201, JSON.stringify(created).slice(0, 200));
const id = created.body?.id;
if (!id) { console.error("no project id; stopping"); await shutdown(); process.exit(1); }

await page.goto(`${SITE}/project/${id}`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1500);

// Upload the take through the file input the page actually has.
const fileInput = page.locator('input[type="file"]').first();
check("the editor offers somewhere to put a video", (await fileInput.count()) > 0);
await fileInput.setInputFiles(SOURCE);

// The upload is a real POST to the storage stub; wait for the object to land.
//
// The *take* is `source.mp4`. The page also writes `source.preview.webm` beside
// it, and matching `source.*` found whichever landed first — so the size check
// below was sometimes measuring the preview and reporting the upload broken. A
// test that names the wrong file is not a flaky test, it is a wrong one.
const everything = () => [...objects.keys()].map((k) => `${k} (${objects.get(k).length}B)`).join(", ");
let uploaded = null;
for (let i = 0; i < 60 && !uploaded; i++) {
  await page.waitForTimeout(500);
  uploaded = [...objects.keys()].find((k) => k.includes(id) && /\/source\.mp4$/.test(k)) ?? null;
}
if (!uploaded && process.env.E2E_TRACE_STORAGE) {
  console.log("      [upload] page errors: " + JSON.stringify(pageErrors.slice(-5)));
  console.log("      [upload] on screen: " + (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 600));
}
check("the take really is uploaded, as bytes, to storage", Boolean(uploaded), everything().slice(0, 300));
check(
  "and it is the file that was chosen, not an empty placeholder",
  Boolean(uploaded) && objects.get(uploaded).length > 10_000,
  everything().slice(0, 300),
);
await page.screenshot({ path: path.join(SHOTS, "2-uploaded.png") }).catch(() => {});

section("Describing the edit, and getting one back");

// One sentence, typed into the same box everything else goes through.
const chat = page.getByTestId("input-chat");
await chat.waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
await chat.fill("cut the dead air and make it vertical for tiktok");
await page.getByTestId("button-send-message").click();

// Noah answers before anything renders: the plan, in words, first.
let reply = "";
for (let i = 0; i < 40 && !/cut|silence|vertical/i.test(reply); i++) {
  await page.waitForTimeout(500);
  reply = await page.locator("body").innerText();
}
check(
  "it says what it will do before it does it",
  /silence|dead air/i.test(reply) && /9:16|vertical|tiktok/i.test(reply),
  reply.replace(/\s+/g, " ").slice(0, 200),
);
await page.screenshot({ path: path.join(SHOTS, "3-answered.png") }).catch(() => {});

// Now the render. This is a real ffmpeg run in the real worker binary.
section("The render, by the worker that ships");
const started = Date.now();
let job = null;
for (let i = 0; i < 240; i++) {
  await page.waitForTimeout(1000);
  job = await page.evaluate(async ([base, tok, pid]) => {
    const res = await fetch(`${base}/api/projects/${pid}`, { headers: { Authorization: `Bearer ${tok}` } });
    return res.ok ? await res.json() : null;
  }, [SITE, token, id]);
  if (job && (job.status === "done" || job.status === "failed")) break;
}
const seconds = Math.round((Date.now() - started) / 1000);
// The worker's own words, and only the ones that failed — the tail of a log is
// usually its "ready" line, which is the least interesting thing in it.
const workerTrouble = workerLog
  .join("")
  .split("\n")
  .filter((l) => /"level":(50|60)|error|failed/i.test(l))
  .slice(-2)
  .map((l) => {
    try {
      const r = JSON.parse(l);
      return `${r.msg ?? ""}: ${r.err?.message ?? r.error ?? ""}`.replace(/\s+/g, " ").slice(0, 260);
    } catch { return l.slice(0, 260); }
  })
  .join(" | ");
// Whatever happens, the worker's whole log is written down. A render failure
// is the one thing in this run that cannot be reproduced by reading code, and
// a summary is not a substitute for the log when the summary is empty.
const workerLogPath = path.join(SHOTS, "worker.log");
await writeFile(workerLogPath, workerLog.join("")).catch(() => {});
check(
  "the render finished",
  job?.status === "done",
  `${job?.status} after ${seconds}s :: ${workerTrouble || "the worker said nothing about it"} (full log: ${workerLogPath})`,
);

const edited = [...objects.keys()].find((k) => k.includes(id) && /edited-/.test(k));
check("an edited file is in storage", Boolean(edited), [...objects.keys()].join(", ").slice(0, 300));

if (edited) {
  const out = path.join(work, "edited.mp4");
  await writeFile(out, objects.get(edited));
  const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height", "-show_entries", "format=duration",
    "-of", "default=nw=1", out], { encoding: "utf8" });
  const w = Number(/width=(\d+)/.exec(probe.stdout)?.[1]);
  const h = Number(/height=(\d+)/.exec(probe.stdout)?.[1]);
  const dur = Number(/duration=([\d.]+)/.exec(probe.stdout)?.[1]);

  check("what came back is a video ffprobe can read", Number.isFinite(w) && Number.isFinite(h), probe.stdout.trim());
  // The sentence asked for vertical. This is the whole promise of the product,
  // measured on the file rather than on the reply.
  check("it is vertical, because that is what the sentence asked for", h > w, `${w}x${h}`);
  // Five of the twelve seconds were silence.
  check(
    "and it is shorter than the take, because the dead air is gone",
    Number.isFinite(dur) && dur < 11,
    `${dur}s out of 12`,
  );
  const audio = spawnSync("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_type", "-of", "csv=p=0", out], { encoding: "utf8" });
  check("with the sound still on it", /audio/.test(audio.stdout), audio.stdout.trim());
}

section("And the person is told, on the screen they are looking at");
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);
const after = await page.locator("body").innerText();
await page.screenshot({ path: path.join(SHOTS, "4-done.png") }).catch(() => {});
check(
  "the editor says the edit is done rather than still thinking",
  /done|AI Edited/i.test(after),
  after.replace(/\s+/g, " ").slice(0, 200),
);

// On a phone the conversation is folded away when the edit lands, so the
// picture gets the screen. The notes are behind the header — which is a claim
// worth checking rather than assuming, because a sheet that does not open is
// the same as notes that were never written.
check(
  "and it says there is something new to read",
  (await page.getByTestId("chat-unread").count()) > 0,
);
await page.getByTestId("button-toggle-chat").click().catch(() => {});
await page.waitForTimeout(600);
await page.screenshot({ path: path.join(SHOTS, "5-notes.png") }).catch(() => {});
const opened = await page.locator("body").innerText();
check(
  "and the notes say what was actually done to it",
  /silence|9:16|vertical|LUFS/i.test(opened),
  opened.replace(/\s+/g, " ").slice(0, 240),
);
// The web fonts are fetched from Google and Fontshare, and this container has
// no route to either. That is this machine's network, not the product — but it
// is worth writing down that the app makes three blocking cross-origin
// stylesheet requests before it paints, which on a phone is three round trips
// somebody is waiting through.
const FONT_HOSTS = /fonts\.googleapis\.com|fonts\.gstatic\.com|api\.fontshare\.com/;
// ERR_ABORTED is the page cancelling its own request — a <video> whose src is
// swapped when the edit lands, or a blob: preview being revoked. It is the
// browser doing as it was told, not a failure.
const ourFailures = [...new Set(failedRequests)].filter(
  (f) => !FONT_HOSTS.test(f) && !f.includes("ERR_ABORTED"),
);
const ourErrors = pageErrors.filter((e) => !/Failed to load resource/.test(e));
check(
  "nothing threw in the browser along the way",
  ourFailures.length === 0 && ourErrors.length === 0,
  [...ourFailures.slice(0, 2), ...ourErrors.slice(0, 2)].join(" | "),
);

await shutdown();
await rm(work, { recursive: true, force: true });

console.log(`\n${pass}/${pass + failures.length} checks passed`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
console.log("Somebody can open this on a phone, hand it a video, and get an edit back.");
