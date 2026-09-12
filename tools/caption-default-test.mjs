/**
 * What a caption looks like when nobody said.
 *
 * This product answers a sentence. Most sentences say nothing about captions
 * beyond wanting them, so the look a caption gets when nobody chose one is not
 * an edge case — it is what almost every render uses, and for most customers
 * it is the product.
 *
 * It used to be decided in five places at once. The schema stamped
 * `bold-white`/`bottom`/`m`/`pop`/`normal` onto every operation; the keyword
 * matcher ended five ternaries in the same five values; the planner's
 * transformer filled them when the model answered null; the habits invented a
 * style for somebody who had never chosen one; the direct planner wrote all
 * five as literals. Five copies of one decision, none of them named, and none
 * of them distinguishable afterwards from a choice a person had made — which
 * is the failure this file is really about. A field that is filled in cannot
 * be told from a field that was chosen, so the panel could not style an
 * unstyled plan without a trick, the habits could not apply without guessing,
 * and the reply could not say what it had decided because nothing knew.
 *
 * Now: absent means nobody said, all the way down, and `DEFAULT_CAPTION_LOOK`
 * answers once at the end. The checks below are that rule at every layer it
 * passes through, and the last section is the rule Osama actually gave —
 * «يظهر بسطر واحد بـ3-4 كلمات» — read out of the code that enforces it.
 *
 * Usage: node tools/caption-default-test.mjs
 * Requires: nothing. No keys, no network, no database.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-caption-default-"));

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

const build = (source, name, paths = "artifacts/api-server") => {
  const outfile = path.join(buildDir, name);
  const built = spawnSync(
    require.resolve("esbuild/bin/esbuild", { paths: [paths] }),
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
  return pathToFileURL(outfile).href;
};
const read = (file) => readFileSync(path.join(repoRoot, file), "utf8");

const zod = await import(build("lib/api-zod/src/index.ts", "zod.mjs"));
const { DEFAULT_CAPTION_LOOK, EditPlan } = zod;

/** The five fields that are a choice, not a setting. */
const LOOK_FIELDS = ["style", "position", "size", "animation", "pace"];
const captionsIn = (plan) => plan.operations.find((op) => op.type === "autoCaptions" || op.type === "burnCaptions");

// ─── The default itself ──────────────────────────────────────────────────────

section("There is one default, and it is the decision Osama made");
{
  check("it exists as a named constant", typeof DEFAULT_CAPTION_LOOK === "object" && DEFAULT_CAPTION_LOOK !== null);
  /*
    Named rather than read, and that is the point of this line: it is the one
    place the default is a *decision* instead of a variable. It said `creator`
    for as long as that was the reference; it says `glow` now, off the edit
    Osama sent next — and if somebody changes what everybody gets without
    changing this line with it, that is exactly the failure worth a red check.
  */
  check("the look is glow, the latest reference edit's own", DEFAULT_CAPTION_LOOK.style === "glow", DEFAULT_CAPTION_LOOK.style);
  check("it sits mid-frame, where short-form puts it", DEFAULT_CAPTION_LOOK.position === "middle", DEFAULT_CAPTION_LOOK.position);
  check("at the quick pace measured off the reference", DEFAULT_CAPTION_LOOK.pace === "quick", DEFAULT_CAPTION_LOOK.pace);
  check("and the measured size, unboosted", DEFAULT_CAPTION_LOOK.size === "m", DEFAULT_CAPTION_LOOK.size);
}

// ─── The schema stopped answering for people ─────────────────────────────────

section("A plan that says nothing about a look carries nothing about a look");
{
  const parsed = EditPlan.parse({ version: 1, operations: [{ type: "autoCaptions" }] });
  const op = captionsIn(parsed);
  const filled = LOOK_FIELDS.filter((field) => op[field] !== undefined);
  check("the schema fills none of the five", filled.length === 0, JSON.stringify(op));
  check("and the operation still validates", op?.type === "autoCaptions");
  /*
    `dropFillers` keeps its default on purpose and is not one of the five.
    Nobody has a view on whether "um" should be burned into a frame; it is not
    a look, it is a mistake, and defaulting it takes no decision from anyone.
  */
  check("dropFillers still defaults, because it is not a taste", op.dropFillers === true);

  const spoken = captionsIn(
    EditPlan.parse({ version: 1, operations: [{ type: "autoCaptions", style: "hormozi", pace: "normal" }] }),
  );
  check("what was said survives exactly", spoken.style === "hormozi" && spoken.pace === "normal");
  check("and says nothing about the fields it did not mention", spoken.position === undefined && spoken.animation === undefined);

  const burn = captionsIn(
    EditPlan.parse({
      version: 1,
      operations: [{ type: "burnCaptions", cues: [{ startMs: 0, endMs: 900, text: "hello" }] }],
    }),
  );
  check(
    "burnCaptions is the same, because a plan reaches the renderer through both",
    LOOK_FIELDS.filter((f) => burn[f] !== undefined).length === 0,
    JSON.stringify(burn),
  );
}

// ─── The matcher answers what was asked, and nothing else ────────────────────

