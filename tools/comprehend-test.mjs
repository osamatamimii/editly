/**
 * A reading of a video is the one output nobody can look at and check.
 *
 * Every other thing this worker produces can be inspected by a person in
 * seconds. A caption is on the screen or it is not; a cut is in the wrong place
 * or it is not; a colour look is applied or the frame is unchanged. A
 * *comprehension* is a list of chapters, claims, questions and peaks, and it is
 * exactly as convincing when it is fabricated as when it is true. It parses. It
 * validates. Every field is populated. The only way to know it is wrong is to
 * go and look at the second of audio it points at, which nobody will ever do.
 *
 * That is the entire reason this suite is written the way it is. The checks
 * that a real quote is *found* are ordinary. The checks that an invented one is
 * **dropped** are the ones the thresholds were chosen for, and they are the
 * point of the file — because the failure this module can produce is not an
 * error, a log line or a red build. It is a product that confidently tells
 * somebody they said a sentence they never said.
 *
 * The other half of the suite is the arithmetic that turns a model's opinion
 * about time into a fact about the file: a chapter at 03:12 of a ninety-second
 * clip, an answer that precedes its own question, two peaks that overlap. All
 * of those parse too.
 *
 * Usage: node tools/comprehend-test.mjs
 * Requires: nothing. No keys, no network, no ffmpeg, no database.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-comprehend-"));

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

const C = await import(build("artifacts/worker/src/comprehend.ts", "comprehend.mjs"));
const G = await import(build("artifacts/worker/src/providers/gemini-structure.ts", "structure.mjs"));
const P = await import(build("artifacts/worker/src/providers/index.ts", "providers.mjs"));

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

/* ── Fixtures ──────────────────────────────────────────────────────────────── */

/** One stretch of speech starting at `start`, laid out word by word on a clock. */
function seg(start, text, { wordSeconds = 0.4, gap = 0.06 } = {}) {
  const words = [];
  let t = start;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    words.push({
      text: word,
      startMs: Math.round(t * 1000),
      endMs: Math.round((t + wordSeconds) * 1000),
      confidence: 0.95,
      filler: false,
    });
    t += wordSeconds + gap;
  }
  return { startMs: Math.round(start * 1000), endMs: words[words.length - 1].endMs, text, words };
}

const transcript = (segments, language = "en") => ({ segments, language, source: "stub/test" });

/**
 * A hundred-and-twenty-second talk with real pauses in it: five stretches of
 * speech, each starting on a round number, separated by silences long enough to
 * be boundaries.
 */
const TALK = transcript([
  seg(0, "welcome to the show today we are talking about how small teams ship"),
  seg(20, "the first thing that matters is that you cut the meeting not the work"),
  seg(45, "did you ever wonder why a team of four moves faster than a team of forty"),
  seg(70, "we shipped eleven releases last quarter with three engineers"),
  seg(95, "so the answer is not more people it is fewer decisions"),
]);
const TALK_SECONDS = 120;

const ARABIC = transcript(
  [
    seg(0, "أهلًا بكم في الحلقة اليوم نتحدث عن كيف تشحن الفرق الصغيرة"),
    seg(25, "هل تساءلت يومًا لماذا يتحرك فريق من أربعة أسرع من فريق من أربعين"),
    seg(55, "أطلقنا إحدى عشرة نسخة في الربع الماضي بثلاثة مهندسين"),
  ],
  "ar",
);
const ARABIC_SECONDS = 80;

const words = (t) => C.wordsOf(t);

/** An empty answer, so each section can name only the field it is about. */
const read = (over = {}) => ({ chapters: [], claims: [], questions: [], peaks: [], hook: null, ...over });

/* ── The fingerprint that decides whether a reading is reused ──────────────── */

section("A reading is about the words, so its key is the words");
{
  const a = C.transcriptDigest(words(TALK));
  const b = C.transcriptDigest(words(transcript(TALK.segments.map((s) => ({ ...s })))));
  check("the same transcript fingerprints the same", a === b, `${a} ${b}`);

  const changedWord = transcript([
    seg(0, "welcome to the show today we are talking about how small teams SHIP"),
    ...TALK.segments.slice(1),
  ]);
  check("a different word is a different reading", C.transcriptDigest(words(changedWord)) !== a);

  const movedTime = transcript([seg(0.5, TALK.segments[0].text), ...TALK.segments.slice(1)]);
  check("and so is the same word at a different second", C.transcriptDigest(words(movedTime)) !== a);

  check("the fingerprint is short enough to store beside the row", a.length === 32, a);
}

