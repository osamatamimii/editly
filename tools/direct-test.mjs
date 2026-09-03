/**
 * The planner was a translator, and the ceiling on this product was the
 * customer's vocabulary.
 *
 * Every line of its instructions said "choose this when they ask for it", and
 * not one said "this is what a good edit of this material looks like — build
 * it". So somebody who knew to type "cut the silences, add captions, punch in
 * on the emphasis, level the audio" got a good edit, and somebody who typed
 * "make this good" got nothing at all and was told so politely. That is the
 * most damning fact about the old planner: the most natural way to ask for the
 * product was the one sentence it could not hear.
 *
 * ## What this file is guarding
 *
 * **That nothing overrides a person.** A direction that adds captions to "no
 * captions on this one" is the failure this whole codebase is written against,
 * wearing its most convincing disguise yet — a memory that changes what
 * somebody gets, for good reasons, silently. Every rule is skipped when the
 * sentence spoke about its subject, and "only" turns the whole thing off.
 *
 * **That nothing is silent.** Every operation added carries the sentence that
 * explains it, and the count of sentences is checked against the count of
 * operations. The rule the file is written under is that a person should be
 * able to read the reply and predict the video.
 *
 * **That it stands down rather than guessing.** No speech, no captions. No
 * reading, no punch-ins. No measured length, nothing that restructures. No
 * habit, no grade — because the product refuses by name to grade to a look it
 * does not have, and inventing one here would be the product contradicting
 * itself inside one request.
 *
 * Usage: node tools/direct-test.mjs
 * Requires: nothing. No keys, no network, no database.
 */
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-direct-"));

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

const direction = await import(build("artifacts/api-server/src/lib/direct.ts", "direct.mjs"));
const {
  direct, withDirection,
  SHORTEST_TO_RESTRUCTURE, LONG_ENOUGH_TO_CLIP, HIGHLIGHT_SECONDS, MAX_PUNCHES, PUNCH_STRENGTH,
} = direction;
const text = await import(build("artifacts/api-server/src/lib/plan-from-text.ts", "text.mjs"));
const { saysOnlyThis, asksForAnEdit, planFromText } = text;
const zod = await import(build("lib/api-zod/src/index.ts", "zod.mjs"));
const { EditPlan, MAX_PLAN_OPERATIONS } = zod;

const read = (file) => readFile(path.join(repoRoot, file), "utf8");

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

const base = {
  platform: "tiktok",
  sourceSeconds: 90,
  hasSpeech: true,
  reading: null,
  assets: [],
  habits: [],
  spokenTypes: new Set(),
  spoke: { platform: false, captions: false, silence: false, music: false },
  onlyWhatWasAsked: false,
};
const of = (over = {}) => direct({ ...base, ...over });
const types = (result) => result.operations.map((op) => op.type);

// The restructure planner lays a bed on its own when a track is present — but
// not when the sentence spoke about music. "no music" names the subject, so it
// is respected here the same way it is when it is asked for.
{
  const withTrack = { assets: [{ id: "t1", kind: "audio", label: "song.mp3" }] };
  check("a restructured clip with a track laid gets a bed", types(of(withTrack)).includes("addMusic"));
  check(
    "but a sentence that spoke about music (a refusal) gets none",
    !types(of({ ...withTrack, spoke: { ...base.spoke, music: true } })).includes("addMusic"),
  );
}

/* ── the sentence the old planner could not hear ─────────────────────────── */

section("The sentence that used to produce nothing at all");

for (const asked of [
  "make this good",
  "edit it",
  "clean it up",
  "just do your thing",
  "whatever you think",
  "عدّله",
  "سوّه حلو",
  "اعمل اللازم",
  "شوف الأفضل",
]) {
  check(`"${asked}" is heard as a request for an edit`, asksForAnEdit(asked) === true);
}
// The gate has to be narrow: the direction starts a render, so a matcher that
// fires on conversation spends somebody's minutes on a message that was not a
// request.
for (const chat of ["hello", "thanks!", "what can you do?", "مرحبا", "شكرًا", "is it done yet"]) {
  check(`"${chat}" is not`, asksForAnEdit(chat) === false);
}
// And the old planner is confirmed to have been silent on it, which is the
// claim this whole point rests on.
check(
  "and the keyword planner produced nothing for it, which is why this exists",
  planFromText("make this good", { defaultPlatform: "tiktok" }).operations.length === 0,
);

section("A whole edit, from a sentence that named nothing");

