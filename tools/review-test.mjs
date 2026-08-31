/**
 * The look at the finished file, including the half that is somebody else's server.
 *
 * `review.ts` had two jobs and now has three. The first two are arithmetic — a
 * level, a length, a mean luma — and the third is a vision model being asked
 * whether the opening holds anybody and whether anything is covering anything.
 * That third job brings with it every failure mode this repository keeps
 * finding, so the suite is built around them rather than around the happy path:
 *
 *   **A feature that silently never runs.** No key, a refused request, a
 *   provider having a bad minute — each of those is a review that quietly stops
 *   reviewing while every render still succeeds and every log stays clean.
 *   Here, each of them is a case with an assertion on what the log says.
 *
 *   **A model's prose reaching a customer.** The whole design is that the model
 *   picks from a closed vocabulary and *we* write the sentence, in both
 *   languages. So the free-text field is loaded with a marker and the suite
 *   checks it lands in the warnings and nowhere near the notes.
 *
 *   **The black-picture threshold.** Limited-range video puts black at Y=16,
 *   not 0, so a threshold set below 16 finds nothing ever and looks like a
 *   check. A real black render is encoded here and measured.
 *
 *   **A paid render turned into a failure by its own review.** Every failure
 *   case asserts the file is still delivered.
 *
 * The frames are really cut, out of a file ffmpeg really made. Nothing about
 * the picture is stubbed; only the server is.
 *
 * Usage: node tools/review-test.mjs
 * Requires: ffmpeg. No keys and no network — the one request is intercepted.
 */
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-review-build-"));
const workRoot = await mkdtemp(path.join(tmpdir(), "editly-review-work-"));

function bundle(entry, name) {
  const outfile = path.join(buildDir, name);
  const result = spawnSync(
    require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/worker"] }),
    [
      path.join(repoRoot, entry),
      "--bundle", "--platform=node", "--format=esm", "--target=node22",
      `--outfile=${outfile}`, "--log-level=error",
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0) {
    console.error(`could not bundle ${entry}`);
    process.exit(1);
  }
  return pathToFileURL(outfile).href;
}

const review = await import(bundle("artifacts/worker/src/review.ts", "review.mjs"));
const { framePlan, parseVisionRead, notesFromVision, reviewOutput, HOOK_SECONDS } = review;

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

const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
if (spawnSync(FFMPEG, ["-version"]).status !== 0) {
  console.error("ffmpeg is not on the PATH; this suite cuts real frames out of a real file.");
  process.exit(1);
}

/** A file ffmpeg actually made, so the frames are actually decodable. */
function encode(name, lavfi) {
  const file = path.join(workRoot, name);
  const made = spawnSync(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", lavfi,
    "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast",
    file,
  ]);
  if (made.status !== 0) {
    console.error(`could not encode ${name}: ${String(made.stderr).slice(-400)}`);
    process.exit(1);
  }
  return file;
}

const MOVING = encode("moving.mp4", "testsrc=size=320x240:rate=25:duration=6");
const BLACK = encode("black.mp4", "color=c=black:size=320x240:rate=25:duration=6");

/** The answer a well-behaved model gives, in the envelope the API puts it in. */
const answer = (body) => ({
  candidates: [{ content: { parts: [{ text: JSON.stringify(body) }] } }],
});

/** A stub server that records what it was asked and says what it was told to. */
function server(reply) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return reply();
  };
  return { calls, impl };
}

const baseContext = (extra = {}) => ({
  operations: [],
  sourcePath: MOVING,
  sourceHadAudio: false,
  expectedAudio: false,
  expectedSeconds: null,
  workDir: workRoot,
  ...extra,
});

// ── The plan ────────────────────────────────────────────────────────────────

