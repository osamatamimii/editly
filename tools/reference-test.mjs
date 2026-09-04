/**
 * Editing to match a video someone likes.
 *
 * This is the feature the pricing page has been selling on every paid plan
 * since it was written, and the measurement half of it — `style-measure.ts`,
 * with its own 25 tests — sat in the worker with exactly one importer: its own
 * test file. What was missing was the half that decides what a measured look
 * actually changes about an edit.
 *
 * The temptation in a feature like this is to let the reference take over: it
 * has opinions about everything, so why not apply all of them. The rule here is
 * the opposite, and it is what these checks are mostly about — **a reference
 * sets the numbers inside decisions the plan already made, and makes none of
 * its own.** A plan with no silence removal does not gain it because the
 * reference cuts hard. A plan with no motion does not sprout a push.
 *
 * The grade is the one exception, because no operation the user would have
 * written can express it, and even then it only appears when the two videos
 * measure differently enough to see.
 *
 * Usage: node tools/reference-test.mjs
 * Requires: nothing. The style profiles here are literals, so no ffmpeg.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-reference-build-"));

function bundle(entry, name, from) {
  const outfile = path.join(buildDir, name);
  const result = spawnSync(
    require.resolve("esbuild/bin/esbuild", { paths: [from] }),
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

const { applyReferenceStyle } = await import(
  bundle("artifacts/worker/src/reference-style.ts", "reference.mjs", "artifacts/worker")
);
const { styleToSettings } = await import(
  bundle("artifacts/worker/src/style-measure.ts", "style.mjs", "artifacts/worker")
);
const { EditOperation, EditPlan } = await import(
  bundle("lib/api-zod/src/index.ts", "zod.mjs", "artifacts/api-server")
);

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

const profile = (over = {}) => ({
  cutsPerMinute: 6,
  keptSilenceMs: 400,
  targetLufs: -14,
  loudnessRange: 7,
  audioMeasured: true,
  gradeMeasured: true,
  saturation: 0.3,
  brightness: 0.5,
  motion: 0.2,
  sampledSeconds: 120,
  sourceSeconds: 120,
  ...over,
});

/** A fast, punchy, heavily graded reference. */
const RESTLESS = profile({ cutsPerMinute: 24, keptSilenceMs: 180, motion: 0.7, saturation: 0.48, targetLufs: -12 });
/** A calm, flat, unhurried one. */
const CALM = profile({ cutsPerMinute: 3, keptSilenceMs: 800, motion: 0.05, saturation: 0.18, targetLufs: -18 });
/** What the user's own footage measures. */
const OWN = profile({ saturation: 0.3, sampledSeconds: 120 });

const SILENCE = { type: "removeSilence", thresholdDb: -32, minSilenceMs: 500, paddingMs: 80 };
const VERTICAL = { type: "formatForPlatform", platform: "tiktok" };
const PUSH = { type: "kenBurns", to: 1.08 };
const LOUD = { type: "normalizeLoudness", targetLufs: -14 };
const punch = (at) => ({ type: "zoomPunch", at, amount: 0.12, holdMs: 1200 });

// `own` is passed through exactly as given, including undefined — the whole
// point of one of the checks below is what happens when we have not measured
// the user's own footage, and a default parameter would have quietly supplied
// it and made that check pass for the wrong reason.
const apply = (operations, reference, own, sourceSeconds = 120) =>
  applyReferenceStyle(operations, styleToSettings(reference, own), { reference, sourceSeconds });

const find = (result, type) => result.operations.find((op) => op.type === type);

// ─── What a reference is allowed to decide ───────────────────────────────────

section("A reference sets numbers inside decisions, and makes none of its own");
{
  const result = apply([VERTICAL], RESTLESS, OWN);
  check("a plan with no silence removal does not gain one", !find(result, "removeSilence"));
  check("nor a push, however restless the reference", !find(result, "kenBurns"));
  check("nor punches", !find(result, "zoomPunch"));
  check("the reframe survives untouched", JSON.stringify(find(result, "formatForPlatform")) === JSON.stringify(VERTICAL));
  check("and the operation count does not grow, apart from the grade", result.operations.length <= 2);
}

section("Cutting follows what the reference was willing to leave in");
{
  const fast = apply([SILENCE], RESTLESS, OWN);
  const slow = apply([SILENCE], CALM, OWN);
  const fastCut = find(fast, "removeSilence");
  const slowCut = find(slow, "removeSilence");

  check("a hard-cutting reference lowers the threshold", fastCut.minSilenceMs < 500, String(fastCut.minSilenceMs));
  check("a patient one raises it", slowCut.minSilenceMs > 500, String(slowCut.minSilenceMs));
  check("the patient reference keeps more than the fast one", slowCut.minSilenceMs > fastCut.minSilenceMs);
  check("never so tight that a breath is clipped", fastCut.minSilenceMs >= 150, String(fastCut.minSilenceMs));
  check("never so loose that nothing is cut", slowCut.minSilenceMs <= 900, String(slowCut.minSilenceMs));
  check("the threshold in dB is left alone — that is not a style question", fastCut.thresholdDb === -32);
  check("and it says what it did, in milliseconds", /pauses of about \d+ms/.test(fast.notes.join(" ")), fast.notes.join(" | "));
}