/* ── What the reader is handed ─────────────────────────────────────────────── */

section("The reader is handed times, because otherwise it invents them");
{
  const lines = C.transcriptLines(TALK, C.TRANSCRIPT_BUDGET_CHARS).text.split("\n");
  check("one line per stretch of speech", lines.length === TALK.segments.length, String(lines.length));
  check(
    "and every one of them starts with the second it was said at",
    lines.every((line) => /^\[\d+\.\d\] \S/.test(line)),
    lines[0],
  );
  check("the first line is the first stretch", lines[0].startsWith("[0.0] welcome to the show"), lines[0]);

  // The failure being prevented: a structure of the first part of a talk,
  // stored as the structure of the talk. Nothing about that answer looks wrong.
  const long = transcript(Array.from({ length: 60 }, (_, i) => seg(i * 20, `part number ${i} of a very long recording indeed`)));

  // Merging costs the timestamps their resolution and keeps every word, so it
  // is tried first and the whole recording still goes.
  const thinned = C.transcriptLines(long, 3050);
  check("a transcript that does not fit is thinned rather than cut short", !thinned.truncated, String(thinned.text.length));
  check("which costs resolution, not material", thinned.text.split("\n").length < long.segments.length, String(thinned.text.split("\n").length));
  check("so the end of the recording still goes", thinned.text.includes("part number 59"), thinned.text.slice(-80));

  // And when the words alone still do not fit, the tail goes — loudly. A
  // structure of the first part of a talk, stored as the structure of the talk,
  // is the one answer here that nothing downstream could ever detect.
  const cut = C.transcriptLines(long, 700);
  check("when even that is not enough, what was dropped is admitted", cut.truncated, JSON.stringify(cut.coveredSeconds));
  check("and the note can say how far the reading got", cut.coveredSeconds > 0 && cut.coveredSeconds < 1180, String(cut.coveredSeconds));
  check("it is cut at a line, never inside a sentence", cut.text.split("\n").every((line) => /^\[\d+\.\d\] /.test(line)));

  const truncatedReading = await C.comprehend({
    transcript: long,
    durationSeconds: 1200,
    maxTranscriptChars: 700,
    reader: { name: "stub/reader", read: async () => read() },
  });
  check(
    "and the reading itself carries that admission, first, before anything it claims",
    /covers its first/.test(truncatedReading.notes[0] ?? ""),
    JSON.stringify(truncatedReading.notes),
  );
}

/* ── Grounding: the check the whole module rests on ────────────────────────── */

section("A quote is only a quote if somebody said it");
{
  const w = words(TALK);

  const real = C.locateQuote("we shipped eleven releases last quarter", w, 70);
  check("a sentence that was said is found", real !== null);
  check("at the second it was actually said", real !== null && Math.abs(real.start - 70) < 0.01, JSON.stringify(real));

  check(
    "a sentence that was never said is not found, however plausible it is",
    C.locateQuote("we shipped forty releases last quarter with one engineer", w) === null,
  );
  check(
    "and neither is a fluent summary of what was said",
    C.locateQuote("the team was small and moved quickly because of that", w) === null,
  );

  // The time is the model's weakest field and the words are its strongest, so
  // a real quote with a wrong time is repaired rather than thrown away.
  const misplaced = C.locateQuote("we shipped eleven releases last quarter", w, 5);
  check(
    "a real quote pointed at the wrong second is kept, at the right one",
    misplaced !== null && Math.abs(misplaced.start - 70) < 0.01,
    JSON.stringify(misplaced),
  );

  check(
    "a quote missing a word at the edge still matches — recognisers and readers disagree there",
    C.locateQuote("shipped eleven releases last quarter with three", w) !== null,
  );
  check(
    "but half a sentence padded with invention does not",
    C.locateQuote("we shipped eleven thousand units last quarter to every customer we had", w) === null,
  );

  check("a two-word quote has to be exactly right", C.locateQuote("eleven releases", w) !== null);
  check("and a two-word quote that is nearly right is not", C.locateQuote("eleven builds", w) === null);

  const twice = transcript([seg(0, "the answer is fewer decisions"), seg(40, "the answer is fewer decisions")]);
  const near = C.locateQuote("the answer is fewer decisions", words(twice), 41);
  check(
    "a sentence said twice resolves to the one the reader pointed at",
    near !== null && Math.abs(near.start - 40) < 0.01,
    JSON.stringify(near),
  );
}

