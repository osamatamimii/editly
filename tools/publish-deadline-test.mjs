/**
 * No request to a platform may run without a deadline.
 *
 * Node's `fetch` has no timeout, and the worker publishes on the same process
 * it renders on. The publish loop is sequential — `publishDuePosts` awaits one
 * row before it starts the next — so a socket a platform accepts and never
 * answers does not fail: it wedges the loop on that one row while every post
 * behind it waits, and `/api/healthz` goes on reporting the worker online. This
 * is the exact shape `providers/deadline.ts` was written for, and the
 * publishers were the last outbound calls in the worker not using it.
 *
 * The property under test is the wiring, not the timer. `deadline-test.mjs`
 * already proves the child-process ceiling; this proves that every publisher,
 * and the token refresh underneath them, reaches for `withDeadline(fetch)` when
 * nobody injects a fetch of their own. So it replaces the global `fetch` with
 * one that accepts the connection and never answers — ignoring the abort
 * signal, so only the wrapper's own race can end it — sets the deadline to a
 * fraction of a second, and calls each publisher with no `fetchImpl`. A
 * publisher still on bare `fetch` would hang here, and the watchdog below would
 * fail it. That is the revert test: put `?? fetch` back and this goes red.
 *
 * Usage: node tools/publish-deadline-test.mjs
 * Requires: nothing. No keys, no network, no database.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

// Before anything imports the worker: the deadline is read from the environment
// at module load, so it has to be small before the bundle exists.
process.env.PROVIDER_TIMEOUT_MS = "150";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-pubdeadline-"));

function bundle(entry, name) {
  const outfile = path.join(buildDir, name);
  const built = spawnSync(
    require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/worker"] }),
    [
      path.join(repoRoot, entry), "--bundle", "--platform=node", "--format=esm",
      "--target=node22", `--outfile=${outfile}`, "--log-level=error",
      "--external:pg-native", "--external:@workspace/db",
      "--banner:js=import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);",
    ],
    { stdio: "inherit" },
  );
  if (built.status !== 0) {
    console.error(`could not bundle ${entry}`);
    process.exit(1);
  }
  return pathToFileURL(outfile).href;
}

const { withDeadline, PROVIDER_TIMEOUT_MS } =
  await import(bundle("artifacts/worker/src/providers/deadline.ts", "deadline.mjs"));
const { publishToYouTube } = await import(bundle("artifacts/worker/src/publish-youtube.ts", "youtube.mjs"));
const { publishToInstagram, publishToFacebook } = await import(bundle("artifacts/worker/src/publish-meta.ts", "meta.mjs"));
const { publishToTikTok } = await import(bundle("artifacts/worker/src/publish-tiktok.ts", "tiktok.mjs"));
const { publishToX } = await import(bundle("artifacts/worker/src/publish-x.ts", "x.mjs"));

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

console.log("deadline in force:", PROVIDER_TIMEOUT_MS, "ms");

// A fetch that connects and never answers, and does not honour abort — so the
// only thing that can end it is the wrapper's own race against its timer. This
// is the honest model of a wedged socket: the whole reason the wrapper races
// rather than trusting abort is that "the transport always respects abort" is
// the assumption that would let a worker hang.
const hangForever = () => new Promise(() => {});

/**
 * Run a call that must reject on the deadline, against a watchdog longer than
 * the deadline but far shorter than forever. If the watchdog wins, the call
 * hung — which is the bug.
 */
async function racesTheDeadline(fn) {
  const WATCHDOG = 3000;
  let timer;
  const watchdog = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ hung: true }), WATCHDOG);
  });
  const attempt = fn().then(
    () => ({ hung: false, resolved: true }),
    (error) => ({ hung: false, error }),
  );
  const result = await Promise.race([attempt, watchdog]);
  clearTimeout(timer);
  return result;
}

const isDeadline = (r) =>
  !r.hung && r.error instanceof Error && /no response within/.test(r.error.message);