section("Which moments of a render get looked at");
{
  const plan = framePlan(60);
  check("a minute of video is sampled", plan.length >= 6, JSON.stringify(plan));
  check(
    `the opening ${HOOK_SECONDS} seconds are sampled in their own right`,
    plan.filter((at) => at < HOOK_SECONDS).length >= 3,
    JSON.stringify(plan.filter((at) => at < HOOK_SECONDS)),
  );
  /*
    The opening is not a slice of an even spread; it is the question. An even
    spread across sixty seconds puts its first sample at six seconds, by which
    point whoever was going to leave has left.
  */
  check("and the rest is spread across everything after it", plan.some((at) => at > 30), JSON.stringify(plan));
  check("nothing is sampled at the very first frame", plan.every((at) => at > 0), JSON.stringify(plan));
  check(
    "nor at the very last, where a transition is still finishing",
    plan.every((at) => at < 60),
    JSON.stringify(plan),
  );
  check("the plan is in order", plan.every((at, i) => i === 0 || at > plan[i - 1]));
  check(
    "and never asks for the same instant twice",
    plan.every((at, i) => i === 0 || at - plan[i - 1] >= 0.25),
    JSON.stringify(plan),
  );

  const short = framePlan(2);
  check("a two-second clip still gets frames", short.length >= 2, JSON.stringify(short));
  check("all of them inside it", short.every((at) => at > 0 && at < 2), JSON.stringify(short));

  check("a render of no length asks for nothing", framePlan(0).length === 0);
  check("and neither does an unmeasurable one", framePlan(NaN).length === 0);
}

// ── The answer ──────────────────────────────────────────────────────────────

section("The answer is reduced to things this product knows how to say");
{
  const read = parseVisionRead(
    answer({
      holds: "no",
      because: "a static title card",
      occlusions: [
        { what: "face", by: "captions", atSeconds: 1.5 },
        // The same complaint, seen again two frames later.
        { what: "face", by: "captions", atSeconds: 2.5 },
        // A value outside the vocabulary. The model was given an enum; a schema
        // is a request, not a guarantee, and an unknown key reaching a template
        // is how a customer reads "the undefined is covered by undefined".
        { what: "his left elbow", by: "captions" },
        { what: "screenText", by: "sunglasses" },
        { what: "screenText", by: "watermark", atSeconds: "later" },
      ],
    }),
  );
  check("the verdict survives", read.holds === "no", read.holds);
  check("and the reasoning does, for the log", read.because === "a static title card", read.because);
  check("one complaint per pair, however many frames saw it", read.occlusions.length === 2, JSON.stringify(read.occlusions));
  check(
    "and every pair is one this file can put in a sentence",
    read.occlusions.every((o) => ["face", "mouth", "eyes", "screenText", "subject"].includes(o.what)),
    JSON.stringify(read.occlusions),
  );
  check(
    "a time that is not a number becomes 'we do not know', not a NaN in a log line",
    read.occlusions.find((o) => o.what === "screenText")?.atSeconds === null,
    JSON.stringify(read.occlusions),
  );

  check(
    "a verdict outside the three becomes 'unsure' rather than being repeated back",
    parseVisionRead(answer({ holds: "definitely", because: "", occlusions: [] })).holds === "unsure",
  );
  check(
    "an answer that is not JSON is no answer",
    parseVisionRead({ candidates: [{ content: { parts: [{ text: "sorry, I cannot see the video" }] } }] }) === null,
  );
  check(
    "and neither is an empty one",
    parseVisionRead({ candidates: [{ content: { parts: [{ text: "   " }] } }] }) === null,
  );
  check("and neither is an empty envelope", parseVisionRead({}) === null);
  check("nor a missing one", parseVisionRead(null) === null);
}

// ── The sentences ───────────────────────────────────────────────────────────

