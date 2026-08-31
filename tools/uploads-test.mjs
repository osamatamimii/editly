/**
 * The refusals that used to arrive from somebody else's server.
 *
 * Every upload in this product used to go straight from a browser to Supabase
 * Storage carrying the person's own token, and every refusal came back from
 * there: a 400 for a content type the bucket does not hold, a 413 for a file
 * over a ceiling that lives in a Supabase setting. Our API was not on the path,
 * so there was no line in any log we own and no sentence on the screen. That is
 * the shape of failure this repository keeps finding, and it produced two of
 * the worst bugs it has had.
 *
 * `POST /uploads` moves the decision here. This suite is what makes that claim
 * checkable, and it checks the two halves separately because they fail
 * differently.
 *
 * **The decision** is a pure function, so the whole table of it is exercised
 * directly: every purpose against every kind of file, the ceilings, the
 * quotas, and the sentence each refusal produces. No bucket, no database, no
 * browser, which is what makes it worth running on every push.
 *
 * **The wiring** cannot be exercised without a Postgres and a Supabase, so it
 * is read instead. Not to check that the code is pretty: to check the four
 * properties that would be silently untrue if somebody reordered this file one
 * afternoon. That the ownership lookup happens before the decision. That
 * nothing is signed before the decision. That every refusal is logged. And
 * that the browser no longer spells a storage path at all, which is the whole
 * point and also the easiest thing to quietly put back.
 *
 * Usage: node tools/uploads-test.mjs
 * Requires: nothing. No keys, no network, no database.
 */
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const read = (p) => readFileSync(path.join(repoRoot, p), "utf8");
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-uploads-"));

function build(source, name) {
  const outfile = path.join(buildDir, name);
  const built = spawnSync(
    require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/api-server"] }),
    [
      path.join(repoRoot, source),
      "--bundle", "--platform=node", "--format=esm", "--target=node22",
      `--outfile=${outfile}`, "--log-level=error",
    ],
    { stdio: "inherit" },
  );
  if (built.status !== 0) process.exit(1);
  return pathToFileURL(outfile).href;
}

const policy = await import(build("artifacts/api-server/src/lib/upload-policy.ts", "policy.mjs"));
const keys = await import(build("lib/object-store/src/keys.ts", "keys.mjs"));

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

const GB = 1024 * 1024 * 1024;

/** The context a signed-in person with an empty account and a roomy bucket has. */
const forUser = (extra = {}) => ({
  userId: "user-1",
  ceilingBytes: GB,
  stamp: "stamp-1",
  ...extra,
});

const plan = (request, context = {}) => policy.planUpload(request, forUser(context));
const refusalOf = (request, context = {}) => {
  const decision = plan(request, context);
  return decision.ok ? null : decision.refusal;
};

// ── The key ─────────────────────────────────────────────────────────────────

