/**
 * What the API says when it says no.
 *
 * Two small pure functions decide that, and until now nothing tested either of
 * them. Both were wrong, and both were wrong in the same way: they answered a
 * *status code* rather than a *cause*, on the reasoning — correct when it was
 * written — that at this status there was only one cause.
 *
 * `bodyFor` read a 403 and said "This origin is not allowed to call the API."
 * That was true while CORS was the only thing here that could produce one. It
 * stopped being true the day a suspended account could, and nothing failed,
 * because a wrong sentence is still a sentence: the person is told, with total
 * confidence, about a rule they have not broken. The same shape sat under 400
 * ("Body could not be read as JSON") and 413.
 *
 * `isAllowedOrigin` had the opposite problem: it read `APP_ORIGIN` once, at
 * import, and `build-vercel.mjs` handed esbuild a `define` for that read — so
 * on any locally built bundle the allowlist was a string literal from whatever
 * `.env.production.local` said at build time, and the value on the hosting
 * dashboard had no read left to answer.
 *
 * So the checks here are written from the position of someone reading the
 * refusal: is this sentence about the thing that actually happened, and is this
 * list the one that is configured right now.
 *
 * Usage: node tools/refusal-test.mjs
 * Requires: nothing. No keys, no network, no database.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-refusal-build-"));

const esbuild = require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/api-server"] });

/** Bundles one module of the API and imports it, the way policy-test does. */
async function load(source, name) {
  const outfile = path.join(buildDir, `${name}.mjs`);
  const built = spawnSync(
    esbuild,
    [
      path.join(repoRoot, source),
      "--bundle", "--platform=node", "--format=esm", "--target=node22",
      `--outfile=${outfile}`, "--log-level=error",
    ],
    { stdio: "inherit" },
  );
  if (built.status !== 0) {
    console.error(`could not bundle ${source}`);
    process.exit(1);
  }
  return import(pathToFileURL(outfile).href);
}

const { statusFor, bodyFor, UNEXPECTED, ORIGIN_REFUSED } =
  await load("artifacts/api-server/src/lib/error-handler.ts", "error-handler");

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

// ── The status ───────────────────────────────────────────────────────────────
section("What status a failure deserves");

const corsError = new Error("Origin not allowed: https://evil.example");

check("a refused origin is a 403, not a 500", statusFor(corsError) === 403);
check("a body that is not JSON is a 400", statusFor({ type: "entity.parse.failed" }) === 400);
check("a body that is too large is a 413", statusFor({ type: "entity.too.large" }) === 413);
check("a status somebody set deliberately is believed", statusFor({ status: 409 }) === 409);
check("and so is `statusCode`, which half the libraries use", statusFor({ statusCode: 404 }) === 404);
check(
  "a `status: 0` from a failed fetch is not a 0 response",
  statusFor({ status: 0 }) === 500,
  "0 is outside the range that means anything, so it is our bug until classified",
);
check("an unclassified failure is a 500, because we do not understand it", statusFor(new Error("boom")) === 500);
check("and so is nothing at all", statusFor(null) === 500 && statusFor("a string") === 500);

// ── The sentence ─────────────────────────────────────────────────────────────
section("What the person is told, and whether it is about what happened");

check(
  "a refused origin is told it is a refused origin",
  bodyFor(403, corsError).error === ORIGIN_REFUSED,
);

// The bug this file exists for. Every one of these is a 403 that has nothing to
// do with CORS, and every one of them used to be answered with a sentence about
// CORS.
const suspended = Object.assign(new Error("This account is suspended."), { status: 403, expose: true });
check(
  "a suspended account is NOT told about a CORS rule it has not broken",
  bodyFor(403, suspended).error !== ORIGIN_REFUSED,
  bodyFor(403, suspended).error,
);
check(
  "and is told the thing whoever wrote the refusal chose to say",
  bodyFor(403, suspended).error === "This account is suspended.",
);
check(
  "a 403 from somewhere else, with no wording of its own, says nothing it cannot back up",
  bodyFor(403, Object.assign(new Error("403 from storage"), { status: 403 })).error ===
    "That request could not be completed.",
);