{
  const made = of();
  check("something is decided", made.operations.length >= 5, types(made).join(", "));
  check("and it is a plan the schema accepts", EditPlan.safeParse({ version: 1, operations: made.operations }).success);
  // The rule the file is written under: a person should be able to read the
  // reply and predict the video.
  check("every operation carries the sentence that explains it", made.willDo.length === made.operations.length);
  check("in both languages", made.willDo.every((p) => p.en && p.ar && /[؀-ۿ]/.test(p.ar)));
  check("and no two operations of one type", new Set(types(made)).size === made.operations.length, types(made).join(", "));
  for (const wanted of ["formatForPlatform", "removeSilence", "tighten", "autoCaptions", "normalizeLoudness", "transition", "fade"]) {
    check(`it decides on ${wanted}`, types(made).includes(wanted));
  }
}

/* ── nothing overrides a person ──────────────────────────────────────────── */

section("Nothing here overrides a person");

// "No captions on this one" is a decision *about* captions. A direction that
// adds them anyway is a memory that silently changes what somebody gets, which
// is the failure this codebase is written against.
check("a sentence that refused captions gets none", !types(of({ spoke: { ...base.spoke, captions: true } })).includes("autoCaptions"));
check("a sentence that spoke about silence gets no silence cut", !types(of({ spoke: { ...base.spoke, silence: true } })).includes("removeSilence"));
check("and none of the tightening that hangs off it", !types(of({ spoke: { ...base.spoke, silence: true } })).includes("tighten"));
check("a sentence that chose a platform is not reframed again", !types(of({ spoke: { ...base.spoke, platform: true } })).includes("formatForPlatform"));
// An operation the sentence already produced is never produced twice: the
// renderer looks operations up with `find`, so a duplicate is silently the
// first one and the person's choice would be the discarded copy.
check(
  "an operation the sentence already made is not made again",
  !types(of({ spokenTypes: new Set(["autoCaptions"]) })).includes("autoCaptions"),
);

section('"Only" means only');

for (const said of [
  "just cut the silences, nothing else",
  "only remove the silence",
  "cut the silences and nothing more",
  "اقطع الصمت وبس",
  "شيل الصمت فقط لا غير",
]) {
  check(`"${said}" turns the direction off`, saysOnlyThis(said) === true);
}
for (const said of ["cut the silences", "add captions and punch in", "اقطع الصمت وأضف كابشنز"]) {
  check(`"${said}" does not`, saysOnlyThis(said) === false);
}
check("and the direction is empty when it is said", of({ onlyWhatWasAsked: true }).operations.length === 0);
check("with nothing in the reply either, because nothing was decided", of({ onlyWhatWasAsked: true }).willDo.length === 0);

/* ── it stands down rather than guessing ─────────────────────────────────── */

section("Every threshold is on the side of doing less");

{
  const silent = of({ hasSpeech: false });
  check("a video nobody speaks in gets no captions", !types(silent).includes("autoCaptions"));
  check("and no silence cut, because that is a cut list of the quiet bars", !types(silent).includes("removeSilence"));
  check("and no tightening", !types(silent).includes("tighten"));
  // Levelling is the one operation with no argument against it: a phone
  // recording is quiet, a room is loud, and a feed plays everything at one
  // volume.
  check("but it is still levelled", types(silent).includes("normalizeLoudness"));
  check("without the voice curve, which on music is a filter on the wrong material",
    silent.operations.find((op) => op.type === "normalizeLoudness")?.voice === false);
}

{
  const tiny = of({ sourceSeconds: SHORTEST_TO_RESTRUCTURE - 1 });
  check("a clip shorter than ten seconds is not restructured", !types(tiny).includes("removeSilence"));
  check("and has nothing to transition between", !types(tiny).includes("transition"));
  check("and is not faded, because it is the shot", !types(tiny).includes("fade"));
  check("but it still gets captions", types(tiny).includes("autoCaptions"));
}

{
  const unknown = of({ sourceSeconds: null });
  check("a length nobody measured stands everything structural down", !types(unknown).includes("removeSilence"));
  check("and still frames and levels, which need no length", types(unknown).includes("formatForPlatform") && types(unknown).includes("normalizeLoudness"));
}

check("no platform means nothing is reframed", !types(of({ platform: null })).includes("formatForPlatform"));

section("Material is not a video");

{
  const podcast = of({ sourceSeconds: LONG_ENOUGH_TO_CLIP + 10 });
  check("a recording longer than the feed takes becomes a highlight", types(podcast).includes("extractHighlight"));
  check("cut to a length every platform accepts", podcast.operations.find((o) => o.type === "extractHighlight")?.targetSeconds === HIGHLIGHT_SECONDS);
  check("and the reason is said, not just done", podcast.willDo.some((p) => /longer than the feed/.test(p.en)));
  const short = of({ sourceSeconds: LONG_ENOUGH_TO_CLIP - 10 });
  check("something the feed would take whole is left whole", !types(short).includes("extractHighlight"));
  // Landscape is where the whole video plays, so taking forty-five seconds out
  // of an hour would be throwing away the thing they uploaded.
  check("and neither is a long recording going somewhere that plays it whole", !types(of({ sourceSeconds: 3600, platform: "youtube" })).includes("extractHighlight"));
}

