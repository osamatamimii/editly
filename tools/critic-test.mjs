/**
 * Does the critic actually catch what it claims to?
 *
 * The critic exists because of one class of bug: a number measured on the
 * recording being applied to the edit. That bug is invisible in a diff and
 * invisible in a render — ffmpeg does exactly what it was told and the file
 * plays fine. The only way it ever gets caught is a test that builds a cut,
 * works out by hand where each moment ought to land, and checks.
 *
 * So every case here states the arithmetic in its name. Nothing is stubbed and
 * nothing is mocked: the real `criticise` runs against the real `remapTime`.
 *
 * Usage: node tools/critic-test.mjs
 * No keys, no network, no ffmpeg.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-critic-build-"));

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

const { criticise } = await import(bundle("artifacts/worker/src/critic.ts", "critic.mjs"));
const { remapTime, keepSegmentsFrom, MOTION_OVERSCAN } = await import(
  bundle("artifacts/worker/src/timeline.ts", "timeline.mjs")
);
// The renderer must keep re-exporting these: two suites import them from there.
const ffmpeg = await import(bundle("artifacts/worker/src/ffmpeg.ts", "ffmpeg.mjs"));

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
const near = (a, b, tolerance = 0.001) => Math.abs(a - b) <= tolerance;
const section = (title) => console.log(`\n${title}`);

const punch = (at, extra = {}) => ({ type: "zoomPunch", at, amount: 0.12, holdMs: 1200, ...extra });
const captions = (cues, extra = {}) => ({
  type: "burnCaptions", cues, style: "bold-white", animation: "pop", ...extra,
});
const find = (result, type) => result.operations.find((op) => op.type === type);
const noteMatching = (result, pattern) => result.notes.find((n) => pattern.test(n));

/**
 * A 30-second recording with two stretches of silence cut out of it:
 * 8–12s and 20–23s. Seven seconds go, so the edit runs 23 seconds.
 */
const KEPT = [
  { start: 0, end: 8 },
  { start: 12, end: 20 },
  { start: 23, end: 30 },
];
const EFFECTIVE = 23;

// ─── The bug this whole module was written for ───────────────────────────────

section("A punch keeps its word after the cut");
{
  // 25s in the source is 5s past the second cut, which begins at 16s edited.
  const result = criticise({
    operations: [punch([4, 25])],
    kept: KEPT,
    effectiveDuration: EFFECTIVE,
  });
  const at = find(result, "zoomPunch").at;
  check("a punch before any cut does not move", near(at[0], 4), `got ${at[0]}`);
  check("a punch after both cuts moves back by the 7s removed", near(at[1], 18), `got ${at[1]}`);
  check("the moved punch agrees with remapTime", near(at[1], remapTime(25, KEPT)));
  check(
    "without the critic it would have fired 7s late — on the wrong word",
    25 - remapTime(25, KEPT) > 1,
  );
}

section("A punch whose word was cut is dropped, not slid onto the next one");
{
  const result = criticise({
    operations: [punch([4, 10, 21])],
    kept: KEPT,
    effectiveDuration: EFFECTIVE,
  });
  const at = find(result, "zoomPunch").at;
  check("both punches inside removed silence are gone", at.length === 1, `kept ${at.length}`);
  check("the surviving one is the untouched 4s", near(at[0], 4));
  check("and the drop is written down", Boolean(noteMatching(result, /fell in silence/)));
  check("the note counts both", /2 punches/.test(noteMatching(result, /fell in silence/) ?? ""));
  check(
    "remapTime alone would have collapsed 10s onto the splice at 8s",
    near(remapTime(10, KEPT), 8),
  );
}

section("A punch with no room left to open and close is dropped");
{
  // 29.5s source → 22.5s edited, and a 1.2s hold runs 0.7s past the end.
  const result = criticise({
    operations: [punch([4, 29.5])],
    kept: KEPT,
    effectiveDuration: EFFECTIVE,
  });
  const at = find(result, "zoomPunch").at;
  check("the punch that would not finish is dropped", at.length === 1, `kept ${at.length}`);
  check("the note says so", Boolean(noteMatching(result, /past the end/)));
}

section("Punches pulled together by the cut are thinned back out");
{
  // 7.6s and 12.2s are 4.6s apart in the recording and 0.4s apart in the edit,
  // because the whole 8–12s pause between them is gone.
  const result = criticise({
    operations: [punch([7.6, 12.2])],
    kept: KEPT,
    effectiveDuration: EFFECTIVE,
  });
  const at = find(result, "zoomPunch").at;
  check(
    "they really are within the guard once the pause goes",
    remapTime(12.2, KEPT) - remapTime(7.6, KEPT) < 0.9,
  );
  check("only one survives", at.length === 1, `kept ${at.length}`);
  check("the first one is the one kept", near(at[0], 7.6));
  check("the note calls it bunching, not a cut", Boolean(noteMatching(result, /bunched up/)));
}

