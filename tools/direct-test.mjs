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
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { order } from "./lib/order.mjs";

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
  spoke: { platform: false, captions: false, silence: false, music: false, coverage: false, sfx: false },
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

section("A cold open is the best seam in the edit, and now gets the transition");
{
  /*
    This section used to assert the opposite, and the reason it did is gone.

    A cold open reorders the timeline, and the renderer gave every piece its own
    decoder to overlap a join — so a speech clip with the silences removed, which
    is always more pieces than a 1080p source could pay for, had the dissolve
    dropped and the cuts left hard. Promising it here made the reply say "joined
    the cuts" while the render said they did not, so the director withheld it.

    The renderer now opens one stream per *side* of a join rather than one per
    piece, and the sides of a cold open's seam are two whatever the edit is
    chopped into. And that seam is the best candidate in the whole edit: it is
    the one place the recording deliberately jumps somewhere else, which is
    exactly what `where: "scenes"` selects for. Withholding the transition from
    the edit that most deserves it was a workaround, and workarounds outlive
    their reasons unless something says so out loud.
  */
  const withHook = of({ reading: { peaks: [], hook: { at: 30 }, chapters: 2, how: "model" } });
  check("the cold open is decided", types(withHook).includes("coldOpen"));
  check(
    "and the transition is offered on top of it",
    types(withHook).includes("transition"),
    JSON.stringify(types(withHook)),
  );
  const hookPlan = withHook.operations.find((op) => op.type === "transition");
  check(
    "at the seams where the recording jumps, rather than at every cut",
    hookPlan?.where === "scenes",
    JSON.stringify(hookPlan),
  );
  /*
    And the promise says which, because the difference is visible in the file.
    Somebody told "joined the cuts" who then counts four dissolves in a
    thirty-cut edit has been misled by the sentence rather than by the render.
  */
  check(
    "and the reply says where they will be, not that every cut gets one",
    withHook.willDo.some((p) => /where the recording jumps rather than at every cut/.test(p.en)),
    JSON.stringify(withHook.willDo.map((p) => p.en)),
  );
  // The in-order edit — no hook to open on — still gets its dissolve.
  const inOrder = of();
  check(
    "an in-order edit that cuts still gets its transition",
    types(inOrder).includes("transition"),
    JSON.stringify(types(inOrder)),
  );
  // And so does one where the person named the cold open themselves.
  const spokenHook = of({ spokenTypes: new Set(["coldOpen"]) });
  check(
    "a spoken cold open gets one too",
    types(spokenHook).includes("transition"),
    JSON.stringify(types(spokenHook)),
  );
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

/*
  And the cut the *sentence* made counts as a cut.

  `add` refuses to append an operation the person already asked for, because
  the sentence is never overridden. So «اقصّ الصمت وخليها عمودية» leaves
  `removeSilence` in `spokenTypes` and nothing in the director's own
  `operations` — and `cutsSoFar` read only the latter. The result: the person
  who was most explicit about wanting a cut was the one the director decided
  had cut nothing, so no transition on the joins, no second shot size, no sound
  on the cut. Nothing failed. The edit was just plainer for having been asked
  for clearly, and there was no way to see it from the outside.

  Checked against all three cutting operations rather than the one that was
  found, and with the plain case beside it, because a `cutsSoFar` that simply
  returned true would pass the first three lines and break the fourth.
*/
{
  /*
    Both of the director's own cutting operations named in the sentence, which
    is «اقصّ الصمت واحذف التردد» — an ordinary thing to ask for. One of them
    spoken is not enough to show this: the director still adds the other, and
    the answer comes out right for the wrong reason.
  */
  const asked = of({ spokenTypes: new Set(["removeSilence", "tighten"]) });
  for (const on of ["transition", "alternateFraming", "soundEffects"]) {
    check(
      `a cut the person asked for is still a cut: ${on}`,
      types(asked).includes(on),
      JSON.stringify(types(asked)),
    );
  }
  check(
    "and the extracted highlight counts the same way",
    types(of({ spokenTypes: new Set(["removeSilence", "tighten", "extractHighlight"]) })).includes("transition"),
  );
  check(
    "while a video nobody cut still gets none",
    !types(of({ hasSpeech: false, sourceSeconds: 300, spokenTypes: new Set(["addMusic"]) })).includes("transition"),
  );
}

section("A refusal is a decision, on every subject and not just the ones somebody remembered");
{
  /*
   * Auto-direction exists to fill in what the sentence did not mention, and it
   * decides that by asking `spoke`. Two of its rules never asked.
   *
   * `alternateFraming` went onto anything over a minute with cuts in it, and
   * quiet `soundEffects` onto any vertical with cuts — regardless of whether
   * the person had just said "keep the framing" or "no sound effects". Both
   * refusals parse in `plan-from-text`, both correctly produce no operation,
   * and both were then overruled here. The framing is the sentence people are
   * most firm about: somebody who composed a shot says so once and expects it
   * to hold.
   *
   * The cause was that the shape of `spoke` was typed out in three files and
   * only the parser filled it in, so a subject could be added in one place and
   * never reach the two layers whose whole job is to be silenced by it. It is
   * one exported type now, which makes adding a subject a type error until it
   * is handled everywhere.
   */
  const long = { sourceSeconds: 180, hasSpeech: true, platform: "tiktok" };

  const free = types(of(long));
  check("with nothing said, a long vertical gets both", free.includes("alternateFraming") && free.includes("soundEffects"), free.join(", "));

  const noCoverage = types(of({ ...long, spoke: { ...base.spoke, coverage: true } }));
  check("but a sentence about the framing keeps its framing", !noCoverage.includes("alternateFraming"), noCoverage.join(", "));
  check("and that says nothing about the effects", noCoverage.includes("soundEffects"), noCoverage.join(", "));

  const noSfx = types(of({ ...long, spoke: { ...base.spoke, sfx: true } }));
  check("a sentence about sound effects gets none", !noSfx.includes("soundEffects"), noSfx.join(", "));
  check("and keeps its coverage", noSfx.includes("alternateFraming"), noSfx.join(", "));

  const neither = types(of({ ...long, spoke: { ...base.spoke, coverage: true, sfx: true } }));
  check("and both refused is both honoured", !neither.includes("alternateFraming") && !neither.includes("soundEffects"), neither.join(", "));
}

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
{
  // Was `indexOf(a) < indexOf(b)`, true when `a` is absent.
  const first = order(route, "const decided = wantsAnEdit", "applyHabits(");
  check("before the habits, so a habit can still style what it added", first.ok, first.why);
}
check("and everything it decided is said in the reply", /for \(const said of decided\.willDo\) intent\.willDo\.push\(said\);/.test(route));
// The comprehension step is best-effort in the worker, and this is the same
// position on the other side: migration 0038 was written before it was applied,
// and for a while the table did not exist in production at all.
check("a project with no reading gets a smaller direction, not an error", /async function readingFor[\s\S]{0,1400}catch \{\s*return null;/.test(route));
// Only the timings. A decision made from a model's prose is a different and
// much less defensible thing to build an edit out of.
check("and only the timings are read from it", !/claims|chapters: comprehensionsTable\.chapters[\s\S]{0,80}title/.test(route.slice(route.indexOf("async function readingFor"))));

section("The first message on a new project is not the last word on it");
{
  /*
    A loop that could not open.

    A reading exists only after a transcript. A transcript is bought only when
    the plan asks for captions, a highlight, clips or chosen punches. And the
    direction asked for none of those without a reading — `hasSpeech` was
    `reading !== null`.

    So the first "make it nice" on a new project produced three operations, no
    transcript was bought, no reading was written, and the second message
    produced the same three. And the tenth. The product could not improve on
    its own material, ever, and nothing failed: three operations is a valid
    edit and every note about it was true.

    Measured through `direct` itself, because the gap is the whole point:
  */
  const blind = of({ hasSpeech: false });
  const hearing = of({ hasSpeech: true });
  check(
    "the old answer was three operations and a fade",
    types(blind).join(",") === "formatForPlatform,normalizeLoudness,fade",
    JSON.stringify(types(blind)),
  );
  check(
    "and everything this product is for was on the other side of it",
    ["removeSilence", "tighten", "autoCaptions", "alternateFraming", "transition"].every((op) =>
      types(hearing).includes(op),
    ),
    JSON.stringify(types(hearing)),
  );

  /*
    The API has no ears — it never opens the file — so "have we already heard
    speech" is not the question it can answer. "Could there be any", on a video
    somebody uploaded in order to have it edited, is yes; a reading is proof of
    it rather than the source of it.

    What makes that safe is the worker, which does have ears: `enrich.ts`
    listens for a second before it buys a transcript, and a clip with nothing
    on its sound track loses the speech-dependent operations with a sentence
    saying why. Both halves are asserted, because either one alone is a bug —
    optimism without the listener spends a customer's money on silence, and the
    listener without optimism guards a door nobody walks through.
  */
  check(
    "so the route stops making a transcript the price of asking for one",
    /hasSpeech: true,/.test(route) && !/hasSpeech: reading !== null/.test(route),
    "hasSpeech was the reading, and the reading needed the plan that hasSpeech gated",
  );
  const enrich = await read("artifacts/worker/src/enrich.ts");
  check(
    "and the worker listens before it buys a transcript",
    /loudestSample\(mediaPath\)/.test(enrich) && /SILENT_PEAK_DBFS/.test(enrich),
    "the optimistic plan reaches a transcriber; something has to hear the silence first",
  );
  check(
    "and says which kind of quiet it found, because they are different faults",
    /no sound track at all/.test(enrich) && /nothing recorded onto it/.test(enrich),
    "a missing track is an export mistake; an empty one is a muted microphone",
  );
}

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

section("The voice curve is never applied over a music bed");
{
  /*
   * `normalizeLoudness.voice` is an 80 Hz high pass on the speech leg. With
   * music in the mix that filter used to reach the bed and strip its bottom
   * octave — the kick drum, which is the part somebody chose that track for.
   * The comment in `ffmpeg.ts` records the bug.
   *
   * The matcher had a guard for it, run at the end of `planFromText`. The
   * direction had none, and the direction is the half of the plan that lays a
   * bed on its own the moment a project has a track in it. So the two
   * operations that must not meet were produced together, by the same
   * function, on the ordinary path.
   */
  const withTrack = { assets: [{ id: "t1", kind: "audio", label: "song.mp3" }] };
  const built = of(withTrack);
  const bed = built.operations.find((op) => op.type === "addMusic");
  const level = built.operations.find((op) => op.type === "normalizeLoudness");
  check("the direction lays a bed and levels in one plan", Boolean(bed) && Boolean(level));
  check(
    "and asks for the voice curve while it does, which is the shape of the bug",
    level?.voice === true,
    JSON.stringify(level),
  );

  // The rule, applied to the plan that is about to be rendered rather than to
  // whichever half of it a particular assembler happened to build.
  text.levelAgainstTheBed(built.operations);
  check("the rule takes it off once a bed is in the list", level?.voice === false, JSON.stringify(level));

  const spoken = text.planFromText("put my music under it and level the audio").operations;
  const merged = direction.withDirection(spoken, of(withTrack).operations);
  text.levelAgainstTheBed(merged);
  const mergedLevel = merged.find((op) => op.type === "normalizeLoudness");
  check(
    "and across the merge, which is where it was getting past the matcher's copy",
    mergedLevel === undefined || mergedLevel.voice === false,
    JSON.stringify(mergedLevel),
  );

  // Somebody talking with no bed still gets it, or this rule would have made
  // every voice recording worse to fix a mix nobody had.
  const talking = of({});
  text.levelAgainstTheBed(talking.operations);
  const talkingLevel = talking.operations.find((op) => op.type === "normalizeLoudness");
  check("speech with no bed keeps the voice curve", talkingLevel?.voice === true, JSON.stringify(talkingLevel));

  /*
   * And the door it is applied at.
   *
   * The rule above is only worth anything if something calls it on the way to
   * a render. `start-render` is where every path meets — the chat, both render
   * buttons, the export, the product ads — so that is where it is called, and
   * this reads the file rather than trusting that it still is.
   */
  const door = readFileSync(path.join(repoRoot, "artifacts/api-server/src/lib/start-render.ts"), "utf8");
  check("start-render applies the rule to what it is about to queue", /levelAgainstTheBed\(/.test(door));
}

section("The look picked in the panel is an act, not an override");
{
  /*
    `withCaptionLook` rides the same seam as `withCaptionFonts` and defers
    the same way: a sentence that named a style keeps it, and the picker only
    fills fields still at their defaults. The table this depends on is that
    no default is reachable by name — checked against the matcher's source
    below, so the day someone adds a bold-white word to CAPTION_STYLE_WORDS
    this section names the assumption that broke.
  */
  const { withCaptionLook } = await import(
    build("artifacts/api-server/src/lib/caption-look.ts", "caption-look.mjs")
  );
  const plan = (op) => ({ version: 1, operations: [op] });
  const captions = EditPlan.parse(plan({ type: "autoCaptions" })).operations[0];

  const styled = withCaptionLook(plan(captions), { style: "creator", animation: "focus", pace: "quick" });
  check(
    "defaults yield to the picker, all three fields",
    styled.operations[0].style === "creator" &&
      styled.operations[0].animation === "focus" &&
      styled.operations[0].pace === "quick",
    JSON.stringify(styled.operations[0]),
  );

  const spoke = EditPlan.parse(
    plan({ type: "autoCaptions", style: "hormozi", animation: "karaoke", pace: "quick" }),
  ).operations[0];
  const kept = withCaptionLook(plan(spoke), { style: "creator", animation: "focus", pace: "normal" });
  check(
    "a sentence that named its look keeps every named field",
    kept.operations[0].style === "hormozi" &&
      kept.operations[0].animation === "karaoke" &&
      kept.operations[0].pace === "quick",
    JSON.stringify(kept.operations[0]),
  );

  const burn = EditPlan.parse(
    plan({ type: "burnCaptions", cues: [{ startMs: 0, endMs: 900, text: "hello there" }] }),
  ).operations[0];
  const burned = withCaptionLook(plan(burn), { style: "label", animation: "none", pace: "quick" });
  check(
    "burnCaptions takes the style and the animation and has no pace to take",
    burned.operations[0].style === "label" &&
      burned.operations[0].animation === "none" &&
      !("pace" in burned.operations[0]),
    JSON.stringify(burned.operations[0]),
  );

  const untouched = withCaptionLook(plan(captions), undefined);
  check("no look leaves the plan byte-for-byte alone", untouched.operations[0] === captions);
  const other = EditPlan.parse(plan({ type: "kenBurns" })).operations[0];
  check(
    "and a non-caption operation is never touched",
    withCaptionLook(plan(other), { style: "creator" }).operations[0] === other,
  );

  // The assumption the whole deferral rests on: no default is nameable.
  const matcher = await read("artifacts/api-server/src/lib/plan-from-text.ts");
  check(
    "no matcher word maps to a caption default",
    !/"bold-white"\]|,\s*"pop"\]|"normal"\]/.test(
      matcher.slice(matcher.indexOf("CAPTION_STYLE_WORDS"), matcher.indexOf("CAPTION_QUICK_WORDS")),
    ),
  );
}

await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("The product decides on an edit, says every decision out loud, and never overrules the person who asked.");