section("The punch-ins are the part that could not exist before the video was read");

{
  const noReading = of();
  check("no reading, no punch-ins", !types(noReading).includes("zoomPunch"));

  const peaks = [
    { start: 12, strength: 0.9 },
    { start: 40, strength: 0.8 },
    { start: 5, strength: 0.3 },
    ...Array.from({ length: 10 }, (_, i) => ({ start: 50 + i, strength: 0.7 })),
  ];
  const read = of({ reading: { peaks, hook: null, chapters: 3, how: "model" } });
  const punch = read.operations.find((op) => op.type === "zoomPunch");
  check("a reading puts them where attention is held", Boolean(punch));
  check("strongest first, and capped", punch.at.length === MAX_PUNCHES, String(punch.at.length));
  // Six punch-ins in forty-five seconds is an edit; twenty is a nervous tic.
  check("the weak one is not a moment, it is the middle of a sentence", !punch.at.includes(5));
  check("and they come out in time order, whatever order they were ranked in", [...punch.at].sort((a, b) => a - b).join() === punch.at.join());
  check("the threshold is stated rather than hidden", PUNCH_STRENGTH > 0.5 && PUNCH_STRENGTH < 1);

  /*
    The bug this guard exists for: a highlight renumbers every second in the
    video, so a punch at 04:12 of a clip that starts at 04:30 lands nowhere —
    and nothing about that fails. The frame is simply wrong for a second and a
    half, once, in a video somebody paid for.
  */
  const clipped = of({ sourceSeconds: LONG_ENOUGH_TO_CLIP + 10, reading: { peaks, hook: null, chapters: 3, how: "model" } });
  check("no punch-ins when a highlight is about to renumber the timeline", !types(clipped).includes("zoomPunch"));
}

section("The cold open, which is the most designed moment short-form has");

{
  const withHook = of({ reading: { peaks: [], hook: { at: 30 }, chapters: 2, how: "model" } });
  check("a hook in the middle becomes the opening", types(withHook).includes("coldOpen"));
  // Moving four seconds out of the middle has to leave a video behind.
  check("a hook already at the start is left where it is", !types(of({ reading: { peaks: [], hook: { at: 2 }, chapters: 2, how: "model" } })).includes("coldOpen"));
  check("and nothing is lifted out of a video that plays whole", !types(of({ platform: "youtube", reading: { peaks: [], hook: { at: 30 }, chapters: 2, how: "model" } })).includes("coldOpen"));
}

section("What it will not decide on its own");

// The product refuses, by name, to grade to a look it does not have. Inventing
// one here would be the product contradicting itself inside one request.
check("no grade without a habit", !types(of()).includes("grade"));
check("a look chosen twice is applied", types(of({ habits: [{ key: "grade", value: "warm", times: 3, outOf: 4 }] })).includes("grade"));
check("a look chosen once is not", !types(of({ habits: [{ key: "grade", value: "warm", times: 1, outOf: 4 }] })).includes("grade"));
check("and the reply says it is their usual, not our idea", of({ habits: [{ key: "grade", value: "warm", times: 3, outOf: 4 }] }).willDo.some((p) => /usually/.test(p.en)));

// There is no library here and this product will not fetch a track: music laid
// under somebody's video is a licence taken on their behalf.
check("no music without a file they uploaded", !types(of()).includes("addMusic"));
check("and music when there is one", types(of({ assets: [{ id: "a1", kind: "audio", label: "theme" }] })).includes("addMusic"));

// A transition on a video that was never cut is a dissolve from a shot to
// itself: invisible, and a quarter of a second of nothing at the front.
check("no transition where nothing was cut", !types(of({ hasSpeech: false, sourceSeconds: 60 })).includes("transition"));
// Coverage: the one thing every human edit has and this one did not. A single
// camera at a single focal length is what an automatic edit looks like. It
// costs nothing — the wide size is overscan the renderer already crops and
// throws away — so the only reason not to is having nothing to alternate
// between.
check("two shot sizes on something long enough to have cuts", types(of({ sourceSeconds: 90 })).includes("alternateFraming"));
check("and one size on something too short to have several", !types(of({ sourceSeconds: 40 })).includes("alternateFraming"));
check("and none at all on a video that was never cut", !types(of({ hasSpeech: false, sourceSeconds: 300 })).includes("alternateFraming"));
// Sound effects read as production on a feed and as a distraction on a talk.
check("no sound effects on a platform that plays the whole thing", !types(of({ platform: "youtube" })).includes("soundEffects"));
check("and effects on the feeds, under the voice", of({ platform: "tiktok" }).operations.find((o) => o.type === "soundEffects")?.gainDb <= -10);