section("And in Arabic, where a literal comparison would drop every real quote");
{
  const w = words(ARABIC);
  check(
    "hamza spelled the other way still matches",
    C.locateQuote("اطلقنا احدى عشرة نسخة في الربع الماضي", w) !== null,
  );
  check(
    "and so does taa marbuta written as haa",
    C.locateQuote("أطلقنا إحدى عشره نسخه في الربع الماضي", w) !== null,
  );
  check(
    "and a quote carrying diacritics the recogniser did not write",
    C.locateQuote("أَطْلَقْنَا إِحْدَى عَشْرَةَ نُسْخَةً فِي الرُّبْعِ الْمَاضِي", w) !== null,
  );
  check(
    "an Arabic sentence that was never said is still refused",
    C.locateQuote("أطلقنا أربعين نسخة في الربع الماضي بمهندس واحد", w) === null,
  );
}

/* ── Reconciliation: the model's opinion, measured against the file ────────── */

section("Times come from the file, not from the reader");
{
  const w = words(TALK);

  const beyond = C.reconcile(
    read({ chapters: [{ startSeconds: 192, endSeconds: 240, title: "the part that is not in this video" }] }),
    w,
    TALK_SECONDS,
  );
  check(
    "a chapter placed past the end of a two-minute video does not survive",
    beyond.chapters.length === 0,
    JSON.stringify(beyond.chapters),
  );

  const snapped = C.reconcile(
    read({
      chapters: [
        { startSeconds: 0, endSeconds: 44.1, title: "how small teams ship" },
        { startSeconds: 44.1, endSeconds: 120, title: "why four beats forty" },
      ],
    }),
    w,
    TALK_SECONDS,
  );
  check("two chapters survive", snapped.chapters.length === 2, JSON.stringify(snapped.chapters));
  check(
    "and the boundary between them moved onto a real pause",
    Math.abs(snapped.chapters[1].start - 45) < 0.01,
    JSON.stringify(snapped.chapters[1]),
  );
  check("the first chapter starts at the start", snapped.chapters[0].start === 0);
  check("and the last one ends at the end", snapped.chapters[1].end === TALK_SECONDS);

  const tiny = C.reconcile(
    read({
      chapters: [
        { startSeconds: 0, endSeconds: 4, title: "a sentence with a heading on it" },
        { startSeconds: 4, endSeconds: 120, title: "everything else" },
      ],
    }),
    w,
    TALK_SECONDS,
  );
  check(
    "a four-second chapter is a sentence with a heading on it, and is dropped",
    tiny.chapters.length === 1 && tiny.chapters[0].end === TALK_SECONDS,
    JSON.stringify(tiny.chapters),
  );

  const overlapping = C.reconcile(
    read({
      chapters: [
        { startSeconds: 0, endSeconds: 70, title: "first" },
        { startSeconds: 45, endSeconds: 120, title: "second" },
      ],
    }),
    w,
    TALK_SECONDS,
  );
  check(
    "chapters that overlap are one boundary in the wrong place, so they are trimmed rather than dropped",
    overlapping.chapters.length === 2 &&
      overlapping.chapters[0].end === overlapping.chapters[1].start,
    JSON.stringify(overlapping.chapters),
  );

  const holed = C.reconcile(
    read({ chapters: [{ startSeconds: 0, endSeconds: 45, title: "the first part only" }] }),
    w,
    TALK_SECONDS,
  );
  check(
    "a reader that covered half the video leaves the hole it left, rather than being stretched over it",
    holed.chapters.length === 1 && holed.chapters[0].end === 45,
    JSON.stringify(holed.chapters),
  );
}

