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
 * ## And the other kind of refusal, which goes stale instead of being wrong
 *
 * The product also refuses *edits*: `NOT_YET` in `plan-from-text.ts` and every
 * unconditional `cannotYet` beside it. Those sentences are the most honest
 * thing in this product, and they are written by hand, which means they stop
 * being true on the day somebody builds what they refuse and nothing anywhere
 * notices.
 *
 * That failure is the quietest one available. It does not throw, it is not
 * logged, nobody reports it, because whoever read it believed it and left. A
 * feature the product denies having is a feature that does not exist, and it
 * had already happened once: the posting refusal was still saying the app
 * could not send anywhere, weeks after four working uploaders shipped.
 *
 * The second half of this file is the guard. It runs the real matcher, reads
 * back every product-level refusal it can produce, and holds each one against
 * a fact read out of the tree. A refusal whose subject has been built goes red
 * here, and so does a *new* refusal nobody registered, because a limit worth
 * telling a customer about is a limit worth writing down how we would know it
 * had ended.
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
const { planFromText } = await load("artifacts/api-server/src/lib/plan-from-text.ts", "plan-from-text");

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

// ── What the product says it cannot do ──────────────────────────────────────
/*
  The audit, and the trick that makes it possible.

  There are two kinds of `cannotYet`, and only one of them can go stale. Some
  are about the *project* — "no clips to cut to", "no audio file", "I do not
  know the words" — and those are permanently true of a project in that state.
  The rest are about the *product*, and every one of them is a promise that
  expires the moment somebody builds the thing.

  Telling them apart without parsing the source: run the matcher twice, once
  with an empty library and once with a full one. Everything that survives a
  full library is a product limit. That is measured rather than asserted, below,
  so the separation cannot quietly stop working.
*/
section("Every limit the product admits to is one it still has");

const FULL_LIBRARY = [
  { id: "v1", kind: "video", label: "b-roll" },
  { id: "i1", kind: "image", label: "logo" },
  { id: "a1", kind: "audio", label: "track" },
];

const refusalsFor = (asked, assets = FULL_LIBRARY) =>
  (planFromText(asked, { assets }).cannotYet ?? []).map((p) => p.en);

/*
  What is true in the tree right now, read rather than remembered.

  Each of these is the fact that would make one of the refusals below a lie, so
  reading it here is the whole mechanism: the suite does not know what is built,
  it asks.
*/
const publisherSource = readFileSync(path.join(repoRoot, "artifacts/worker/src/publisher.ts"), "utf8");
const contractSource = readFileSync(path.join(repoRoot, "lib/api-zod/src/index.ts"), "utf8");

/*
  Read out of the map itself rather than from a name.

  `UPLOADERS` is keyed by platform, one entry per destination that has a real
  sender behind it, so its keys are the answer to "what can this product
  actually post to" without anybody maintaining a second list here. A rename of
  the map is caught by the check below that this scan found anything at all,
  which is the failure mode of every regex over source: it finds nothing,
  reports zero, and zero looks like an answer.
*/
const uploaderBlock = publisherSource.match(/UPLOADERS[^=]*=\s*\{([\s\S]*?)\n\};/)?.[1] ?? "";
const canSendTo = [...uploaderBlock.matchAll(/^\s{2}([a-z]+): \{([^}]*)\}/gm)]
  /*
    Minus the entries that are in the table to *name a refusal* rather than to
    send. Snapchat is one: there is no API in the shape the other five have, so
    `publishToSnapchat` refuses with the reason, and it sits in the map only so
    that the refusal is specific rather than the generic "cannot send to this
    yet" a platform nobody has looked at would get.

    Without this distinction the two commits that landed together disagreed:
    one added a named refusal to the map, the other required the product's own
    posting sentence to claim every key in it as working. That is the check
    demanding the product lie.
  */
  .filter((m) => !/sends:\s*false/.test(m[2]))
  .map((m) => m[1]);