section("It fits, and the person's plan is still theirs");

{
  const most = of({
    sourceSeconds: 120,
    reading: { peaks: [{ start: 10, strength: 0.9 }], hook: { at: 30 }, chapters: 4, how: "model" },
    assets: [{ id: "a1", kind: "audio", label: "theme" }],
    habits: [{ key: "grade", value: "cinematic", times: 5, outOf: 5 }],
  });
  check("the fullest direction is still a plan the schema accepts", EditPlan.safeParse({ version: 1, operations: most.operations }).success, types(most).join(", "));
  // Twelve was a ceiling on what a person could ask for. It became a ceiling on
  // what the product could decide the day this file existed.
  check("and leaves room for what a person types on top of it", most.operations.length < MAX_PLAN_OPERATIONS, `${most.operations.length} of ${MAX_PLAN_OPERATIONS}`);
  check("the cap is twenty now", MAX_PLAN_OPERATIONS === 20);
}

{
  const spoken = [{ type: "autoCaptions", style: "karaoke-box", animation: "kinetic", dropFillers: true }];
  const merged = withDirection(spoken, of().operations);
  check("what they typed comes first in the plan", merged[0].style === "karaoke-box");
  check("and their caption is the only one", merged.filter((op) => op.type === "autoCaptions").length === 1);
  check("with the rest of the edit underneath", merged.length > spoken.length);
}

section("The number that was in five places is in one");

const zodSource = await read("lib/api-zod/src/index.ts");
check("the cap is declared once", /export const MAX_PLAN_OPERATIONS = 20;/.test(zodSource));
check("and the schema reads it", /\.max\(MAX_PLAN_OPERATIONS\)/.test(zodSource));
for (const file of [
  "artifacts/api-server/src/lib/render-policy.ts",
  "artifacts/api-server/src/lib/planner.ts",
  "artifacts/api-server/src/routes/exports.ts",
]) {
  const src = await read(file);
  check(`${path.basename(file)} reads it rather than repeating it`, /MAX_OPERATIONS = MAX_PLAN_OPERATIONS/.test(src) && !/MAX_OPERATIONS = \d/.test(src));
}
const spec = await read("lib/api-spec/openapi.yaml");
check("and the spec says the same number", /maxItems: 20/.test(spec));

section("It is wired where the sentence arrives");

const route = await read("artifacts/api-server/src/routes/messages.ts");
// A direction that runs on every message spends somebody's minutes because they
// said hello.
check("the direction runs only when an edit was asked for", /const wantsAnEdit = intent\.operations\.length > 0 \|\| asksForAnEdit\(/.test(route));
check("before the habits, so a habit can still style what it added", route.indexOf("const decided = wantsAnEdit") < route.indexOf("applyHabits("));
check("and everything it decided is said in the reply", /for \(const said of decided\.willDo\) intent\.willDo\.push\(said\);/.test(route));
// The comprehension step is best-effort in the worker, and this is the same
// position on the other side: migration 0038 was written before it was applied,
// and for a while the table did not exist in production at all.
check("a project with no reading gets a smaller direction, not an error", /async function readingFor[\s\S]{0,1400}catch \{\s*return null;/.test(route));
// Only the timings. A decision made from a model's prose is a different and
// much less defensible thing to build an edit out of.
check("and only the timings are read from it", !/claims|chapters: comprehensionsTable\.chapters[\s\S]{0,80}title/.test(route.slice(route.indexOf("async function readingFor"))));

section("An elongated Arabic hesitation is heard, not lost to an ASCII word boundary");
{
  // `\bآآ` matched nothing — `\b` needs an ASCII word character before it, and
  // Arabic is not one — so "cut the aaah" produced no edit at all.
  const typesOf = (asked) => planFromText(asked, {}).operations.map((op) => op.type);
  check("'شيل الآآآ' is heard as a hesitation cut", typesOf("شيل الآآآ").includes("tighten"), typesOf("شيل الآآآ").join(","));
  check("and 'احذف الآآ' too", typesOf("احذف الآآ").includes("tighten"), typesOf("احذف الآآ").join(","));
  // The English hesitation words it always caught still work — no regression.
  check("'cut the ums' still lands", typesOf("cut the ums and uhs").includes("tighten"));
  // And a single madda-alef inside an ordinary word is not a hesitation.
  check("an ordinary word with one madda-alef is not read as a hesitation", !typesOf("اقرأ القرآن").includes("tighten"), typesOf("اقرأ القرآن").join(","));
}

await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("The product decides on an edit, says every decision out loud, and never overrules the person who asked.");