section("What was said comes from the speaker, and is checked against them");
{
  const w = words(TALK);

  const mixed = C.reconcile(
    read({
      claims: [
        { atSeconds: 70, quote: "we shipped eleven releases last quarter with three engineers" },
        { atSeconds: 30, quote: "our revenue tripled in the same period" },
      ],
    }),
    w,
    TALK_SECONDS,
  );
  check("the claim that was made is kept", mixed.claims.length === 1, JSON.stringify(mixed.claims));
  check("at the second it was made", Math.abs(mixed.claims[0].at - 70) < 0.01, JSON.stringify(mixed.claims[0]));
  check(
    "the claim that was invented is gone",
    !mixed.claims.some((c) => /revenue/.test(c.quote)),
    JSON.stringify(mixed.claims),
  );
  check(
    "and the reading says out loud that something was dropped",
    mixed.notes.some((note) => /not in it/.test(note)),
    JSON.stringify(mixed.notes),
  );
  check("counted, so the size of the problem is visible", mixed.notes.some((n) => /\(1\)/.test(n)), JSON.stringify(mixed.notes));

  // The check that proves the check. A reader whose every quote is invented
  // must produce an empty reading — if this passes with claims in it, every
  // other assertion in this section is decoration.
  const allFabricated = C.reconcile(
    read({
      claims: [
        { atSeconds: 10, quote: "we raised a series B in March" },
        { atSeconds: 30, quote: "the product is used by two million people" },
      ],
      questions: [{ atSeconds: 50, quote: "what does the pricing look like next year" }],
      hook: { atSeconds: 0, quote: "this is the most important video you will watch today" },
    }),
    w,
    TALK_SECONDS,
  );
  check(
    "a reading in which nothing was really said produces nothing at all",
    allFabricated.claims.length === 0 &&
      allFabricated.questions.length === 0 &&
      allFabricated.hook === null,
    JSON.stringify(allFabricated),
  );
  check("and says so, four times over", allFabricated.notes.some((n) => /\(4\)/.test(n)), JSON.stringify(allFabricated.notes));
}

section("A question and its answer");
{
  const w = words(TALK);
  const asked = C.reconcile(
    read({
      questions: [
        {
          atSeconds: 45,
          quote: "did you ever wonder why a team of four moves faster than a team of forty",
          answeredAtSeconds: 95.4,
        },
      ],
    }),
    w,
    TALK_SECONDS,
  );
  check("the question is kept", asked.questions.length === 1, JSON.stringify(asked.questions));
  check(
    "and the answer's time moved onto the pause it really begins after",
    asked.questions[0].answeredAt === 95,
    JSON.stringify(asked.questions[0]),
  );

  const backwards = C.reconcile(
    read({
      questions: [
        {
          atSeconds: 45,
          quote: "did you ever wonder why a team of four moves faster than a team of forty",
          answeredAtSeconds: 20,
        },
      ],
    }),
    w,
    TALK_SECONDS,
  );
  check(
    "an answer that precedes its own question is a number the reader got wrong, and is not carried",
    backwards.questions[0].answeredAt === null,
    JSON.stringify(backwards.questions[0]),
  );
}

section("Peaks are times, so the only thing to check is the arithmetic");
{
  const w = words(TALK);
  const peaks = C.reconcile(
    read({
      peaks: [
        { startSeconds: 70, endSeconds: 90, why: "the number lands", strength: 0.9 },
        { startSeconds: 75, endSeconds: 95, why: "the same moment again", strength: 0.4 },
        { startSeconds: 20, endSeconds: 20.4, why: "a blink", strength: 0.8 },
        { startSeconds: 0, endSeconds: 19, why: "the opening", strength: 3 },
      ],
    }),
    w,
    TALK_SECONDS,
  );
  check("overlapping peaks resolve to one", peaks.peaks.filter((p) => p.start >= 60).length === 1, JSON.stringify(peaks.peaks));
  check("and it is the stronger of the two", peaks.peaks.some((p) => p.why === "the number lands"), JSON.stringify(peaks.peaks));
  check("a four-hundred-millisecond peak is a moment, not a stretch", !peaks.peaks.some((p) => p.why === "a blink"));
  check("a strength above one is clamped rather than believed", peaks.peaks.every((p) => p.strength <= 1), JSON.stringify(peaks.peaks));
  check("and they come back in the order they happen", peaks.peaks.every((p, i, all) => i === 0 || all[i - 1].start <= p.start));
}

/* ── With no model: what the shape of the speech alone may claim ───────────── */