section("Motion follows the reference's rhythm, not its literal cut count");
{
  const found = [2, 5, 9, 14, 20, 27, 33, 41, 50, 62, 70, 84];
  const fast = apply([PUSH, punch(found)], RESTLESS, OWN);
  const slow = apply([PUSH, punch(found)], CALM, OWN);

  check("a restless reference pushes harder", find(fast, "kenBurns").to > find(slow, "kenBurns").to);
  check("but never past a push you would notice as a zoom", find(fast, "kenBurns").to <= 1.12);
  check("and a calm one still moves a little", find(slow, "kenBurns").to >= 1.02);

  check("a restless reference punches harder", find(fast, "zoomPunch").amount > find(slow, "zoomPunch").amount);
  check("and keeps more of them", find(fast, "zoomPunch").at.length > find(slow, "zoomPunch").at.length);
  // The budget is the reference's own rhythm at a third of its cut rate, over
  // the length of the clip — not a fixed number. A reference that cuts 24 times
  // a minute earns 8 punches a minute, so over two minutes all twelve found
  // moments are within budget and keeping them is the right answer. What must
  // never happen is more punches than the reference's rhythm allows.
  const budget = Math.round((RESTLESS.cutsPerMinute / 3) * 2);
  check(
    "a restless reference keeps no more punches than its own rhythm earns",
    find(fast, "zoomPunch").at.length <= budget,
    `${find(fast, "zoomPunch").at.length} kept, budget ${budget}`,
  );
  check(
    "and a calm one is thinned hard — one a minute, not eight",
    find(slow, "zoomPunch").at.length <= 3,
    String(find(slow, "zoomPunch").at.length),
  );
  check("at least one survives", find(slow, "zoomPunch").at.length >= 1);
  check("the ones kept are in order", find(fast, "zoomPunch").at.every((t, i, a) => i === 0 || t > a[i - 1]));
  check(
    "and spread across the clip rather than clustered at the front",
    find(fast, "zoomPunch").at[find(fast, "zoomPunch").at.length - 1] > 40,
    JSON.stringify(find(fast, "zoomPunch").at),
  );
}

section("Punches the plan left for the worker stay left for the worker");
{
  const result = apply([punch([])], RESTLESS, OWN);
  check("an empty list is not filled in here", find(result, "zoomPunch").at.length === 0);
  check("but the strength is still set", find(result, "zoomPunch").amount !== 0.12);
}

section("Loudness follows the reference, within what platforms accept");
{
  const quiet = apply([LOUD], CALM, OWN);
  const loud = apply([LOUD], RESTLESS, OWN);
  check("a quiet reference lowers the target", find(quiet, "normalizeLoudness").targetLufs < -14);
  check("a loud one raises it", find(loud, "normalizeLoudness").targetLufs > -14);
  check("never outside what a platform will leave alone", find(quiet, "normalizeLoudness").targetLufs >= -20);

  const silentReference = apply([LOUD], profile({ audioMeasured: false, targetLufs: -60 }), OWN);
  check(
    "a reference with no measurable audio does not drag the level anywhere",
    find(silentReference, "normalizeLoudness").targetLufs === -14,
  );
  check(
    "and does not claim to have matched a level",
    !silentReference.notes.some((n) => /LUFS/.test(n)),
    silentReference.notes.join(" | "),
  );

  // A reference quieter than the range the feeds leave alone. The target is
  // clamped to -20, but the reference sits at -23.5 — so the note must not
  // claim -20 is "where your reference sits".
  const tooQuiet = apply([LOUD], profile({ audioMeasured: true, targetLufs: -23.5 }), OWN);
  const note = tooQuiet.notes.find((n) => /LUFS/.test(n)) ?? "";
  check(
    "the level applied is clamped to the range",
    find(tooQuiet, "normalizeLoudness").targetLufs === -20,
    String(find(tooQuiet, "normalizeLoudness").targetLufs),
  );
  check(
    "and the note does not claim the clamped target is where the reference sits",
    !/-20 LUFS, which is where your reference sits/.test(note),
    note,
  );
  check(
    "it names where the reference actually was",
    /-23\.5/.test(note),
    note,
  );
  // And when the reference is inside the range, the plain note is right.
  const inRange = apply([LOUD], profile({ audioMeasured: true, targetLufs: -15 }), OWN);
  check(
    "a reference inside the range keeps the plain note",
    inRange.notes.some((n) => /where your reference sits|حيث يجلس مرجعك/.test(n)),
    inRange.notes.join(" | "),
  );
}

// ─── The grade ───────────────────────────────────────────────────────────────

