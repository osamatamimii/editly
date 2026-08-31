/**
 * Cutting a word somebody meant is worse than leaving one they did not.
 *
 * Every other operation in this renderer is reversible in the sense that
 * matters: a bad crop or a wrong colour is visibly wrong and somebody asks for
 * it again. This one deletes speech from a recording published under a person's
 * name, and when it is wrong the result is fluent, plausible, and not what they
 * said. Nothing fails, nothing logs, and the person finds out from a viewer.
 *
 * So this suite is written asymmetrically on purpose. The checks that a
 * hesitation *is* removed are ordinary; the checks that an ordinary word is
 * **never** removed are the ones the thresholds were chosen for, and they are
 * the reason «يعني» and «طيب» are not on the filler list even though they are
 * the two commonest hesitations in Arabic speech.
 *
 * Usage: node tools/tighten-test.mjs
 * Requires: nothing.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-tighten-"));

function build(source, name) {
  const outfile = path.join(buildDir, name);
  const built = spawnSync(
    require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/worker"] }),
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

const T = await import(build("artifacts/worker/src/tighten.ts", "tighten.mjs"));
const timeline = await import(build("artifacts/worker/src/timeline.ts", "timeline.mjs"));
const planner = await import(build("artifacts/api-server/src/lib/plan-from-text.ts", "plan.mjs"));

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

/** Words laid out on a clock, one every `gap` seconds, each `length` long. */
function say(texts, { start = 0, length = 0.35, gap = 0.05 } = {}) {
  const words = [];
  let t = start;
  for (const text of texts) {
    words.push({ start: t, end: t + length, text });
    t += length + gap;
  }
  return words;
}

const covers = (cuts, word) => cuts.some((c) => c.start <= word.start + 0.01 && c.end >= word.end - 0.01);
const touches = (cuts, word) => cuts.some((c) => c.start < word.end && c.end > word.start);

// ── Hesitations ─────────────────────────────────────────────────────────────

section("A hesitation is removed, and the dead air it sat in goes with it");
{
  const words = say(["so", "um", "the", "point"]);
  const cuts = T.fillerCuts(words);
  check("the um is cut", cuts.length === 1 && covers(cuts, words[1]));
  check("and no ordinary word is touched", !touches(cuts, words[0]) && !touches(cuts, words[2]));
  /*
    Cutting exactly the word leaves the pause before it and the pause after it
    welded together, which is a longer silence than either — a hesitation
    replaced by a hole. A person editing by hand takes the pause too, and
    leaves a beat.
  */
  check(
    "the cut reaches past the word into the pauses either side",
    cuts[0].start < words[1].start && cuts[0].end > words[1].end,
    `${cuts[0].start.toFixed(3)}–${cuts[0].end.toFixed(3)} vs word ${words[1].start.toFixed(3)}–${words[1].end.toFixed(3)}`,
  );
  check("but never into the neighbouring words", cuts[0].start >= words[0].end && cuts[0].end <= words[2].start);
  check("and it asks for no padding, because it is already exact", cuts[0].pad === 0);
}

section("Arabic hesitations, and the ordinary words that look like them");
{
  const held = say(["قال", "آآ", "الكلام"]);
  check("«آآ» is a held sound and goes", T.fillerCuts(held).length === 1);

  /*
    The whole reason the Arabic filler list is small.

    «يعني» means *means*, «طيب» means *fine*, «إيه» is *yes* in the Levant. All
    three are also the commonest hesitations in Arabic speech, and there is no
    way to tell the two apart from the word alone. Leaving a hesitation in is
    untidy; cutting «يعني» out of "يعني ماذا؟" changes the sentence.
  */
  for (const word of ["يعني", "طيب", "إيه", "اه", "آه"]) {
    const words = say(["قال", word, "شيئًا"]);
    check(`«${word}» is an ordinary word and stays`, T.fillerCuts(words).length === 0);
  }
}

section("Timing that is noise is not acted on");
{
  const tooShort = say(["so", "um", "then"], { length: 0.04 });
  check("a word shorter than the recogniser's resolution is left alone", T.fillerCuts(tooShort).length === 0);

  const tooLong = [
    { start: 0, end: 0.4, text: "so" },
    { start: 0.5, end: 3.5, text: "um" },
    { start: 3.6, end: 4, text: "then" },
  ];
  check("and a three-second 'um' is something else that got marked", T.fillerCuts(tooLong).length === 0);
}

// ── False starts ────────────────────────────────────────────────────────────

section("A sentence begun twice keeps the attempt that finished");
{
  const words = say(["I", "think", "I", "think", "we", "should"]);
  const cuts = T.repeatCuts(words);
  check("something is cut", cuts.length === 1, String(cuts.length));
  check("and it is the first attempt", covers(cuts, words[0]) && covers(cuts, words[1]));
  /*
    Both runs are the same words, so the choice is about what follows them. The
    second run continues into the finished sentence; the first is the one that
    was abandoned. Cutting the second would delete the completed thought and
    keep the stumble.
  */
  check("never the second", !touches(cuts, words[2]) && !touches(cuts, words[3]));
  check("and never what comes after it", !touches(cuts, words[4]));

  const stutter = say(["the", "the", "point"]);
  check("a one-word stutter is a false start too", T.repeatCuts(stutter).length === 1);
}

section("Repetition that is not a false start survives");
{
  /*
    "Very very good" is emphasis. So is a phrase repeated deliberately across a
    sentence. The narrowness — immediate, and close in time — is what separates
    a stumble from a person making a point, and there is no way to widen it
    without deleting meaning.
  */
  const emphasis = [
    { start: 0, end: 0.4, text: "wrong" },
    { start: 4.0, end: 4.4, text: "wrong" },
  ];
  check("the same word again four seconds later is a callback, not a stumble", T.repeatCuts(emphasis).length === 0);

  const different = say(["we", "should", "we", "could"]);
  check("two different phrases are not a repeat", T.repeatCuts(different).length === 0);

  const punctuation = [
    { start: 0, end: 0.3, text: "—" },
    { start: 0.4, end: 0.7, text: "—" },
  ];
  check("and two symbols matching each other are not words", T.repeatCuts(punctuation).length === 0);
}

