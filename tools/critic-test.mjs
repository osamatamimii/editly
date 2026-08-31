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
const { remapTime, keepSegmentsFrom, snapToWords, snapToSpeechBreaks, speechBreaks, SPEECH_BREAK_SECONDS, MOTION_OVERSCAN } = await import(
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

section("A dissolve moves the clock, and the critic moves with it");
{
  // The critic decides where a punch may land, and "where" is a position on
  // the edited clock. A dissolve makes that clock run short by one overlap per
  // join. If the critic reads the un-overlapped clock it guards splices that
  // are no longer there and lets punches sit inside the ones that are.
  const OVERLAP = 0.4;
  const shortened = EFFECTIVE - (KEPT.length - 1) * OVERLAP;

  const withOverlap = criticise({
    operations: [{ type: "zoomPunch", at: [25], amount: 1.1, holdMs: 400 }],
    kept: KEPT,
    effectiveDuration: shortened,
    overlap: OVERLAP,
  });
  const at = withOverlap.operations.find((o) => o.type === "zoomPunch")?.at ?? [];
  check("the punch survives the shorter clock", at.length === 1, JSON.stringify(at));
  check(
    "and lands where remapTime with the same overlap says it should",
    Math.abs(at[0] - remapTime(25, KEPT, OVERLAP)) < 0.2,
    `${at[0]} vs ${remapTime(25, KEPT, OVERLAP)}`,
  );
  check(
    "which is earlier than the same punch on a hard cut",
    remapTime(25, KEPT, OVERLAP) < remapTime(25, KEPT),
    `${remapTime(25, KEPT, OVERLAP)} vs ${remapTime(25, KEPT)}`,
  );
  check(
    "passing no overlap is the old behaviour exactly",
    remapTime(25, KEPT, 0) === remapTime(25, KEPT),
    String(remapTime(25, KEPT)),
  );
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

section("A cut never lands in the middle of a word");
{
  // Silence detection works on amplitude, and amplitude does not respect
  // syllables: a stop consonant dips below the threshold and the detector
  // reports a pause where a word is still being said. Cutting there clips the
  // syllable, which sounds like the speaker stumbled — so nobody reports it.
  const words = [
    { start: 0.0, end: 0.9 },
    { start: 1.0, end: 2.4 },   // the long one a false pause lands inside
    { start: 5.0, end: 5.6 },
  ];

  // The detector thought 1.8–4.9 was silence. It is not: 1.8 is mid-word.
  const naive = keepSegmentsFrom(10, [{ start: 1.8, end: 4.9 }], 0);
  check("without a transcript the cut lands inside the word", naive[0].end === 1.8, JSON.stringify(naive));

  const fixed = snapToWords(naive, words);
  check("with one, it moves to the end of the word", near(fixed[0].end, 2.4), JSON.stringify(fixed));
  check("outward, never inward — extra audio is safe, a clipped syllable is not", fixed[0].end > naive[0].end);
  check("the far side of the cut is untouched when it is genuinely in silence", near(fixed[1].start, 4.9));
  check("and the segment count is unchanged", fixed.length === naive.length);

  // A boundary already in silence is left exactly where it was.
  const clean = snapToWords(keepSegmentsFrom(10, [{ start: 2.6, end: 4.8 }], 0), words);
  check("a cut already between words does not move", near(clean[0].end, 2.6) && near(clean[1].start, 4.8), JSON.stringify(clean));

  // A recogniser sometimes emits a "word" spanning several seconds — a run of
  // speech it could not segment, or music. Snapping out of one of those would
  // undo the trim entirely for no gain, so it is not treated as a word.
  const runOn = snapToWords([{ start: 0, end: 3 }, { start: 20, end: 25 }], [{ start: 0, end: 9 }]);
  check("a multi-second 'word' is not believed", near(runOn[0].end, 3), JSON.stringify(runOn));

  check("no words, no change", JSON.stringify(snapToWords(naive, [])) === JSON.stringify(naive));
  check("no segments, no crash", snapToWords([], words).length === 0);
}

section("A clip begins where a thought begins");
{
  /*
    A window that starts on a word start is not the same as a window that
    starts in a sensible place.

    The scorer looks for where the talking is densest and starts its windows on
    word starts, so a boundary never lands inside a word. It still lands in the
    middle of a sentence, and a clip that opens on "...and that's why I think"
    is the single most obvious way an automatic edit announces itself. The
    right edge was worse: it was wherever `start + the length asked for` fell.

    There is no punctuation in a transcript from a recogniser, so the boundary
    is the breath: words inside a phrase sit tens of milliseconds apart, and a
    phrase boundary opens a gap you can hear.
  */
  // Three sentences with clear pauses at 3.0-3.8 and 8.0-9.0.
  const words = [
    { start: 0.0, end: 0.6 }, { start: 0.65, end: 1.2 }, { start: 1.25, end: 2.0 },
    { start: 2.05, end: 3.0 },
    /* pause */
    { start: 3.8, end: 4.4 }, { start: 4.45, end: 5.1 }, { start: 5.15, end: 6.0 },
    { start: 6.05, end: 6.8 }, { start: 6.85, end: 8.0 },
    /* pause */
    { start: 9.0, end: 9.7 }, { start: 9.75, end: 10.6 }, { start: 10.65, end: 11.4 },
  ];

  const breaks = speechBreaks(words);
  check(
    "the pauses are found, and the ends of the speech count as the strongest",
    breaks.starts.map((b) => b.at).join(",") === "0,3.8,9",
    JSON.stringify(breaks.starts),
  );
  check(
    "and so are the places a thought ends",
    breaks.ends.map((b) => b.at).join(",") === "3,8,11.4",
    JSON.stringify(breaks.ends),
  );
  check(
    "a gap shorter than a breath is not a boundary",
    speechBreaks([{ start: 0, end: 1 }, { start: 1.1, end: 2 }]).starts.length === 1,
    // 0.1s is ordinary articulation. If that counted, every word would be a
    // sentence start, which is the same as having no boundaries at all.
    JSON.stringify(speechBreaks([{ start: 0, end: 1 }, { start: 1.1, end: 2 }])),
  );

  // A window the scorer might well choose: starts on a word, mid-sentence.
  const naive = { start: 4.45, end: 9.45 };
  const snapped = snapToSpeechBreaks(naive, words, { driftSeconds: 1, duration: 11.4 });
  check("the start moves back to where the sentence began", near(snapped.start, 3.8), JSON.stringify(snapped));
  check("and the end onto the pause after it", near(snapped.end, 8), JSON.stringify(snapped));
  check(
    "the length is held from the moved start, not from the original",
    // Asked for 5s from 4.45. Moving the start back to 3.8 must not eat those
    // 0.65 seconds: the end is measured from 3.8, then snapped.
    snapped.end - snapped.start > naive.end - naive.start - 1.1,
    `${(snapped.end - snapped.start).toFixed(2)}s vs ${(naive.end - naive.start).toFixed(2)}s asked`,
  );

  check(
    "with no pause in reach it stays exactly where the scorer put it",
    JSON.stringify(snapToSpeechBreaks(naive, words, { driftSeconds: 0.1, duration: 11.4 })) ===
      JSON.stringify(naive),
    // The budget is the honesty: somebody asked for five seconds, and a clip
    // that quietly became eight because the sentences ran long is not it.
    JSON.stringify(snapToSpeechBreaks(naive, words, { driftSeconds: 0.1, duration: 11.4 })),
  );
  check(
    "and with no transcript at all",
    JSON.stringify(snapToSpeechBreaks(naive, undefined, { driftSeconds: 5, duration: 11.4 })) ===
      JSON.stringify(naive),
    "",
  );
  check(
    "a snap that would halve the clip is refused",
    // Two boundaries close together could collapse a 5s ask to under a second.
    // A clip cut down to nothing is worse than one that begins mid-sentence.
    (() => {
      const tight = snapToSpeechBreaks({ start: 2.05, end: 7.05 }, words, { driftSeconds: 4, duration: 11.4 });
      return tight.end - tight.start >= 2.5;
    })(),
    JSON.stringify(snapToSpeechBreaks({ start: 2.05, end: 7.05 }, words, { driftSeconds: 4, duration: 11.4 })),
  );
  check(
    "and a floor keeps one clip from drifting into the one before it",
    snapToSpeechBreaks(naive, words, { driftSeconds: 2, duration: 11.4, notBefore: 4.2 }).start >= 4.2,
    // chooseClips guarantees its windows do not overlap; a drifting boundary
    // is exactly what could break that, and two clips sharing a sentence read
    // as the same clip posted twice.
    JSON.stringify(snapToSpeechBreaks(naive, words, { driftSeconds: 2, duration: 11.4, notBefore: 4.2 })),
  );
  check(
    "the threshold is a breath, not a guess anybody has to look up",
    SPEECH_BREAK_SECONDS >= 0.25 && SPEECH_BREAK_SECONDS <= 0.6,
    String(SPEECH_BREAK_SECONDS),
  );
}

section("Widening a cut on both sides cannot produce a stutter");
{
  // Two kept stretches separated by a gap shorter than the words either side.
  // Snapping both outward makes them meet, and a zero-length cut becomes a
  // repeated frame rather than a trim.
  const words = [{ start: 0, end: 2.2 }, { start: 2.1, end: 4 }];
  const merged = snapToWords([{ start: 0, end: 2.1 }, { start: 2.15, end: 4 }], words);
  check("they merge instead of touching", merged.length === 1, JSON.stringify(merged));
  check("covering both", near(merged[0].start, 0) && near(merged[0].end, 4), JSON.stringify(merged));
  check("and nothing is zero length", merged.every((s) => s.end > s.start));
}

section("A punch does not land on a hesitation");
{
  const words = [
    { start: 3.5, end: 4.2, filler: false },
    { start: 5.0, end: 5.4, filler: true },  // "um"
    { start: 12.0, end: 12.6, filler: false },
  ];
  const result = criticise({
    operations: [punch([4, 5.2, 12.2])],
    kept: null,
    effectiveDuration: 30,
    words,
  });
  const at = find(result, "zoomPunch").at;
  check("the punch on 'um' is dropped", at.length === 2, JSON.stringify(at));
  check("the ones on real words survive", near(at[0], 4) && near(at[1], 12.2));
  check("and it says why", Boolean(noteMatching(result, /would have landed on/)), result.notes.join(" | "));
  check("naming the sound, not a code", /"um" or "uh"/.test(noteMatching(result, /would have landed/) ?? ""));

  // Without a transcript there is nothing to check against, and guessing would
  // be worse than not checking.
  const blind = criticise({ operations: [punch([4, 5.2, 12.2])], kept: null, effectiveDuration: 30 });
  check("with no transcript every punch is kept", find(blind, "zoomPunch").at.length === 3);
  check("and nothing is claimed about hesitations", !noteMatching(blind, /landed on/));
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