section("With no model, the reading is weaker and says so");
{
  const shaped = C.fromShape(words(TALK), TALK_SECONDS);
  check("it still divides the video", shaped.chapters.length >= 1, JSON.stringify(shaped.chapters));
  check("covering it from the first second to the last, in order, with no gaps", coversFully(shaped.chapters, TALK_SECONDS), JSON.stringify(shaped.chapters));
  check("every chapter is titled with words that were actually spoken in it", shaped.chapters.every((c) => c.title.length > 0));

  // The two things a pause cannot know. This is the check that stops the
  // fallback from ever becoming the thing it is standing in for.
  check("it attributes no statement to anybody", shaped.claims.length === 0);
  check("and proposes no opening line", shaped.hook === null);
  check("and says both, rather than leaving an empty list to be read as 'there were none'", shaped.notes.length >= 3, JSON.stringify(shaped.notes));
  check(
    "and says where the boundaries came from",
    shaped.notes.some((note) => /pauses in the speech/.test(note)),
    JSON.stringify(shaped.notes),
  );

  const question = shaped.questions.find((q) => /did you ever wonder/.test(q.quote));
  check("a question mark is not needed to recognise a question", question !== undefined, JSON.stringify(shaped.questions));
  check("and it is placed where it was asked", question !== undefined && Math.abs(question.at - 45) < 0.01, JSON.stringify(question));
  check(
    "a statement is not turned into one",
    !shaped.questions.some((q) => /we shipped eleven releases/.test(q.quote)),
    JSON.stringify(shaped.questions),
  );

  const arabic = C.fromShape(words(ARABIC), ARABIC_SECONDS);
  check(
    "and an Arabic question is found by the same rule, which «؟» alone would have missed",
    arabic.questions.some((q) => /تساءلت/.test(q.quote)),
    JSON.stringify(arabic.questions),
  );

  check("peaks from density never overlap", noOverlap(shaped.peaks), JSON.stringify(shaped.peaks));
}

function coversFully(chapters, duration) {
  if (chapters.length === 0) return false;
  if (Math.abs(chapters[0].start) > 0.001) return false;
  if (Math.abs(chapters[chapters.length - 1].end - duration) > 0.05) return false;
  return chapters.every((c, i) => i === 0 || Math.abs(chapters[i - 1].end - c.start) < 0.001);
}

function noOverlap(spans) {
  return spans.every((s, i) => i === 0 || spans[i - 1].end <= s.start + 1e-9);
}

/* ── The whole step ────────────────────────────────────────────────────────── */

section("Reading the material, end to end");
{
  const answer = read({
    chapters: [
      { startSeconds: 0, endSeconds: 45, title: "how small teams ship" },
      { startSeconds: 45, endSeconds: 120, title: "fewer decisions" },
    ],
    claims: [{ atSeconds: 70, quote: "we shipped eleven releases last quarter with three engineers" }],
    hook: { atSeconds: 95, quote: "so the answer is not more people it is fewer decisions" },
    peaks: [{ startSeconds: 70, endSeconds: 90, why: "the number lands", strength: 0.9 }],
  });

  const withModel = await C.comprehend({
    transcript: TALK,
    durationSeconds: TALK_SECONDS,
    reader: { name: "stub/reader", read: async () => answer },
  });
  check("a model reading is marked as one", withModel.how === "model", withModel.how);
  check("and names the reader, the way a transcript names its source", withModel.source === "stub/reader");
  check("the hook survives, because it was actually said", withModel.hook !== null, JSON.stringify(withModel.hook));
  check("at the second it was said", withModel.hook !== null && Math.abs(withModel.hook.at - 95) < 0.01);
  check("the fingerprint is the transcript's", withModel.digest === C.transcriptDigest(words(TALK)));
  check("and the version is stamped, so an older shape is remade rather than misread", withModel.version === C.COMPREHENSION_VERSION);

  const broken = await C.comprehend({
    transcript: TALK,
    durationSeconds: TALK_SECONDS,
    reader: {
      name: "stub/broken",
      read: async () => {
        throw new Error("gemini 503: the model is overloaded");
      },
    },
  });
  check("a reader that fails does not throw — nobody paid for a reading", broken.how === "structure", broken.how);
  check("the video's parts are still there, from its pauses", broken.chapters.length >= 1);
  check("and the failure is named rather than swallowed", broken.notes.some((n) => /503/.test(n)), JSON.stringify(broken.notes));
  check("without claiming a source it did not have", broken.source === null);

  const none = await C.comprehend({
    transcript: TALK,
    durationSeconds: TALK_SECONDS,
    reader: null,
    unavailable: { en: "nothing is configured to read what was said", ar: "لا يوجد ما يقرأ الكلام" },
  });
  check("with no reader at all, the reason comes first", /nothing is configured/.test(none.notes[0] ?? ""), JSON.stringify(none.notes));
  check("and nothing is attributed to the speaker", none.claims.length === 0 && none.hook === null);

  const arabicNotes = await C.comprehend({
    transcript: TALK,
    durationSeconds: TALK_SECONDS,
    reader: null,
    language: "ar",
  });
  check(
    "the notes are written in the language the job was asked in",
    arabicNotes.notes.every((note) => /[؀-ۿ]/.test(note)),
    JSON.stringify(arabicNotes.notes),
  );

  const silent = await C.comprehend({ transcript: transcript([]), durationSeconds: 30 });
  check("a transcript with no words is an empty reading, not a crash", silent.chapters.length === 0 && silent.claims.length === 0);
  check("and it is still stamped, so it is not mistaken for a missing row", typeof silent.digest === "string" && silent.digest.length === 32);
}

