/**
 * Will this actually post?
 *
 * Scheduling an edit to five places is a promise, and the only way to keep it
 * is to know each platform's rules before the moment the post is due. X stops
 * at 280 characters and 140 seconds; TikTok wants vertical and ten minutes;
 * Snapchat stops at 250. A person writing one caption for four places cannot
 * hold four sets of rules in their head, and the failure this feature exists
 * to remove is finding out at 9pm that the 9pm post was refused.
 *
 * So the rules are checked here, from the position of somebody about to press
 * "schedule": is this sentence about a rule I have actually broken, does it
 * tell me the number, and does it refuse the things a platform would refuse
 * without refusing the things it would not.
 *
 * The last of those is the one worth writing tests for. A limit that is too
 * strict is invisible — nothing fails, the person just quietly cannot post
 * something that would have been fine.
 *
 * Usage: node tools/posting-test.mjs
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
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-posting-"));
const esbuild = require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/api-server"] });

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

const {
  refusalsFor,
  captionLength,
  scheduleRefusal,
  MIN_LEAD_SECONDS,
  MAX_LEAD_DAYS,
  SOCIAL_PLATFORMS: PLATFORMS,
  SOCIAL_SPEC: PLATFORM_SPEC,
  configuredPlatforms,
  platformCatalogue,
  isSocialPlatform: isPlatform,
} = await load("lib/api-zod/src/social.ts", "social");

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

const post = (over = {}) => ({
  platform: "instagram",
  caption: "a normal caption",
  hashtags: [],
  durationSeconds: 30,
  width: 1080,
  height: 1920,
  ...over,
});

// ── The platforms ────────────────────────────────────────────────────────────
section("The five places an edit can go");

check("all five are known", PLATFORMS.length === 5, PLATFORMS.join(", "));
check("and each one has a spec", PLATFORMS.every((p) => PLATFORM_SPEC[p]));
check(
  "every platform names two environment variables, and no two share one",
  new Set(PLATFORMS.flatMap((p) => [PLATFORM_SPEC[p].clientIdVar, PLATFORM_SPEC[p].clientSecretVar]))
    .size === PLATFORMS.length * 2,
  "a shared variable means turning one platform on turns another on too",
);
check("a string that is not a platform is not a platform", !isPlatform("youtube") && !isPlatform(""));

// An empty environment must say "nothing is connected" rather than showing
// five buttons that cannot work.
check(
  "with no credentials set, nothing claims to be connected",
  Object.values(configuredPlatforms({})).every((on) => on === false),
  JSON.stringify(configuredPlatforms({})),
);

const half = { [PLATFORM_SPEC.x.clientIdVar]: "id" };
check(
  "an id without a secret is still not connected",
  configuredPlatforms(half).x === false,
  "half a credential posts nothing, and a button that half works is worse than one that is off",
);
const whole = { ...half, [PLATFORM_SPEC.x.clientSecretVar]: "secret" };
check("both together are", configuredPlatforms(whole).x === true);
check(
  "an empty string is not a credential",
  configuredPlatforms({ ...whole, [PLATFORM_SPEC.x.clientSecretVar]: "   " }).x === false,
  "an unset Fly secret reads as empty, not as absent",
);
check(
  "and the environment is read per call, not captured at import",
  configuredPlatforms(whole).x === true && configuredPlatforms({}).x === false,
  "APP_ORIGIN was frozen into a bundle by exactly this kind of read",
);

check(
  "the catalogue carries no secrets",
  !JSON.stringify(platformCatalogue(whole)).match(/secret|token|client_?id/i),
  JSON.stringify(platformCatalogue(whole)).slice(0, 120),
);
check(
  "and it does not leak the value of a variable it was handed",
  !JSON.stringify(platformCatalogue({ ...whole, X_CLIENT_SECRET: "hunter2" })).includes("hunter2"),
  "the catalogue is built from an env object now, so this is worth saying out loud",
);

// ── What each platform refuses ───────────────────────────────────────────────
section("What a platform will refuse, said before it refuses it");

check("an ordinary post is not refused", refusalsFor(post()).length === 0);

check(
  "X refuses 281 characters",
  refusalsFor(post({ platform: "x", caption: "a".repeat(281) })).some((r) => r.field === "caption"),
);
check(
  "and takes 280",
  refusalsFor(post({ platform: "x", caption: "a".repeat(280) })).length === 0,
  "a limit that is one too strict is invisible: nothing fails, you just cannot post",
);
check(
  "the refusal says the platform, the limit and the length",
  /X/.test(refusalsFor(post({ platform: "x", caption: "a".repeat(300) }))[0].message) &&
    /280/.test(refusalsFor(post({ platform: "x", caption: "a".repeat(300) }))[0].message) &&
    /300/.test(refusalsFor(post({ platform: "x", caption: "a".repeat(300) }))[0].message),
  refusalsFor(post({ platform: "x", caption: "a".repeat(300) }))[0].message,
);

// The bug this pair exists for: hashtags are stored apart from the caption so
// they can be edited as a set, and every platform counts them anyway.
check(
  "hashtags count against the limit",
  refusalsFor(post({ platform: "x", caption: "a".repeat(275), hashtags: ["#editing"] })).some(
    (r) => r.field === "caption",
  ),
  "275 + a nine-character tag is 285, and counting only the caption is how that posts as 240",
);
check(
  "and the count includes the space and the hash",
  captionLength("ab", ["one", "two"]) === 2 + 1 + "#one #two".length,
  String(captionLength("ab", ["one", "two"])),
);
check(
  "an empty hashtag is not a hashtag",
  captionLength("ab", ["  ", ""]) === 2,
  String(captionLength("ab", ["  ", ""])),
);

check(
  "X refuses 141 seconds",
  refusalsFor(post({ platform: "x", durationSeconds: 141 })).some((r) => r.field === "duration"),
);
check("and takes 140", refusalsFor(post({ platform: "x", durationSeconds: 140 })).length === 0);
check(
  "the duration refusal names the real limit, not a rounded one",
  /2m 20s/.test(refusalsFor(post({ platform: "x", durationSeconds: 200 }))[0].message),
  // It said "2 minutes" for a limit of 140 seconds. Somebody reading that cuts
  // to 2:00 they did not need to, or believes 2:10 is fine. A number in a
  // refusal is the number somebody will edit against.
  refusalsFor(post({ platform: "x", durationSeconds: 200 }))[0].message,
);
check(
  "and the length beside it",
  /3m 20s/.test(refusalsFor(post({ platform: "x", durationSeconds: 200 }))[0].message),
  refusalsFor(post({ platform: "x", durationSeconds: 200 }))[0].message,
);

check(
  "TikTok refuses a landscape edit",
  refusalsFor(post({ platform: "tiktok", width: 1920, height: 1080 })).some(
    (r) => r.field === "shape",
  ),
);
check(
  "and takes a vertical one",
  refusalsFor(post({ platform: "tiktok", width: 1080, height: 1920 })).length === 0,
);
check(
  "Instagram takes either shape",
  refusalsFor(post({ platform: "instagram", width: 1920, height: 1080 })).length === 0,
);

// The quiet one. A field we do not have is not a field that is wrong, and
// refusing on an unknown blocks correct posts for a reason nobody can see.
check(
  "an unknown duration is not too long",
  refusalsFor(post({ platform: "x", durationSeconds: null })).length === 0,
);
check(
  "an unknown shape is not the wrong shape",
  refusalsFor(post({ platform: "tiktok", width: null, height: null })).length === 0,
);

check(
  "everything wrong at once is reported at once",
  refusalsFor(post({ platform: "x", caption: "a".repeat(400), durationSeconds: 900 })).length === 2,
  "one refusal at a time is three round trips to find out three things",
);

// ── When it may go ───────────────────────────────────────────────────────────
section("When a post may be scheduled for");

const now = new Date("2026-08-30T12:00:00Z");
const inSeconds = (s) => new Date(now.getTime() + s * 1000);

check("a minute from now is fine", scheduleRefusal(inSeconds(MIN_LEAD_SECONDS), now) === null);
check(
  "ten seconds from now is not",
  typeof scheduleRefusal(inSeconds(10), now) === "string",
  "the publisher polls, so 'in ten seconds' is a promise about somebody else's clock",
);
check("the past is not", typeof scheduleRefusal(inSeconds(-60), now) === "string");
check(
  `${MAX_LEAD_DAYS} days out is fine`,
  scheduleRefusal(inSeconds(MAX_LEAD_DAYS * 24 * 60 * 60 - 60), now) === null,
);
check(
  "a year out is not",
  typeof scheduleRefusal(inSeconds(400 * 24 * 60 * 60), now) === "string",
);
check("and neither is a sentence", typeof scheduleRefusal(new Date("soon"), now) === "string");

await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("A post is refused before it is due, or not at all.");