section("A punch sitting on a splice is nudged forward, never back");
{
  // 7.95s source → 7.95s edited, and the first splice is at 8s.
  const result = criticise({
    operations: [punch([7.95])],
    kept: KEPT,
    effectiveDuration: EFFECTIVE,
  });
  const at = find(result, "zoomPunch").at;
  check("it moved", !near(at[0], 7.95));
  check("forward, not back onto the previous word", at[0] > 7.95, `got ${at[0]}`);
  check("clear of the splice by the guard", near(at[0], 8.15), `got ${at[0]}`);
}

section("Nothing survives → no punches at all, rather than arbitrary ones");
{
  const result = criticise({
    operations: [punch([9, 10, 21])],
    kept: KEPT,
    effectiveDuration: EFFECTIVE,
  });
  check("the operation is gone entirely", !find(result, "zoomPunch"));
  check("and the reason is recorded", Boolean(noteMatching(result, /without them/)));
}

section("An uncut clip is left exactly as it was");
{
  const original = punch([4, 12, 25]);
  const result = criticise({ operations: [original], kept: null, effectiveDuration: 30 });
  const at = find(result, "zoomPunch").at;
  check("every punch keeps its time", at.length === 3 && near(at[2], 25));
  check("and nothing is reported", result.notes.length === 0, result.notes.join(" | "));
}

// ─── Captions ────────────────────────────────────────────────────────────────

section("Captions are converted once, in the same place");
{
  const result = criticise({
    operations: [
      captions([
        { startMs: 3000, endMs: 5000, text: "before the first cut" },
        {
          startMs: 24000, endMs: 26000, text: "after both",
          words: [{ startMs: 24000, endMs: 25000, text: "after" }, { startMs: 25000, endMs: 26000, text: "both" }],
        },
      ]),
    ],
    kept: KEPT,
    effectiveDuration: EFFECTIVE,
  });
  const cues = find(result, "burnCaptions").cues;
  check("an early cue is untouched", near(cues[0].startMs, 3000, 1));
  check("a late cue moves back by the 7s removed", near(cues[1].startMs, 17000, 1), `got ${cues[1].startMs}`);
  check("its length is preserved", near(cues[1].endMs - cues[1].startMs, 2000, 1));
  check("and its per-word timings move with it", near(cues[1].words[0].startMs, 17000, 1));
  check("word timings stay inside their cue", cues[1].words[1].endMs <= cues[1].endMs + 1);
}

section("A caption for speech that was cut is not burned over the splice");
{
  const result = criticise({
    operations: [
      captions([
        { startMs: 3000, endMs: 5000, text: "kept" },
        { startMs: 8500, endMs: 11500, text: "spoken into the silence that went" },
      ]),
    ],
    kept: KEPT,
    effectiveDuration: EFFECTIVE,
  });
  const cues = find(result, "burnCaptions").cues;
  check("the orphaned cue is removed", cues.length === 1, `kept ${cues.length}`);
  check("the surviving text is the right one", cues[0].text === "kept");
  check("the removal is reported", Boolean(noteMatching(result, /covered speech that was cut/)));
}

section("A caption running past the end is clipped, not dropped");
{
  const result = criticise({
    operations: [captions([{ startMs: 28000, endMs: 34000, text: "the last line" }])],
    kept: KEPT,
    effectiveDuration: EFFECTIVE,
  });
  const cues = find(result, "burnCaptions").cues;
  check("it survives", cues.length === 1);
  check("and ends with the video", near(cues[0].endMs, EFFECTIVE * 1000, 1), `got ${cues[0].endMs}`);
}

section("Every caption orphaned → none burned");
{
  const result = criticise({
    operations: [
      captions([
        { startMs: 8500, endMs: 11500, text: "gone" },
        { startMs: 20500, endMs: 22500, text: "also gone" },
      ]),
    ],
    kept: KEPT,
    effectiveDuration: EFFECTIVE,
  });
  check("the operation is dropped", !find(result, "burnCaptions"));
  check("with a reason", Boolean(noteMatching(result, /none were burned/)));
}

// ─── The zoom ceiling ────────────────────────────────────────────────────────

const peak = (to, amount) =>
  MOTION_OVERSCAN + (to != null ? (to - 1) * MOTION_OVERSCAN : 0) + (amount != null ? amount * MOTION_OVERSCAN : 0);
const CEILING = MOTION_OVERSCAN * 1.25;

section("A push and a punch that are fine alone are capped together");
{
  const result = criticise({
    operations: [{ type: "kenBurns", to: 1.5 }, punch([4], { amount: 0.6 })],
    kept: null,
    effectiveDuration: 30,
  });
  const to = find(result, "kenBurns").to;
  const amount = find(result, "zoomPunch").amount;
  check("the pair really was over the ceiling before", peak(1.5, 0.6) > CEILING);
  check("and is inside it after", peak(to, amount) <= CEILING + 0.001, `peak ${peak(to, amount)}`);
  check("the push gave ground first", to < 1.5);
  check("the punch is still a punch", amount >= 0.02, `got ${amount}`);
  check("the push is still a push", to > 1, `got ${to}`);
  check("and it is explained", Boolean(noteMatching(result, /magnified past the frame/)));
}