section("The key is built here, and the request has nowhere to put one");
{
  const source = plan({ purpose: "source", filename: "take.mp4", bytes: 1024, projectId: "proj-1" });
  check("a take lands under the person and the project", source.ok && source.plan.key === "user-1/proj-1/source.mp4", JSON.stringify(source));

  const asset = plan({ purpose: "asset", filename: "logo.png", bytes: 1024, projectId: "proj-1" });
  check(
    "an extra file gets a generated leaf rather than the one it arrived with",
    asset.ok && asset.plan.key === "user-1/proj-1/asset-stamp-1.png",
    JSON.stringify(asset),
  );

  const font = plan({ purpose: "font", filename: "Brand.otf", bytes: 1024 });
  check(
    "a font belongs to the person, not to a project",
    font.ok && font.plan.key === "user-1/fonts/font-stamp-1.otf",
    JSON.stringify(font),
  );

  const poster = plan({ purpose: "thumbnail", filename: "thumb.jpg", bytes: 1024, projectId: "proj-1" });
  check("a poster frame has one fixed name", poster.ok && poster.plan.key === "user-1/proj-1/thumb.jpg", JSON.stringify(poster));

  const reference = plan({ purpose: "reference", filename: "look.mov", bytes: 1024, projectId: "proj-1" });
  check("and so does a reference", reference.ok && reference.plan.key === "user-1/proj-1/reference.mov", JSON.stringify(reference));

  /*
    The filename is the one part of an upload somebody fully controls.

    It decides the content type and, for the two fixed-name purposes, the
    extension. It never becomes a segment. So a name built to traverse cannot
    steer a key: it is refused at the type table long before that, because
    nothing this product stores has an extension of `../etc/passwd`.
  */
  check(
    "a name built to traverse is refused rather than sanitised",
    refusalOf({ purpose: "asset", filename: "../../../etc/passwd", bytes: 10, projectId: "proj-1" })?.reason === "unknown-type",
  );
  check(
    "and so is its percent-encoded twin",
    refusalOf({ purpose: "asset", filename: "%2e%2e%2fsecrets", bytes: 10, projectId: "proj-1" })?.reason === "unknown-type",
  );
  check(
    "an uppercase extension is not a different extension",
    plan({ purpose: "source", filename: "HOLIDAY.MOV", bytes: 10, projectId: "p" }).plan?.key === "user-1/p/source.mov",
  );
  check(
    "and a double extension is read as the last one, which is the one that decides",
    refusalOf({ purpose: "asset", filename: "sneaky.mp4.exe", bytes: 10, projectId: "p" })?.reason === "unknown-type",
  );

  /*
    The project id is the only segment that comes from the request, and the
    route has already found a row with it before this runs. This is the check
    that a future caller skipping that lookup does not get a traversal for
    free, and it is the store's own rule rather than a second spelling of it.
  */
  const traversed = refusalOf({ purpose: "source", filename: "take.mp4", bytes: 10, projectId: "../../elsewhere" });
  check("a project id that is not one segment cannot make a key", traversed?.reason === "unsafe-key", JSON.stringify(traversed));

  section("Every key this produces is one the object store will accept");
  for (const [label, request] of [
    ["a take", { purpose: "source", filename: "take.mp4", bytes: 10, projectId: "proj-1" }],
    ["an extra file", { purpose: "asset", filename: "bed.mp3", bytes: 10, projectId: "proj-1" }],
    ["a font", { purpose: "font", filename: "Brand.ttf", bytes: 10 }],
    ["a poster", { purpose: "thumbnail", filename: "thumb.jpg", bytes: 10, projectId: "proj-1" }],
    ["a reference", { purpose: "reference", filename: "look.mp4", bytes: 10, projectId: "proj-1" }],
  ]) {
    const decision = plan(request);
    check(
      `${label} passes the store's key rule`,
      decision.ok && keys.isSafeKey(decision.plan.key) && keys.isOwnedBy(decision.plan.key, "user-1"),
      JSON.stringify(decision),
    );
  }
}

// ── What each purpose is for ────────────────────────────────────────────────

section("Each purpose takes what it is for and refuses what it is not");
{
  check(
    "a project is edited from a video, not from a spreadsheet",
    refusalOf({ purpose: "source", filename: "numbers.mp3", bytes: 10, projectId: "p" })?.reason === "wrong-kind",
  );
  check(
    "an extra file may be video, image or audio",
    ["clip.mp4", "logo.png", "bed.mp3"].every((f) => plan({ purpose: "asset", filename: f, bytes: 10, projectId: "p" }).ok),
  );
  check(
    "but not a font, which has its own folder and its own measurement",
    refusalOf({ purpose: "asset", filename: "Brand.otf", bytes: 10, projectId: "p" })?.reason === "wrong-kind",
  );
  check(
    "a reference is a video",
    refusalOf({ purpose: "reference", filename: "mood.png", bytes: 10, projectId: "p" })?.reason === "wrong-kind",
  );
  /*
    Narrower than "an image" on purpose. The key this purpose mints is the
    fixed name `thumb.jpg`, and an object called that holding a WebP is a file
    whose name lies about it — to the dashboard, to the browser and to anyone
    reading a bucket listing. The only caller encodes the frame itself.
  */
  check(
    "a poster frame is a JPEG and nothing else",
    refusalOf({ purpose: "thumbnail", filename: "thumb.png", bytes: 10, projectId: "p" })?.reason === "wrong-kind",
  );
  check(
    "a font is a font",
    refusalOf({ purpose: "font", filename: "not-a-font.mp4", bytes: 10 })?.reason === "wrong-kind",
  );
  check(
    "and the sentence for a font says which extensions are fonts",
    /\.ttf, \.otf or \.ttc/.test(refusalOf({ purpose: "font", filename: "cover.png", bytes: 10 })?.message ?? ""),
    refusalOf({ purpose: "font", filename: "cover.png", bytes: 10 })?.message,
  );
  /*
    A PDF is not "the wrong kind for this purpose", it is a thing this product
    has no shelf for at all, and the two sentences are different on purpose:
    one tells you to bring a font, the other tells you what the product can
    hold. Falling back to a default type here would upload a PDF as a video
    and fail much further along, where the message would be about a filter
    graph.
  */
  check(
    "a file this product has no use for at all gets the wider sentence",
    refusalOf({ purpose: "font", filename: "notes.pdf", bytes: 10 })?.reason === "unknown-type",
  );

  check(
    "a purpose that lives in a project will not proceed without one",
    refusalOf({ purpose: "source", filename: "take.mp4", bytes: 10 })?.reason === "no-project",
  );
  check(
    "and a font, which does not, proceeds without one",
    plan({ purpose: "font", filename: "Brand.ttf", bytes: 10 }).ok,
  );

  // A file still syncing from a cloud drive is zero bytes and looks like a
  // format problem if the type table answers first.
  const empty = refusalOf({ purpose: "asset", filename: "clip.mp4", bytes: 0, projectId: "p" });
  check("an empty file is told it is empty, not that it is the wrong format", empty?.reason === "empty-file", JSON.stringify(empty));
  check("and the sentence says so", /no contents/.test(empty?.message ?? ""), empty?.message);
}