check(
  "a body the parser could not read is told exactly that",
  bodyFor(400, { type: "entity.parse.failed" }).error === "Body could not be read as JSON.",
);
check(
  "but a deliberate 400 is not told its JSON was unreadable when it was fine",
  bodyFor(400, Object.assign(new Error("That project already has a render running."), { expose: true })).error ===
    "That project already has a render running.",
);
check(
  "a body over the limit is told exactly that",
  bodyFor(413, { type: "entity.too.large" }).error === "That request body is too large.",
);

check("a 500 says the same thing whatever caused it", bodyFor(500, new Error("relation \"jobs\" does not exist")).error === UNEXPECTED);
check(
  "and never the driver's own message, which is a column list",
  !bodyFor(500, new Error("relation \"jobs\" does not exist")).error.includes("jobs"),
);
check(
  "a message is only repeated when somebody marked it safe to repeat",
  bodyFor(422, new Error("duplicate key value violates unique constraint \"projects_pkey\"")).error ===
    "That request could not be completed.",
  "`expose` is the mark; without it the message is a driver's, not ours",
);

// ── The allowlist ────────────────────────────────────────────────────────────
section("Which browsers are allowed to call this at all");

const { isAllowedOrigin } = await load("artifacts/api-server/src/lib/allowed-origins.ts", "allowed-origins");

check("the app's own domain, which is named rather than configured", isAllowedOrigin("https://app.editlyai.io"));
check("the waiting-list page, on its own domain", isAllowedOrigin("https://editlyai.io"));
check("and with the www that half the links use", isAllowedOrigin("https://www.editlyai.io"));
check("the dev server", isAllowedOrigin("http://localhost:5173"));
check("a Vercel preview deployment", isAllowedOrigin("https://editly-abc123-osama.vercel.app"));

check("someone else's site is not", !isAllowedOrigin("https://evil.example"));
check(
  "nor is a hostname that merely ends with ours",
  !isAllowedOrigin("https://editlyai.io.evil.example"),
);
check(
  "nor a vercel.app that is not one of ours",
  !isAllowedOrigin("https://editly-abc.evil.vercel.app"),
);
check("nor the same domain over plain http", !isAllowedOrigin("http://app.editlyai.io"));

// The read that was frozen. `isAllowedOrigin` must answer from the environment
// as it is *now*, not as it was when the module was imported — which is the
// whole difference between a value on a dashboard that works and one that is
// decoration.
const before = process.env["APP_ORIGIN"];
process.env["APP_ORIGIN"] = "https://staging.editlyai.io";
check(
  "APP_ORIGIN is read at call time, so setting it takes effect without a rebuild",
  isAllowedOrigin("https://staging.editlyai.io"),
  "if this fails, a bundler has inlined the read again",
);
delete process.env["APP_ORIGIN"];
check(
  "and unsetting it takes effect too, without locking out the live app",
  !isAllowedOrigin("https://staging.editlyai.io") && isAllowedOrigin("https://app.editlyai.io"),
);
if (before === undefined) delete process.env["APP_ORIGIN"];
else process.env["APP_ORIGIN"] = before;

// ── And the build that used to freeze it ────────────────────────────────────
section("And the build cannot put it back");

const { readFileSync } = await import("node:fs");
const buildScript = readFileSync(path.join(repoRoot, "artifacts/api-server/build-vercel.mjs"), "utf8");
const defined = buildScript.match(/for \(const key of \[([^\]]*)\]/);
check(
  "build-vercel does not hand esbuild a define for APP_ORIGIN",
  Boolean(defined) && !defined[1].includes("APP_ORIGIN"),
  "esbuild substitutes the bracket form too, so a define here is a literal in the bundle",
);

await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("A refusal says what was actually refused.");