section("Arabic diacritics are pronunciation, not spelling");
{
  check("«قَالَ» and «قال» normalise to one word", T.normaliseWord("قَالَ") === T.normaliseWord("قال"));
  check("and so do 'The' and 'the.'", T.normaliseWord("The") === T.normaliseWord("the."));
  const marked = say(["قَالَ", "قال", "لي"]);
  check("so a stutter written with marks on one of them is still a stutter", T.repeatCuts(marked).length === 1);
}

// ── The whole pass ──────────────────────────────────────────────────────────

section("Merged, and judged as a whole");
{
  const words = say(["um", "I", "think", "I", "think", "so"]);
  const result = T.tighten(words, { duration: 10 });
  check("both kinds are found", result.fillersFound === 1 && result.repeatsFound === 1);
  check("the spans do not overlap", result.cuts.every((c, i) => i === 0 || c.start >= result.cuts[i - 1].end));
  check("and they are in order", result.cuts.every((c, i) => i === 0 || c.start >= result.cuts[i - 1].start));
  check("nothing was refused", result.refused === null);

  check("fillers can be turned off on their own", T.tighten(words, { duration: 10, fillers: false }).fillersFound === 0);
  check("and repeats can", T.tighten(words, { duration: 10, repeats: false }).repeatsFound === 0);
}

section("It gives up rather than take a quarter of somebody's video");
{
  const words = say(["um", "uh", "um", "uh", "um"], { length: 0.5, gap: 0.05 });
  const result = T.tighten(words, { duration: 4 });
  /*
    Not a tuning knob. If this much of a recording reads as hesitation, the
    reading is wrong — and a video that came back a quarter shorter with no
    explanation is a bug report, not an edit. Refused whole rather than trimmed
    to the limit, because a pass that stopped exactly at the ceiling would be a
    pass that had already lost the argument and kept cutting.
  */
  check("it refuses", result.refused === "too much");
  check("and removes nothing at all", result.cuts.length === 0);
  check("while still reporting what it saw", result.fillersFound > 0);
}

// ── Where the spans go ──────────────────────────────────────────────────────

section("Silences and hesitations reach the cutter as one list");
{
  const merged = timeline.mergeSpans([
    { start: 0, end: 1 },
    { start: 0.8, end: 1.5, pad: 0 },
    { start: 3, end: 4 },
  ]);
  check("overlapping spans become one", merged.length === 2, String(merged.length));
  check("the union covers both", merged[0].start === 0 && merged[0].end === 1.5);
  /*
    The smaller padding wins. A span from word boundaries is exact and asks for
    none; padding the union by the silence pass's eightieth of a second would
    put the start of a hesitation back into the video, and half an "um" is more
    noticeable than a whole one.
  */
  check("and takes the tighter padding of the two", merged[0].pad === 0);

  const kept = timeline.keepSegmentsFrom(
    10,
    [{ start: 2, end: 3, pad: 0 }, { start: 6, end: 7 }],
    0.08,
  );
  check("a span with pad 0 is cut exactly", kept[1].start === 3, String(kept[1].start));
  check("and one without keeps the pass's padding", Math.abs(kept[2].start - 6.92) < 1e-9, String(kept[2].start));
}

// ── The sentence somebody types ─────────────────────────────────────────────

const typesIn = (text) =>
  planner.planFromText(text, {}).operations.map((o) => o.type);

section("The words a person actually writes reach it");
{
  for (const [text, why] of [
    ["cut the ums", "English, precise"],
    ["remove the filler words", "the phrase people use"],
    ["he stutters a lot, fix it", "described rather than named"],
    ["شيل الترددات", "Arabic, precise"],
    ["فيه تلعثم كتير", "Arabic, described"],
  ]) {
    check(`"${text}" asks for it — ${why}`, typesIn(text).includes("tighten"), typesIn(text).join(", ") || "nothing");
  }

  /*
    "Cut the ums" used to produce removeSilence and nothing else, because `um`
    was in the silence pattern. An "um" is loud, so cutting the silences has
    never removed one: the request was answered by doing a different thing and
    reporting success.
  */
  check(
    "and 'cut the ums' no longer answers with the silence cutter instead",
    !typesIn("cut the ums").includes("removeSilence"),
    typesIn("cut the ums").join(", "),
  );

  // "Tighten it up" is a person asking for the whole treatment, and that is
  // the pauses as well as the hesitations.
  const both = typesIn("tighten it up");
  check("'tighten it up' is both operations", both.includes("tighten") && both.includes("removeSilence"), both.join(", "));

  check(
    "and cutting the silences alone does not quietly start deleting speech",
    !typesIn("cut the silences").includes("tighten"),
    typesIn("cut the silences").join(", "),
  );
}

section("And so does the sentence refusing it");
{
  /*
    A generous request pattern with no matching refusal pattern is exactly how
    "no captions" once added captions, and "keep the silence" cut it. Written
    the same day as the request it negates, so it cannot be forgotten
    separately.
  */
  for (const text of ["keep the ums", "don't cut the hesitations", "leave the ums in", "خلي الترددات"]) {
    check(`"${text}" produces no tightening`, !typesIn(text).includes("tighten"), typesIn(text).join(", "));
  }
}

await rm(buildDir, { recursive: true, force: true });
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
console.log("It cuts what nobody meant to say, and nothing else.");