// ── The ceilings ────────────────────────────────────────────────────────────

section("Every ceiling is the smaller of ours and the bucket's");
{
  const overBucket = refusalOf(
    { purpose: "source", filename: "episode.mp4", bytes: 60 * 1024 * 1024, projectId: "p" },
    { ceilingBytes: 50 * 1024 * 1024 },
  );
  check("a file over the bucket's ceiling is refused", overBucket?.reason === "too-large", JSON.stringify(overBucket));
  check("with 413, which is what it is", overBucket?.status === 413, String(overBucket?.status));
  /*
    The number is named here and deliberately not named by the browser's own
    413 handler. The difference is which number is known to be right: this one
    was applied half a line above, while a 413 from Storage is proof that the
    ceiling the page held was not the one being enforced.
  */
  check("and the sentence names the ceiling that was actually applied", /50\.0 MB/.test(overBucket?.message ?? ""), overBucket?.message);

  const reference = refusalOf(
    { purpose: "reference", filename: "whole-episode.mp4", bytes: 26 * 1024 * 1024, projectId: "p" },
    { ceilingBytes: GB },
  );
  check("a reference is held far below the bucket", reference?.reason === "too-large", JSON.stringify(reference));
  check("and told why the cap exists rather than just that it does", /first couple of minutes/.test(reference?.message ?? ""), reference?.message);

  check(
    "a font is held tighter still",
    refusalOf({ purpose: "font", filename: "huge.ttf", bytes: 9 * 1024 * 1024 })?.reason === "too-large",
  );
  check(
    "a poster frame cannot be used to park an arbitrary file in a project",
    refusalOf({ purpose: "thumbnail", filename: "thumb.jpg", bytes: 5 * 1024 * 1024, projectId: "p" })?.reason === "too-large",
  );

  /*
    A ceiling *above* the bucket's is the bug the extra-files panel shipped
    with for months: it promised 512 MB on screen while the bucket stopped at
    50, so a 60 MB logo animation failed with a 400 from Storage and no
    sentence anywhere. The minimum is what makes that unrepresentable.
  */
  const tightBucket = plan(
    { purpose: "reference", filename: "look.mp4", bytes: 1024, projectId: "p" },
    { ceilingBytes: 5 * 1024 * 1024 },
  );
  check(
    "a bucket tighter than our own cap is the one that speaks",
    tightBucket.ok && tightBucket.plan.maxBytes === 5 * 1024 * 1024,
    JSON.stringify(tightBucket),
  );
  const roomyBucket = plan({ purpose: "reference", filename: "look.mp4", bytes: 1024, projectId: "p" });
  check(
    "and our own cap is the one that speaks when the bucket is roomy",
    roomyBucket.ok && roomyBucket.plan.maxBytes === policy.MAX_REFERENCE_BYTES,
    JSON.stringify(roomyBucket),
  );
  check(
    "the ceiling is handed back so the screen can name a real number",
    plan({ purpose: "source", filename: "take.mp4", bytes: 10, projectId: "p" }).plan?.maxBytes === GB,
  );
}

// ── The shelves that can fill up ────────────────────────────────────────────