section("Every sentence a customer reads is written here, in both languages");
{
  const all = [];
  for (const what of ["face", "mouth", "eyes", "screenText", "subject"]) {
    for (const by of ["captions", "watermark", "overlay", "other"]) {
      const read = { holds: "unsure", because: "", occlusions: [{ what, by, atSeconds: null }] };
      const en = notesFromVision(read, "en");
      const ar = notesFromVision(read, "ar");
      all.push([`${what}/${by}`, en[0], ar[0]]);
    }
  }
  check("every pair the model can return has a sentence", all.every(([, en]) => (en ?? "").length > 20));
  check(
    "and an Arabic one that is not the English one",
    all.every(([, en, ar]) => ar && ar !== en),
    all.filter(([, en, ar]) => !ar || ar === en).map(([k]) => k).join(", "),
  );
  check(
    "the Arabic is Arabic, rather than English with a label on it",
    all.every(([, , ar]) => /[؀-ۿ]/.test(ar)),
    all.filter(([, , ar]) => !/[؀-ۿ]/.test(ar)).map(([k]) => k).join(", "),
  );
  check(
    "and no two pairs produce the same sentence, which would make the vocabulary decorative",
    new Set(all.map(([, en]) => en)).size === all.length,
  );

  /*
    Only "no" is worth telling somebody. "unsure" is the honest answer to a
    question asked of still frames and there is nothing to do with it, and
    "yes" is a compliment nobody needs from their own tooling — a note per
    render saying the opening is fine is a note nobody reads by the third one.
  */
  const bare = { because: "", occlusions: [] };
  check("a weak opening is said out loud", notesFromVision({ ...bare, holds: "no" }, "en").length === 1);
  check("in Arabic too", /[؀-ۿ]/.test(notesFromVision({ ...bare, holds: "no" }, "ar")[0] ?? ""));
  check("an opening it could not judge is not commented on", notesFromVision({ ...bare, holds: "unsure" }, "en").length === 0);
  check("and neither is one that works", notesFromVision({ ...bare, holds: "yes" }, "en").length === 0);
}

// ── The real thing ──────────────────────────────────────────────────────────

section("A real render, really cut into frames and really asked about");
{
  const { calls, impl } = server(() =>
    new Response(
      JSON.stringify(
        answer({
          holds: "no",
          because: "MODEL-PROSE-MARKER: nothing happens in the first second",
          occlusions: [{ what: "mouth", by: "captions", atSeconds: 2 }],
        }),
      ),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );

  const result = await reviewOutput(MOVING, baseContext({ vision: { apiKey: "k", fetchImpl: impl } }));

  check("the model was asked, once", calls.length === 1, String(calls.length));
  const parts = calls[0]?.body?.contents?.[0]?.parts ?? [];
  const stills = parts.filter((p) => p.inlineData?.mimeType === "image/jpeg");
  check(
    "and it was given frames cut out of the file, not a description of them",
    stills.length >= 6,
    `${stills.length} stills in ${parts.length} parts`,
  );
  check(
    "which are real JPEGs",
    stills.every((p) => Buffer.from(p.inlineData.data, "base64").subarray(0, 3).toString("hex") === "ffd8ff"),
  );
  check("as many as the plan asked for", stills.length === framePlan(6).length, `${stills.length} vs ${framePlan(6).length}`);
  check("with the two questions attached", parts.some((p) => typeof p.text === "string" && /holds/.test(p.text)));
  check(
    "and a schema that only lets it answer in our vocabulary",
    JSON.stringify(calls[0].body.generationConfig.responseSchema).includes('"captions"'),
  );

  check("the answer became notes", result.notes.length === 2, JSON.stringify(result.notes));
  check("the read is reported back", result.seen?.holds === "no", JSON.stringify(result.seen));

  /*
    The line this whole design exists for. The model's own sentence is useful
    to whoever is on call and has no business being shown to the person whose
    video it is — unreviewed, unwritten by us, and in the wrong language half
    the time.
  */
  check(
    "the model's own prose is in the log",
    result.warnings.some((w) => w.includes("MODEL-PROSE-MARKER")),
    JSON.stringify(result.warnings),
  );
  check(
    "and nowhere near the customer",
    result.notes.every((n) => !n.includes("MODEL-PROSE-MARKER")),
    JSON.stringify(result.notes),
  );

  const left = (await readdir(workRoot)).filter((f) => f.startsWith("review-frame-"));
  check("and the frames it cut are cleaned up after it", left.length === 0, left.join(", "));
}

// ── The ways it can go wrong ────────────────────────────────────────────────

section("Nothing here can turn a finished render into a failed one");
{
  const cases = [
    ["the provider refuses", () => new Response("no", { status: 429 })],
    ["the provider is broken", () => new Response("<html>", { status: 502 })],
    ["the socket dies", () => { throw new TypeError("fetch failed"); }],
    ["the answer is not the JSON its own schema asked for", () =>
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "I think it's nice" }] } }] }), { status: 200 })],
  ];

  for (const [name, reply] of cases) {
    const { calls, impl } = server(reply);
    let threw = null;
    let result = null;
    try {
      result = await reviewOutput(MOVING, baseContext({ vision: { apiKey: "k", fetchImpl: impl } }));
    } catch (error) {
      threw = error;
    }
    check(`${name}: the review still returns`, threw === null, String(threw));
    check(`${name}: with nothing invented for the customer`, (result?.notes ?? []).length === 0, JSON.stringify(result?.notes));
    check(`${name}: and the look reported as not done`, result?.seen === null, JSON.stringify(result?.seen));
    check(`${name}: it was actually attempted`, calls.length === 1, String(calls.length));
    if (name !== "the answer is not the JSON its own schema asked for") {
      check(`${name}: and the log says why`, (result?.warnings ?? []).length > 0, JSON.stringify(result?.warnings));
    }
    const left = (await readdir(workRoot)).filter((f) => f.startsWith("review-frame-"));
    check(`${name}: no frames left behind`, left.length === 0, left.join(", "));
  }
}