section("Colour is a comparison, never an absolute");
{
  const richer = apply([VERTICAL], RESTLESS, OWN);
  const grade = find(richer, "grade");
  check("a more saturated reference pushes the colour up", grade && grade.saturation > 1, JSON.stringify(grade));
  check("but only part of the way — the reference's grade belongs to its own footage", grade.saturation < 1.35);
  check("and it says so in a way a person can check", /more saturated/.test(richer.notes.join(" ")), richer.notes.join(" | "));

  const flatter = apply([VERTICAL], CALM, OWN);
  check("a flatter reference pulls it back", find(flatter, "grade").saturation < 1);
  check("bounded on that side too", find(flatter, "grade").saturation >= 0.85);
}

section("Footage that already matches is left alone");
{
  const same = apply([VERTICAL], profile({ saturation: 0.3 }), OWN);
  check("no grade operation is added for a change nobody would see", !find(same, "grade"));
  check("and nothing is claimed about the colour", !same.notes.some((n) => /colour|saturat/i.test(n)), same.notes.join(" | "));
}

section("Without a reading of the user's own footage, the colour is not touched");
{
  const blind = apply([VERTICAL], RESTLESS, undefined);
  check("no grade is invented from the reference alone", !find(blind, "grade"));
}

section("A reference with no readable grade does not pull the colour toward grey");
{
  /*
    A reference that is an audio file, or anything signalstats could sample no
    frame from, measures saturation 0 — which is not "grey", it is "not
    measured". The old reading averaged the empty result to a real flat grade
    and pulled the footage toward grey with a note claiming a colour match that
    never happened. `gradeMeasured: false` is the honest answer.
  */
  const unreadable = profile({ gradeMeasured: false, saturation: 0, brightness: 0 });
  const result = apply([VERTICAL], unreadable, OWN);
  check("no grade is added from a reference whose colour was never read", !find(result, "grade"));
  check(
    "and nothing is claimed about the colour",
    !result.notes.some((n) => /colour|saturat|تشبّع|اللون/i.test(n)),
    result.notes.join(" | "),
  );
  // And the reverse: the user's own footage being unreadable is just as much a
  // reason not to touch the colour.
  const blindSource = apply([VERTICAL], RESTLESS, profile({ gradeMeasured: false, saturation: 0 }));
  check("nor when it is the user's footage that could not be read", !find(blindSource, "grade"));
}

section("A colour setting already in the plan is an instruction, not a suggestion");
{
  const explicit = { type: "grade", saturation: 1.2 };
  const result = apply([VERTICAL, explicit], RESTLESS, OWN);
  const grades = result.operations.filter((op) => op.type === "grade");
  check("it survives", grades.length === 1 && grades[0].saturation === 1.2, JSON.stringify(grades));
  check("the reference does not add a second one", grades.length === 1);
  check("and the override is stated", /already in the plan/.test(result.notes.join(" ")), result.notes.join(" | "));
}

// ─── Still a valid plan afterwards ───────────────────────────────────────────

section("What comes out is a plan the worker will accept");
{
  const result = apply([SILENCE, VERTICAL, PUSH, punch([2, 8, 15, 30]), LOUD], RESTLESS, OWN);
  const parsed = EditPlan.safeParse({ version: 1, operations: result.operations });
  check("it validates against the schema", parsed.success, JSON.stringify(parsed.error?.issues?.[0]));
  check("every operation validates individually", result.operations.every((op) => EditOperation.safeParse(op).success));
  check("order is preserved", result.operations[0].type === "removeSilence" && result.operations[1].type === "formatForPlatform");
  check("the grade is appended, not inserted mid-plan", result.operations[result.operations.length - 1].type === "grade");
  check("and it stays inside the twelve-operation cap", result.operations.length <= 12);
}

section("Every change is stated, and no change claims more than it did");
{
  const result = apply([SILENCE, VERTICAL, PUSH, punch([2, 8, 15, 30]), LOUD], RESTLESS, OWN);
  check("there is a note for each thing that moved", result.notes.length >= 4, result.notes.join(" | "));
  check(
    "none of them says 'matched your reference' without saying how",
    result.notes.every((n) => /\d/.test(n)),
    result.notes.join(" | "),
  );
  check("nothing is reported that was not asked for", !result.notes.some((n) => /captions/i.test(n)));
}

section("An extreme reference cannot produce an extreme edit");
{
  const absurd = profile({ cutsPerMinute: 600, keptSilenceMs: 5, motion: 1, saturation: 1, targetLufs: -3 });
  const result = apply([SILENCE, PUSH, punch([1, 2, 3, 4, 5]), LOUD], absurd, OWN);
  check("the push stays inside the frame we reserved", find(result, "kenBurns").to <= 1.12);
  check("the punch stays inside it too", find(result, "zoomPunch").amount <= 0.22);
  check("the cut does not eat the breaths", find(result, "removeSilence").minSilenceMs >= 150);
  check("the level stays where platforms leave it", find(result, "normalizeLoudness").targetLufs >= -20 && find(result, "normalizeLoudness").targetLufs <= -10);
  check("the colour does not go plastic", find(result, "grade").saturation <= 1.35);
  check("and it is still a valid plan", EditPlan.safeParse({ version: 1, operations: result.operations }).success);
}

await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("A reference changes the numbers, not the edit.");