section("A shelf that is already full is a refusal before the bytes, not after");
{
  const full = refusalOf(
    { purpose: "asset", filename: "logo.png", bytes: 10, projectId: "p" },
    { quota: { used: 60, allowed: 60, noun: "files in a project" } },
  );
  check("a full project refuses the upload", full?.reason === "quota", JSON.stringify(full));
  check("with 409 rather than 400, because nothing about the file is wrong", full?.status === 409, String(full?.status));
  check("and the sentence says what to do about it", /Remove one to add another/.test(full?.message ?? ""), full?.message);
  check(
    "one place left is one upload allowed",
    plan({ purpose: "asset", filename: "logo.png", bytes: 10, projectId: "p" }, { quota: { used: 59, allowed: 60, noun: "files in a project" } }).ok,
  );

  /*
    Both of these limits already existed and both were enforced at the moment
    the finished object was registered — which is to say after somebody had
    waited for the bytes to go up. The answer is the same; the waiting is not.
  */
  const registration = read("artifacts/api-server/src/routes/assets.ts");
  check(
    "and the number is the one the registration endpoint enforces",
    /export const MAX_ASSETS_PER_PROJECT = 60;/.test(registration),
    "if these drift, an upload is authorised and then refused",
  );
  check(
    "read from there rather than restated in the upload route",
    /import \{ MAX_ASSETS_PER_PROJECT \} from "\.\/assets";/.test(read("artifacts/api-server/src/routes/uploads.ts")),
  );
  check(
    "and the same for fonts",
    /export const MAX_FACES = 24;/.test(read("artifacts/api-server/src/routes/fonts.ts")) &&
      /import \{ MAX_FACES \} from "\.\/fonts";/.test(read("artifacts/api-server/src/routes/uploads.ts")),
  );
}

// ── A refusal is two audiences ──────────────────────────────────────────────

section("Every refusal carries a reason for the log and a sentence for the screen");
{
  const everyRefusal = [
    { purpose: "source", filename: "take.mp4", bytes: 10 },
    { purpose: "asset", filename: "notes.pdf", bytes: 10, projectId: "p" },
    { purpose: "asset", filename: "clip.mp4", bytes: 0, projectId: "p" },
    { purpose: "font", filename: "clip.mp4", bytes: 10 },
    { purpose: "font", filename: "huge.ttf", bytes: 9 * 1024 * 1024 },
    { purpose: "source", filename: "take.mp4", bytes: 10, projectId: "../nope" },
  ].map((request) => refusalOf(request));

  check("all six of those are refusals", everyRefusal.every(Boolean), JSON.stringify(everyRefusal));
  check("each carries a code a month of them could be counted by", everyRefusal.every((r) => typeof r.reason === "string" && r.reason.length > 0));
  check("each carries a status", everyRefusal.every((r) => [400, 409, 413].includes(r.status)));
  check(
    "each sentence is a sentence, not a status code",
    everyRefusal.every((r) => /[a-z]{3}/.test(r.message) && /[.!]$/.test(r.message.trim()) && !/\b4\d\d\b/.test(r.message)),
    JSON.stringify(everyRefusal.map((r) => r.message)),
  );
  check(
    "and no refusal quotes a storage key back at the person",
    everyRefusal.every((r) => !r.message.includes("user-1/")),
  );
}

// ── The two numbers that live on both sides ─────────────────────────────────

section("The caps the browser states are the caps the server enforces");
{
  /*
    The browser refuses an over-size reference before the network is touched,
    which is a courtesy rather than the enforcement, and to do it politely it
    has to hold the number. That is two copies of a constant, which this
    repository normally refuses. This is what makes it safe: if they drift, a
    person is either refused a file that would have worked or told a number
    that is not the one being applied.
  */
  const browser = read("artifacts/editly/src/lib/video-storage.ts");
  const numberIn = (source, name) => {
    const match = source.match(new RegExp(`export const ${name}[^=]*=\\s*(\\d+)\\s*\\*\\s*1024\\s*\\*\\s*1024`));
    return match ? Number(match[1]) * 1024 * 1024 : null;
  };
  check(
    "the reference cap is the same number on both sides",
    numberIn(browser, "MAX_REFERENCE_BYTES") === policy.MAX_REFERENCE_BYTES,
    `${numberIn(browser, "MAX_REFERENCE_BYTES")} vs ${policy.MAX_REFERENCE_BYTES}`,
  );
  check(
    "and so is the font cap",
    numberIn(browser, "MAX_FONT_BYTES") === policy.MAX_FONT_BYTES,
    `${numberIn(browser, "MAX_FONT_BYTES")} vs ${policy.MAX_FONT_BYTES}`,
  );
}