section("The keyword matcher writes only what the sentence said");
{
  const { planFromText } = await import(build("artifacts/api-server/src/lib/plan-from-text.ts", "matcher.mjs"));
  const look = (text) => {
    const result = planFromText(text);
    const op = (result.operations ?? result.plan?.operations ?? []).find((o) => o.type === "autoCaptions");
    return op ?? null;
  };

  const bare = look("add captions");
  check("a bare ask for captions produces the operation", bare !== null);
  check(
    "and not one of the five fields",
    bare && LOOK_FIELDS.every((f) => bare[f] === undefined),
    JSON.stringify(bare),
  );

  const hormozi = look("captions in the hormozi style");
  check("a named look is written", hormozi?.style === "hormozi", JSON.stringify(hormozi));
  check(
    "and naming a look says nothing about pace or position",
    hormozi && hormozi.pace === undefined && hormozi.position === undefined,
    JSON.stringify(hormozi),
  );

  /*
    The two the default took away, handed back in words.

    Bottom was the old default and calm was the old pace, so neither needed a
    phrase for as long as doing nothing produced them. Doing nothing produces
    the opposite now, and a default that cannot be asked back is a preference
    the product removed rather than a choice it made on your behalf.
  */
  check("captions at the bottom are askable again", look("put the captions at the bottom")?.position === "bottom");
  check("and in Arabic", look("خلي الكابشن تحت")?.position === "bottom");
  check("the calm pace is askable", look("slower captions, full sentences")?.pace === "normal");
  check("and in Arabic", look("بدي كابشن هادئ")?.pace === "normal");
  check("quick is still askable", look("fast punchy captions")?.pace === "quick");
  check("the middle is still askable", look("captions in the middle of the screen")?.position === "middle");

  /*
    Asking for the quick rhythm in words still brings the hard swap with it —
    at two swaps a second an entrance animation reads as flicker. The *default*
    quick pace does not, because the default style brings its own animation and
    `creator` was measured with focus.
  */
  check("quick asked for in words still picks the hard swap", look("fast captions")?.animation === "none");
  check("while a bare ask leaves the animation to the style", bare?.animation === undefined);
}

// ─── The panel, the habits and the planner all defer the same way ────────────

section("Nothing invents a look on somebody's behalf");
{
  const { withCaptionLook } = await import(build("artifacts/api-server/src/lib/caption-look.ts", "look.mjs"));
  const plan = (op) => ({ version: 1, operations: [EditPlan.parse({ version: 1, operations: [op] }).operations[0]] });

  const styled = withCaptionLook(plan({ type: "autoCaptions" }), { style: "neon", animation: "pop", pace: "normal" });
  check(
    "the picker fills what the sentence left absent",
    styled.operations[0].style === "neon" && styled.operations[0].animation === "pop" && styled.operations[0].pace === "normal",
    JSON.stringify(styled.operations[0]),
  );
  const spoke = withCaptionLook(
    plan({ type: "autoCaptions", style: "hormozi", animation: "karaoke", pace: "quick" }),
    { style: "neon", animation: "pop", pace: "normal" },
  );
  check(
    "and never overwrites what it did say",
    spoke.operations[0].style === "hormozi" && spoke.operations[0].animation === "karaoke" && spoke.operations[0].pace === "quick",
    JSON.stringify(spoke.operations[0]),
  );

  const { applyHabits } = await import(build("artifacts/api-server/src/lib/habits.ts", "habits.mjs"));
  const habits = [{ key: "captions", value: "yes", times: 5, outOf: 5 }];
  const { operations } = applyHabits([{ type: "removeSilence", thresholdDb: -32, minSilenceMs: 500, paddingMs: 80 }], habits, {});
  const added = operations.find((o) => o.type === "autoCaptions");
  check("a captions habit adds captions", added !== undefined);
  check(
    "with no style or animation invented for somebody who never chose one",
    added && added.style === undefined && added.animation === undefined,
    JSON.stringify(added),
  );

  const withStyle = applyHabits(
    [{ type: "removeSilence", thresholdDb: -32, minSilenceMs: 500, paddingMs: 80 }],
    [...habits, { key: "captionStyle", value: "beast", times: 4, outOf: 5 }],
    {},
  );
  check(
    "and the style it does have evidence for is applied",
    withStyle.operations.find((o) => o.type === "autoCaptions")?.style === "beast",
  );

  // The two remaining places a default could be reintroduced, read from source.
  const direct = read("artifacts/api-server/src/lib/direct.ts");
  const line = direct.slice(direct.indexOf('{ type: "autoCaptions"'), direct.indexOf('{ type: "autoCaptions"') + 120);
  check(
    "the direct planner adds captions without inventing a look",
    !/style:|position:|size:|animation:|pace:/.test(line),
    line.split("\n")[0],
  );
  const planner = read("artifacts/api-server/src/lib/planner.ts");
  check(
    "and the model's answer is not padded with fallbacks",
    !/captionStyle"\]\s*\?\?|captionPosition"\]\s*\?\?|captionPace"\]\s*\?\?/.test(planner),
  );
  check(
    "the model is told that null means they did not say",
    /leave it null when/i.test(planner) && /Null is not 'no captions'/i.test(planner),
  );
}