section("The wrapper ends a hung request whether or not the socket cooperates");
{
  const bounded = withDeadline(hangForever, 150);
  const r = await racesTheDeadline(() => bounded("https://example.test/"));
  check("a request that never answers is aborted, not awaited forever", isDeadline(r), describe(r));

  // The caller's own signal still wins if it fires first — cancelling a job has
  // to stay instant rather than waiting out the deadline. This path runs
  // through the transport (real `fetch` tears the socket down on abort), so it
  // is modelled with a fetch that honours the signal, under a deadline long
  // enough that only the caller's abort can end the call.
  const honoursAbort = (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted by caller")));
    });
  const ac = new AbortController();
  const withLongDeadline = withDeadline(honoursAbort, 60_000);
  const started = Date.now();
  const cancelled = racesTheDeadline(() => withLongDeadline("https://example.test/", { signal: ac.signal }));
  setTimeout(() => ac.abort(), 50);
  const cr = await cancelled;
  check(
    "and a caller's abort ends it at once, without waiting out the deadline",
    !cr.hung && cr.error instanceof Error && Date.now() - started < 2000,
    describe(cr),
  );
}

// ── The wiring: every publisher reaches for the bounded fetch by default ──

const savedFetch = globalThis.fetch;
globalThis.fetch = hangForever;

const work = await mkdtemp(path.join(tmpdir(), "editly-pd-"));
const file = path.join(work, "post.mp4");
await writeFile(file, Buffer.alloc(2048, 7)); // not a real video; the point is the fetch, not the encode

const base = { caption: "hi", hashtags: [], accessToken: "token" };

section("Every publisher, given no fetch of its own, still cannot hang");
{
  // Instagram/Facebook take a URL and their first outbound call is the page
  // lookup — no file needed.
  const ig = await racesTheDeadline(() => publishToInstagram({ ...base, videoUrl: "https://example.test/v.mp4" }));
  check("Instagram's default fetch has a deadline", isDeadline(ig), describe(ig));

  const fb = await racesTheDeadline(() => publishToFacebook({ ...base, videoUrl: "https://example.test/v.mp4" }));
  check("Facebook's default fetch has a deadline", isDeadline(fb), describe(fb));

  // TikTok's first outbound call comes before it touches the file.
  const tk = await racesTheDeadline(() => publishToTikTok({ ...base, file }));
  check("TikTok's default fetch has a deadline", isDeadline(tk), describe(tk));

  // X measures the file first; inject the measurement so the test is about the
  // network call, not about ffprobe reading a fake mp4.
  const x = await racesTheDeadline(() => publishToX({ ...base, file, durationOf: async () => 5 }));
  check("X's default fetch has a deadline", isDeadline(x), describe(x));

  // YouTube stats the file, then makes its first request.
  const yt = await racesTheDeadline(() => publishToYouTube({ ...base, file }));
  check("YouTube's default fetch has a deadline", isDeadline(yt), describe(yt));
}

globalThis.fetch = savedFetch;

// ── And the source says so, so a new call site cannot quietly use bare fetch ──

section("No publisher path calls fetch without a deadline");
{
  const { readFileSync } = await import("node:fs");
  const files = [
    "publish-youtube.ts", "publish-meta.ts", "publish-tiktok.ts", "publish-x.ts", "social-token.ts",
  ];
  for (const name of files) {
    const source = readFileSync(path.join(repoRoot, "artifacts/worker/src", name), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    // A bare `fetch(` that is not `withDeadline(fetch)` and not the `?? fetch`
    // of an injected default is the thing this forbids.
    const bare = [...source.matchAll(/[^.\w]fetch\s*\(/g)];
    check(
      `${name} makes no un-deadlined fetch call`,
      bare.length === 0,
      `${bare.length} bare fetch call(s)`,
    );
    check(`${name} imports the deadline`, /withDeadline/.test(readFileSync(path.join(repoRoot, "artifacts/worker/src", name), "utf8")));
  }
}

function describe(r) {
  if (r.hung) return "the call hung past the watchdog — it is not deadlined";
  if (r.resolved) return "it resolved instead of timing out — the hanging fetch did not reach the wrapper";
  return String(r.error?.message ?? r.error);
}

await rm(buildDir, { recursive: true, force: true });
await rm(work, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("Nothing the worker sends can run forever.");