// ── The wiring, read rather than run ────────────────────────────────────────

section("The route checks before it signs, and says so out loud when it refuses");
{
  const route = read("artifacts/api-server/src/routes/uploads.ts");

  check("there is a route to read", route.length > 500, String(route.length));
  check("it is the one the spec documents", /router\.post\("\/uploads"/.test(route));
  check(
    "it is rate limited, because it is the path that mints signed storage URLs",
    /rateLimit\(LIMITS\.write\)/.test(route),
  );
  check(
    "the user id comes from the verified token and not from the body",
    /currentUserId\(req\)/.test(route) && !/body\.data\.userId/.test(route),
  );

  const at = (needle) => route.indexOf(needle);
  check("ownership is checked", at("ownsProject(userId, projectId)") > 0);
  check(
    "before the decision is made",
    at("ownsProject(userId, projectId)") < at("planUpload("),
    "a decision taken on somebody else's project is a decision taken too late",
  );
  check(
    "and the decision is made before anything is signed",
    at("planUpload(") < at("signedPut("),
    "this is the whole point of the endpoint",
  );
  check(
    "a refusal is logged",
    at("refused an upload") > 0 && at("refused an upload") < at("signedPut("),
  );
  check(
    "with its reason rather than its sentence, so a month of them can be counted",
    /reason: decision\.refusal\.reason/.test(route),
  );
  check(
    "and a project that is not this person's is a 404, not a 403",
    /res\.status\(404\)\.json\(\{ error: "Project not found\." \}\)/.test(route),
    "whether an id exists is not a thing to learn from a status code",
  );
  check(
    "storage that will not sign is a 503 and a loud line, not a 400",
    /status\(503\)/.test(route) && /logger\.error/.test(route),
    "a person told their file is the problem will spend the afternoon trying smaller ones",
  );
  check(
    "the upload replaces what was there rather than failing on a second take",
    /upsert: true/.test(route),
  );
}

section("The endpoint is behind the auth middleware, like every other per-user route");
{
  const mounted = read("artifacts/api-server/src/routes/index.ts");
  check("it is mounted at all", /uploadsRouter/.test(mounted));
  check(
    "and below requireAuth",
    mounted.indexOf("router.use(requireAuth)") < mounted.indexOf("router.use(uploadsRouter)"),
    "a route mounted above it would mint upload URLs for anyone at all",
  );
}

section("The browser no longer spells a storage path");
{
  const browser = read("artifacts/editly/src/lib/video-storage.ts");
  /*
    Every function in here that actually sends bytes, found rather than listed.

    Recognised by taking an access token, which is what separates the five
    uploaders from `uploadCeiling` — a pure function about a number that also
    happens to start with the word.
  */
  const uploaders = [...browser.matchAll(/^export (?:async )?function (upload[A-Za-z]+)\(([\s\S]{0,400}?)\)/gm)]
    .filter((m) => m[2].includes("accessToken"))
    .map((m) => m[1]);
  check("the uploaders were found", uploaders.length >= 5, JSON.stringify(uploaders));

  const asked = (browser.match(/requestTicket\(\{/g) ?? []).length;
  check(
    "every one of them asks the API where the file may go",
    asked === uploaders.length,
    `${uploaders.length} uploaders, ${asked} tickets`,
  );
  check("and the ticket comes from our own API", /fetch\("\/api\/uploads"/.test(browser));
  check(
    "no upload builds a bucket URL of its own any more",
    !/storage\/v1\/object\/\$\{/.test(browser) && !/`\$\{import\.meta\.env\.VITE_SUPABASE_URL\}\/storage\/v1\/object/.test(browser),
    "a browser that can spell its own key is a browser whose refusals come from Storage",
  );
  check(
    "the transfer to perform is the ticket's answer rather than a size compared here",
    /ticket\.transfer/.test(browser) && !/RESUMABLE_THRESHOLD/.test(browser),
  );
  check(
    "and the path reported back is the one the server chose",
    /return ticket\.path;/.test(browser),
  );
  check(
    "a refusal from our API is shown as the sentence it came with",
    /failure\.error \?\?/.test(browser),
    "a status code is not an answer somebody can act on",
  );
}

await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("Nothing is signed before it has been checked, and nothing is refused in silence.");