section("A deployment that did not buy this is not nagged about it");
{
  const { calls, impl } = server(() => new Response("{}", { status: 200 }));
  const key = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    const result = await reviewOutput(MOVING, baseContext({ vision: { fetchImpl: impl } }));
    check("no key means no request", calls.length === 0, String(calls.length));
    check("and no note", result.notes.length === 0, JSON.stringify(result.notes));
    /*
      Deliberately not a warning. A deployment with no key has decided not to
      buy this, and a line on every render about a choice somebody made on
      purpose is the noise that teaches people to stop reading the log.
    */
    check("and no complaint about a choice somebody made", result.warnings.length === 0, JSON.stringify(result.warnings));
    check("the look is reported as not done", result.seen === null);
  } finally {
    if (key === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = key;
  }
}

// ── Black ───────────────────────────────────────────────────────────────────

section("A black render is named as black, and not then asked for a second opinion");
{
  /*
    Limited-range video puts black at Y=16, not 0. A threshold set below that
    would find nothing, ever, on any file — and would look exactly like a
    working check, which is the failure this whole repository is organised
    against. So the black here is encoded by ffmpeg the way a real render's
    black would be, and measured.
  */
  const { calls, impl } = server(() => new Response("{}", { status: 200 }));
  const result = await reviewOutput(
    BLACK,
    baseContext({ sourcePath: MOVING, vision: { apiKey: "k", fetchImpl: impl } }),
  );
  check(
    "a black picture out of a bright source is reported",
    result.notes.some((n) => /black/i.test(n)),
    JSON.stringify(result.notes),
  );
  check(
    "and the log carries the two lumas that decided it",
    result.warnings.some((w) => /luma/.test(w)),
    JSON.stringify(result.warnings),
  );
  /*
    And no request. Asking a model whether a black rectangle holds an audience
    spends money to be told what a mean luma of 16 already said, and then adds
    a second, softer note underneath the true one.
  */
  check("nothing is asked about a picture we already know is black", calls.length === 0, String(calls.length));
  check("the look is reported as not done", result.seen === null);
}

await rm(buildDir, { recursive: true, force: true });
await rm(workRoot, { recursive: true, force: true });
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
console.log("The finished file is looked at, and nothing about looking can cost a render.");