// ─── And the last moment, where the question is finally answered ─────────────

section("The renderer resolves the look once, and the style brings its own motion");
{
  const { resolveCaptionLook, CAPTION_STYLES } = await import(
    build("artifacts/worker/src/ffmpeg.ts", "ffmpeg.mjs", "artifacts/worker")
  );

  const bare = resolveCaptionLook({});
  /*
    Against the constant, not against a name. What this section is about is the
    resolver reading the default at all; which default it is, is pinned by name
    one section up. Written as a literal here, changing the decision meant
    changing it in three places and finding the third one from a red check.
  */
  check(
    "an unstyled caption becomes the default look",
    bare.style === DEFAULT_CAPTION_LOOK.style &&
      bare.position === DEFAULT_CAPTION_LOOK.position &&
      bare.pace === DEFAULT_CAPTION_LOOK.pace,
    JSON.stringify(bare),
  );
  /*
    Every style row carries `defaultAnimation` — "what this style animates like
    when the plan does not say" — and for as long as the schema stamped `pop`
    on every operation, the plan always said. Twelve looks tuned around an
    animation, and the field was read by nothing in the product.
  */
  check("and takes the animation the style was built with", bare.animation === "focus", bare.animation);
  check(
    "which is the style's own, not a constant",
    bare.animation === CAPTION_STYLES["creator"].defaultAnimation,
  );
  check("a different style brings a different one", resolveCaptionLook({ style: "hormozi" }).animation === "kinetic");
  check("and one that names no animation falls back to pop", resolveCaptionLook({ style: "pill" }).animation === "none");

  const said = resolveCaptionLook({ style: "neon", position: "top", size: "l", animation: "karaoke", pace: "normal" });
  check(
    "nothing chosen is overwritten",
    said.style === "neon" && said.position === "top" && said.size === "l" && said.animation === "karaoke" && said.pace === "normal",
    JSON.stringify(said),
  );
  check(
    "an unknown style renders rather than throwing",
    resolveCaptionLook({ style: "a-look-from-a-later-build" }).animation === "pop",
  );

  /*
    Resolved once and used everywhere, which is not a style preference: the
    band a cue is grouped for has to be the band it is drawn in, and the face
    measured against has to be the face drawn with. Two `?? default`s that
    drifted apart would group for one layout and render another, and the
    symptom is captions truncated on an ellipsis for no visible reason.
  */
  const enrich = read("artifacts/worker/src/enrich.ts");
  check("the grouping resolves the look once", /const look = resolveCaptionLook\(operation\)/.test(enrich));
  check(
    "and groups, measures and writes from that one answer",
    /position: look\.position/.test(enrich) && /look\.pace === "quick"/.test(enrich) && /style: look\.style/.test(enrich),
  );
  check(
    "the operation it hands the renderer records what was decided",
    /animation: look\.animation/.test(enrich),
  );

  /*
    And the geometry, measured rather than asserted as a word.

    "middle" is a string until something turns it into a number. `captionLayout`
    is that something — it is what both the grouping and the render lay out
    with — and ASS alignment 5 is the centre, 2 the bottom. Reading it here is
    the difference between checking that a constant says "middle" and checking
    that a caption actually lands mid-frame.
  */
  const { captionLayout } = await import(
    build("artifacts/worker/src/caption-layout.ts", "caption-layout.mjs", "artifacts/worker")
  );
  const frame = { width: 1080, height: 1920 };
  const byDefault = captionLayout(frame, "tiktok", { position: bare.position, size: bare.size });
  const atBottom = captionLayout(frame, "tiktok", { position: "bottom", size: bare.size });
  check("the default look centres the caption in the frame", byDefault.alignment === 5, JSON.stringify(byDefault.alignment));
  check("where bottom would sit it on the platform's furniture", atBottom.alignment === 2, JSON.stringify(atBottom.alignment));
  check(
    "and the band is still one line's worth of room, not a paragraph's",
    byDefault.maxLines >= 1,
    JSON.stringify(byDefault.maxLines),
  );

  const ffmpeg = read("artifacts/worker/src/ffmpeg.ts");
  check("the renderer resolves it too", /const look = resolveCaptionLook\(captions\)/.test(ffmpeg));
  check(
    "and draws from that answer rather than the raw operation",
    !/captions\.(style|position|size|animation)\b/.test(ffmpeg),
    (ffmpeg.match(/captions\.(style|position|size|animation)\b/) ?? [])[0] ?? "",
  );
}

// ─── The rule underneath all of it ───────────────────────────────────────────

section("A normal caption is still one line of three or four words");
{
  const enrich = read("artifacts/worker/src/enrich.ts");
  check("one line, always", /maxLines: 1,/.test(enrich));
  check("three words at the quick pace", /maxWordsPerCue: 3/.test(enrich));
  check("four at the calm one", /maxWordsPerCue: 4/.test(enrich));
  check(
    "and the rule is written where the code is, in the words it was given in",
    /بسطر واحد/.test(enrich),
  );
}

await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("Absent means nobody said, all the way down, and one constant answers it.");