const builtOperations = [...contractSource.matchAll(/type:\s*z\.literal\("([a-zA-Z]+)"\)/g)].map((m) => m[1]);
const namedLooks = (contractSource.match(/GradeLook\s*=\s*z\.enum\(\[([^\]]*)\]\)/)?.[1] ?? "")
  .split(",")
  .map((entry) => entry.replace(/["'\s]/g, ""))
  .filter((look) => look && look !== "none");

/**
 * Every product-level refusal, and how we would find out it had expired.
 *
 * `says` is a fragment of the English sentence, so a rewrite that keeps the
 * meaning does not fail this file and a rewrite that changes the subject does.
 * `witness` throws nothing and returns a list of complaints; an empty list
 * means the limit is still real.
 */
const LIMITS = [
  {
    id: "colour-grade",
    asked: "colour grade it like Wes Anderson",
    says: "grade the colour to a look I do not have yet",
    witness: (sentence) => {
      /*
        Five named looks exist and a reference video can be matched, so the
        refusal is only honest while it points at both. A refusal that named
        none of them would be denying a feature that shipped.
      */
      const missing = namedLooks.filter((look) => {
        const word = { mono: "black and white", punch: "punchy" }[look] ?? look;
        return !sentence.toLowerCase().includes(word);
      });
      return missing.length === 0 ? [] : [`does not point at the looks that exist: ${missing.join(", ")}`];
    },
  },
  {
    id: "posting",
    asked: "post it to tiktok for me",
    says: "post it to your accounts yet",
    witness: (sentence) => {
      const said = [];
      /*
        The one that had already gone stale. Four uploaders are built and
        tested; the wall is each platform's review. A sentence that says only
        "I cannot" describes the product as smaller than it is, and one that
        promises posting when `CAN_SEND` is empty describes it as larger.
      */
      if (canSendTo.length === 0) {
        if (/uploader|the sending is built/i.test(sentence)) said.push("claims uploaders that CAN_SEND does not have");
        return said;
      }
      if (!/approval|approve|review/i.test(sentence)) {
        said.push("does not say the wall is approval rather than code");
      }
      const unnamed = canSendTo.filter((platform) => !sentence.toLowerCase().includes(platform.replace("facebook", "facebook")));
      if (unnamed.length > 0) said.push(`does not name the platforms it can already send to: ${unnamed.join(", ")}`);
      return said;
    },
  },
  {
    id: "translation",
    asked: "translate the captions into english",
    says: "put it into another language yet",
    witness: () =>
      builtOperations.some((op) => /translat|subtitleLanguage|dub/i.test(op))
        ? ["the contract has a translation operation now, so this refusal is a lie"]
        : [],
  },
  {
    id: "emoji-choice",
    asked: "put some emojis on it",
    says: "pick emojis for you",
    /*
      A deliberate limit, not a gap. It is registered so that nobody builds an
      emoji picker because they read this line and thought it was a hole, and
      so that nobody deletes the line thinking it is one.
    */
    witness: () => [],
  },
  {
    id: "title-without-words",
    asked: "add a title on the front",
    says: "animate a title yet",
    /* Also deliberate: this product does not write words onto somebody's video. */
    witness: () => [],
  },
  {
    id: "moment-only",
    asked: "at 0:12 make it brighter",
    says: "do something only at",
    /*
      Heard and not done, and said so. Not a gap either: every operation except
      the zoom punch applies to the whole video by construction.
    */
    witness: () => [],
  },
];

{
  check("the matcher is loaded and answering", typeof planFromText === "function");
  /*
    The scan found something. A regex over source that matches nothing returns
    an empty list, and an empty list is a perfectly plausible answer to "what
    can this send to" — so a rename would silently turn this whole section into
    a check that the product cannot post anywhere, and pass.
  */
  check(
    "and the publisher's uploader map was actually read",
    canSendTo.length > 0,
    "UPLOADERS was not found in publisher.ts, so everything about posting below is measuring nothing",
  );
  check(
    "and so was the contract's operation list",
    builtOperations.length > 10 && namedLooks.length > 0,
    `${builtOperations.length} operations, ${namedLooks.length} looks`,
  );

  /*
    First the separation itself, measured. With no library, three project-level
    refusals appear that a full library removes; if that ever stops being true
    the corpus below stops isolating product limits and every check under it
    would be measuring the wrong set.
  */
  const emptyLibrary = refusalsFor("add b-roll and music and put my logo on it", []);
  const fullLibrary = refusalsFor("add b-roll and music and put my logo on it");
  check(
    "an empty project refuses things a full one does not",
    emptyLibrary.length >= 3 && fullLibrary.length === 0,
    `${emptyLibrary.length} with nothing, ${fullLibrary.length} with everything`,
  );

  for (const limit of LIMITS) {
    const said = refusalsFor(limit.asked);
    const matched = said.find((sentence) => sentence.includes(limit.says));
    check(
      `${limit.id}: still refused, so the entry is not describing a limit that was removed`,
      Boolean(matched),
      said.join(" | ") || "nothing was refused",
    );
    if (!matched) continue;

    const complaints = limit.witness(matched);
    check(
      `${limit.id}: and the sentence is still true of the tree`,
      complaints.length === 0,
      complaints.join("; "),
    );
  }

  /*
    And the half that keeps working after everyone forgets this file.

    Anything the matcher can refuse at product level and nobody registered is
    red, named, with the sentence in the failure. A new limit is a new promise
    to a customer, and a promise with no expiry condition written down is
    exactly the one that outlives its truth.
  */
  const corpus = [
    ...LIMITS.map((l) => l.asked),
    "make it black and white and cut the silence",
    "post this to instagram tonight",
    "grade it like a film and add captions",
    "translate it and make it vertical",
    "at 1:30 punch in and at 2:00 do something clever",
    "add sound effects on the cuts",
    "tighten it up and put a watermark on it",
  ];
  const seen = new Set();
  for (const asked of corpus) for (const sentence of refusalsFor(asked)) seen.add(sentence);

  const unregistered = [...seen].filter((sentence) => !LIMITS.some((l) => sentence.includes(l.says)));
  check(
    "every refusal the product can produce is one this file knows how to expire",
    unregistered.length === 0,
    unregistered.map((s) => `"${s.slice(0, 70)}…" is not in LIMITS`).join(" | "),
  );
  check("and the corpus actually reached them", seen.size >= LIMITS.length, `${seen.size} distinct refusals`);

  /*
    Both languages, because a refusal is the sentence a customer is most likely
    to read carefully and the Arabic half is where a rewrite gets forgotten.
  */
  const bothLanguages = LIMITS.every((limit) => {
    const pair = planFromText(limit.asked, { assets: FULL_LIBRARY }).cannotYet.find((p) => p.en.includes(limit.says));
    return pair && /[\u0600-\u06FF]/.test(pair.ar) && pair.ar.length > 20;
  });
  check("and every one of them exists in Arabic as well as English", bothLanguages);
}

await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("A refusal says what was actually refused.");