section("A pair already inside the ceiling is not touched");
{
  const result = criticise({
    operations: [{ type: "kenBurns", to: 1.08 }, punch([4], { amount: 0.12 })],
    kept: null,
    effectiveDuration: 30,
  });
  check("the push is unchanged", near(find(result, "kenBurns").to, 1.08));
  check("the punch is unchanged", near(find(result, "zoomPunch").amount, 0.12));
  check("and nothing is reported", result.notes.length === 0, result.notes.join(" | "));
}

section("A punch alone at full strength is left alone");
{
  const result = criticise({
    operations: [punch([4], { amount: 0.24 })],
    kept: null,
    effectiveDuration: 30,
  });
  check("it is inside the ceiling by itself", peak(null, 0.24) <= CEILING);
  check("so it keeps its amount", near(find(result, "zoomPunch").amount, 0.24));
}

section("A push so large it alone exceeds the ceiling is eased back");
{
  const result = criticise({
    operations: [{ type: "kenBurns", to: 1.5 }],
    kept: null,
    effectiveDuration: 30,
  });
  const to = find(result, "kenBurns").to;
  check("it was over", peak(1.5, null) > CEILING);
  check("it is not now", peak(to, null) <= CEILING + 0.001, `peak ${peak(to, null)}`);
  check("but it is still a visible push", to >= 1.02, `got ${to}`);
}

// ─── Everything else passes straight through ─────────────────────────────────

section("Operations the critic has no opinion about are untouched");
{
  const passthrough = [
    { type: "normalizeLoudness", targetLufs: -14 },
    { type: "watermark", text: "Made with Editly", position: "bottom-right", opacity: 0.6 },
  ];
  const result = criticise({
    operations: passthrough,
    kept: KEPT,
    effectiveDuration: EFFECTIVE,
  });
  check("both survive", result.operations.length === 2);
  check("byte for byte", JSON.stringify(result.operations) === JSON.stringify(passthrough));
  check("order is preserved", result.operations[0].type === "normalizeLoudness");
}

section("The critic never mutates the plan it was handed");
{
  const original = punch([4, 25]);
  const snapshot = JSON.stringify(original);
  criticise({ operations: [original], kept: KEPT, effectiveDuration: EFFECTIVE });
  check("the caller's operation is as it was", JSON.stringify(original) === snapshot);
}

// ─── The move that made this file possible ───────────────────────────────────

section("ffmpeg.ts still exports the timeline helpers the other suites import");
{
  check("keepSegmentsFrom", typeof ffmpeg.keepSegmentsFrom === "function");
  check("remapTime", typeof ffmpeg.remapTime === "function");
  check("MOTION_OVERSCAN", ffmpeg.MOTION_OVERSCAN === MOTION_OVERSCAN);
  check(
    "and they are the same implementation, not a copy",
    ffmpeg.keepSegmentsFrom === keepSegmentsFrom || String(ffmpeg.keepSegmentsFrom) === String(keepSegmentsFrom),
  );
  const kept = ffmpeg.keepSegmentsFrom(30, [{ start: 8, end: 12 }, { start: 20, end: 23 }], 0);
  check("and they still work", kept.length === 3 && near(kept[1].start, 12));
}

section("A quiet stretch that something is happening in is not a cut");
{
  const silences = [{ start: 8, end: 12 }, { start: 20, end: 23 }];

  const both = keepSegmentsFrom(30, silences, 0);
  check("with nothing protected, both silences go", both.length === 3, JSON.stringify(both));

  // A demo running on screen, a reveal, a beat held before a punchline: all
  // silent, and all the reason the clip exists.
  const spared = keepSegmentsFrom(30, silences, 0, [{ start: 19, end: 24 }]);
  check("a protected stretch survives the cut", spared.length === 2, JSON.stringify(spared));
  check("the unprotected silence still goes", near(spared[1].start, 12));
  check("and the protected one is intact, not trimmed to fit", near(spared[1].end, 30));

  const touching = keepSegmentsFrom(30, silences, 0, [{ start: 22.9, end: 25 }]);
  check("overlapping by a moment is enough to spare it", touching.length === 2, JSON.stringify(touching));

  const adjacent = keepSegmentsFrom(30, silences, 0, [{ start: 23, end: 25 }]);
  check("but merely touching the end is not — that is not overlap", adjacent.length === 3, JSON.stringify(adjacent));

  const all = keepSegmentsFrom(30, silences, 0, [{ start: 0, end: 30 }]);
  check("protecting everything means cutting nothing", all.length === 1 && near(all[0].end, 30));

  check(
    "and the old three-argument call still means what it did",
    JSON.stringify(keepSegmentsFrom(30, silences, 0)) === JSON.stringify(both),
  );
}

await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