/* ── The provider, without a key or a network ──────────────────────────────── */

section("What comes back off the wire");
{
  const wrap = (body) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(body) }] } }] });

  const parsed = G.parseStructure(
    wrap({
      chapters: [{ startSeconds: 0, endSeconds: 40, title: "one" }],
      claims: [{ atSeconds: 5, quote: "a thing" }],
      questions: [{ atSeconds: 9, quote: "why", answeredAtSeconds: 12 }],
      peaks: [{ startSeconds: 1, endSeconds: 4, why: "because", strength: 2 }],
      hook: { atSeconds: 3, quote: "open on this" },
    }),
  );
  check("the shape the schema asked for comes back whole", parsed.chapters.length === 1 && parsed.claims.length === 1);
  check("a strength outside the range is clamped at the edge", parsed.peaks[0].strength === 1, String(parsed.peaks[0].strength));
  check("the hook comes through", parsed.hook?.quote === "open on this", JSON.stringify(parsed.hook));
  check("an answer time is carried when there is one", parsed.questions[0].answeredAtSeconds === 12);

  const noAnswer = G.parseStructure(wrap({ chapters: [], claims: [], questions: [{ atSeconds: 9, quote: "why" }], peaks: [] }));
  check(
    "and is absent rather than zero when there is not — zero is a real second in every video",
    !("answeredAtSeconds" in noAnswer.questions[0]),
    JSON.stringify(noAnswer.questions[0]),
  );

  const noHook = G.parseStructure(wrap({ chapters: [], claims: [], questions: [], peaks: [] }));
  check("a reading with no hook is null, not an empty object", noHook.hook === null, JSON.stringify(noHook.hook));

  check("an empty answer is empty, not a throw", G.parseStructure({}).chapters.length === 0);

  let threw = false;
  try {
    G.parseStructure({ candidates: [{ content: { parts: [{ text: "Sure! Here are the chapters:" }] } }] });
  } catch {
    threw = true;
  }
  check("prose where JSON was promised fails loudly", threw);
}

section("Which keys switch the reading on");
{
  const none = P.resolveProviders({});
  check("no key, no reader", none.structureReader === null);
  check(
    "and the reason is in both languages, because it is built before any job knows which one",
    (none.status.structure?.en ?? "").length > 20 && (none.status.structure?.ar ?? "").length > 20,
    JSON.stringify(none.status.structure),
  );
  check(
    "and it says what is lost, not just what is missing",
    /densely/.test(none.status.structure?.en ?? ""),
    none.status.structure?.en,
  );

  const withKey = P.resolveProviders({ GEMINI_API_KEY: "k" });
  check("a key gives a reader", withKey.structureReader !== null);
  check("named after the model, like every other provider here", /^gemini\//.test(withKey.structureReader?.name ?? ""), withKey.structureReader?.name);
  check("and nothing is reported missing", withKey.status.structure === null);
  check(
    "the reader can be pointed at its own model without moving the scene reader",
    P.resolveProviders({ GEMINI_API_KEY: "k", GEMINI_STRUCTURE_MODEL: "gemini-pro-latest" }).structureReader?.name ===
      "gemini/gemini-pro-latest",
  );
  check(
    "and the key does not come back out",
    !JSON.stringify(withKey, (k, v) => (typeof v === "function" ? undefined : v)).includes('"k"'),
  );
}

await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log("A reading nobody can check is a reading nobody should trust.");
  process.exit(1);
}
console.log("Times come from the file, quotes come from the speaker, and what neither can vouch for is dropped.");
