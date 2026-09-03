/**
 * The clip a podcaster would have picked, and the four ways a machine picks a
 * different one.
 *
 * Clipping is the feature this product is judged on by the audience it was
 * built for, and it is judged in about two seconds — the length of time it
 * takes to hear a clip open on "…and that's why I think" and know a machine
 * chose it. Nothing fails when that happens. The render is correct, the
 * captions are right, the levels are even, and the piece is unpostable.
 *
 * So this suite is not mostly about whether good windows are found. It is about
 * the four specific ways an automatic clipper produces a plausible wrong
 * answer, one section each:
 *
 *   1. **It opens mid-sentence.** The single most recognisable tell there is.
 *   2. **It ends before the point lands.** A question with no answer in it
 *      looks complete and is worthless.
 *   3. **It honours the length instead of the material.** Thirty seconds was a
 *      shape, not a specification, and cutting a fifty-second answer at thirty
 *      to respect the number loses the line the clip existed for.
 *   4. **It takes three clips out of one exchange.** The strongest three
 *      moments of an episode are frequently the same five minutes of it, and
 *      three clips from one answer is one clip posted three times.
 *
 * Usage: node tools/clipping-test.mjs
 * Requires: nothing. No keys, no network, no ffmpeg, no database.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-clipping-"));

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

const C = await import(build("artifacts/worker/src/conversation.ts", "conversation.mjs"));

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

/* ── An interview to cut ───────────────────────────────────────────────────── */

/**
 * One person talking from `start`, one word every `wordSeconds + gap`.
 *
 * Turns are separated by real silences in the fixture, because that is what a
 * conversation is: the boundary the chooser is supposed to find has to exist in
 * the input or the suite is testing nothing.
 */
function turn(speaker, start, text, { wordSeconds = 0.32, gap = 0.05 } = {}) {
  const words = [];
  let t = start;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    words.push({ start: round(t), end: round(t + wordSeconds), text: word, filler: false, speaker });
    t += wordSeconds + gap;
  }
  return words;
}
const round = (n) => Math.round(n * 100) / 100;
const flatten = (turns) => turns.flat().sort((a, b) => a.start - b.start);
const endOf = (words) => words[words.length - 1].end;

/** Strip the speaker labels, which is every deployment that did not ask for them. */
const unlabelled = (words) => words.map(({ speaker, ...rest }) => rest);

/*
  A twelve-minute interview, laid out so that every boundary the chooser should
  find is a real one and every trap is a real trap.
*/
const A = 0; // the host
const B = 1; // the guest

/**
 * Ordinary conversation, to fill the minutes between the moments.
 *
 * A fixture made only of the interesting parts would be a fixture where every
 * candidate wins, and the rule this suite exists to check — that three clips do
 * not come out of one exchange — cannot fail in a recording that is nothing but
 * one exchange. A podcast is people talking almost continuously; so is this.
 */
function chatter(from, to, speaker = A) {
  const lines = [
    "that is a fair way to put it and i think most people would agree with the shape of it",
    "we tried it the other way for about a year and it did not go anywhere at all",
    "there is a version of this that works for a bigger company but it is not this one",
    "you can see the same thing happen in other industries if you look for it",
  ];
  const out = [];
  let t = from;
  let who = speaker;
  let i = 0;
  while (t < to - 8) {
    const words = turn(who, t, lines[i % lines.length]);
    out.push(words);
    t = endOf(words) + 0.9;
    who = who === A ? B : A;
    i += 1;
  }
  return out;
}

const T = {
  hostIntro: turn(A, 0, "welcome back to the show today my guest has been building tools for editors for a decade"),
  guestHello: turn(B, 12, "thanks for having me it is good to be here and i have been looking forward to it"),

  // The clean question, at 30s, answered from 36s. This is the clip.
  q1: turn(A, 30, "so why do small teams ship faster than big ones"),
  a1: turn(
    B,
    36,
    "because every extra person is another decision that has to be agreed and we shipped eleven releases last quarter with three engineers while the team we replaced had forty and shipped two",
  ),

  // A turn that begins on a connective. Anything anchored inside it must lose.
  danglingTurn: turn(
    B,
    120,
    "and that is the thing i keep saying to people who ask me about hiring because the number is never the answer they want",
  ),

  // A second real question much later, so a spread rule has somewhere to go.
  q2: turn(A, 300, "what would you tell someone starting out today"),
  a2: turn(
    B,
    306,
    "learn to cut your own work before you learn to hire someone to cut it for you because that is the whole job and nobody will teach it to you on the way up",
  ),

  // A claim with the sentence that sets it up, in one turn.
  setupAndClaim: turn(
    B,
    500,
    "people ask me what changed and the honest answer is one thing we stopped having a weekly meeting and our output doubled in a quarter",
  ),
};

const WORDS = flatten([
  T.hostIntro,
  T.guestHello,
  T.q1,
  T.a1,
  ...chatter(endOf(T.a1) + 1, 120, A),
  T.danglingTurn,
  ...chatter(endOf(T.danglingTurn) + 1, 300, A),
  T.q2,
  T.a2,
  ...chatter(endOf(T.a2) + 1, 500, A),
  T.setupAndClaim,
  ...chatter(endOf(T.setupAndClaim) + 1, 560, A),
]);
const DURATION = 560;

const READING = {
  questions: [
    { at: 30, quote: "so why do small teams ship faster than big ones", answeredAt: 36 },
    { at: 300, quote: "what would you tell someone starting out today", answeredAt: 306 },
  ],
  claims: [{ at: 512, quote: "we stopped having a weekly meeting and our output doubled in a quarter" }],
  peaks: [{ start: 40, end: 55, why: "the number", strength: 0.9 }],
  hook: null,
};

const choose = (over = {}) =>
  C.chooseConversationClips({
    reading: READING,
    words: WORDS,
    duration: DURATION,
    count: 3,
    targetSeconds: 30,
    ...over,
  });

/** Every word that starts inside a window, in order. */
const spokenIn = (clip, words = WORDS) =>
  words.filter((w) => w.start >= clip.start - 0.01 && w.start < clip.end).map((w) => w.text);

const insideAWord = (t, words = WORDS) => words.some((w) => t > w.start + 0.01 && t < w.end - 0.01);

/* ── 1. It opens on a beginning ────────────────────────────────────────────── */

section("A clip that opens mid-sentence tells everyone a machine chose it");
{
  const clips = choose();
  check("clips were chosen at all", clips.length > 0, JSON.stringify(clips.map((c) => [c.start, c.end])));

  const first = clips.find((c) => c.anchor === "question" && c.start <= 31);
  check("the question's clip opens on the question", first !== undefined && Math.abs(first.start - 30) < 0.01, JSON.stringify(first));
  check(
    "with the question's own first word, not the second half of it",
    first !== undefined && spokenIn(first)[0] === "so",
    JSON.stringify(spokenIn(first ?? clips[0]).slice(0, 4)),
  );

  check(
    "no clip begins inside a word",
    clips.every((c) => !insideAWord(c.start)),
    JSON.stringify(clips.map((c) => c.start)),
  );

  /*
    The turn at 120s begins with "and". A claim inside it is a strong anchor —
    strong enough to win on content — and it must still lose, because the only
    place a clip built on it could start is on that word.

    Note that "so" opens the question itself and is a perfectly good opening for
    a clip: the rule is not about the word, it is about the word being where a
    sentence was already running. The two cases are here together on purpose.
  */
  check(
    "nothing is cut from the turn that begins on a connective",
    !clips.some((c) => c.start > 119 && c.start < 140),
    JSON.stringify(clips.map((c) => c.start)),
  );

  const againstEachOther = C.chooseConversationClips({
    reading: {
      questions: [],
      claims: [
        { at: 126, quote: "the number is never the answer they want" },
        { at: 512, quote: "we stopped having a weekly meeting and our output doubled in a quarter" },
      ],
      peaks: [],
      hook: null,
    },
    words: WORDS,
    duration: DURATION,
    count: 1,
    targetSeconds: 30,
  });
  check(
    "given two claims, the one that can open cleanly beats the one that cannot",
    againstEachOther.length === 1 && againstEachOther[0].start > 400,
    JSON.stringify(againstEachOther.map((c) => [c.start, spokenIn(c)[0]])),
  );
  check(
    "and a clip that does open on a connective was at least not preferred to one that did not",
    clips.every((c) => spokenIn(c)[0] !== "and"),
    JSON.stringify(clips.map((c) => spokenIn(c)[0])),
  );
}

/* ── 2. It ends after the point lands ──────────────────────────────────────── */

section("A question with no answer in it looks complete and is worth nothing");
{
  const clips = choose();
  const first = clips.find((c) => c.anchor === "question" && c.start <= 31);
  check("the answer is inside the clip", first !== undefined && first.end > 40, JSON.stringify(first));
  check(
    "and enough of it that the number is in there",
    first !== undefined && spokenIn(first).join(" ").includes("eleven releases"),
    JSON.stringify(first && spokenIn(first).join(" ").slice(0, 120)),
  );
  check(
    "no clip ends inside a word",
    clips.every((c) => !insideAWord(c.end)),
    JSON.stringify(clips.map((c) => c.end)),
  );

  // The rule stated on its own: a question answered late enough that the ask
  // cannot contain both still refuses to stop before the answer has spoken.
  const late = C.chooseConversationClips({
    reading: { questions: [{ at: 30, quote: "so why do small teams ship faster", answeredAt: 36 }], claims: [], peaks: [], hook: null },
    words: WORDS,
    duration: DURATION,
    count: 1,
    targetSeconds: 10,
  });
  check(
    "asked for ten-second clips, it still does not stop before the answer starts",
    late.length === 0 || late[0].end > 42,
    JSON.stringify(late.map((c) => [c.start, c.end])),
  );
}

/* ── 3. The length is a shape, not a specification ─────────────────────────── */

section("Thirty seconds was a shape, and an answer that runs longer is not cut at thirty");
{
  const clips = choose();
  for (const clip of clips) {
    const length = clip.end - clip.start;
    check(
      `a ${length.toFixed(1)}s clip is inside the band the ask allows`,
      length >= 30 * 0.6 - 0.01 && length <= 30 * 1.8 + 0.01,
      JSON.stringify(clip),
    );
  }

  const tight = C.chooseConversationClips({
    reading: READING,
    words: WORDS,
    duration: DURATION,
    count: 1,
    targetSeconds: 20,
  });
  check(
    "a smaller ask gives smaller clips, so the number is honoured where the material lets it be",
    tight.length > 0 && tight[0].end - tight[0].start <= 20 * 1.8 + 0.01,
    JSON.stringify(tight.map((c) => c.end - c.start)),
  );
}

/* ── 4. Not three clips out of one exchange ───────────────────────────────── */

section("The strongest three moments of an episode are often the same five minutes of it");
{
  const clips = choose();
  check("three were asked for and three came back", clips.length === 3, String(clips.length));
  check(
    "they do not overlap",
    clips.every((c, i) => i === 0 || clips[i - 1].end <= c.start + 1e-9),
    JSON.stringify(clips.map((c) => [c.start, c.end])),
  );
  check(
    "and come back in the order they happen, because clip 2 should follow clip 1",
    clips.every((c, i) => i === 0 || clips[i - 1].start < c.start),
    JSON.stringify(clips.map((c) => c.start)),
  );
  check(
    "they are spread across the recording rather than bunched in one exchange",
    new Set(clips.map((c) => Math.floor(c.start / 120))).size >= 2,
    JSON.stringify(clips.map((c) => c.start)),
  );

  // The peak at 40s sits inside the first question's answer. Both wanting the
  // same forty seconds is the normal case, and it must produce one clip.
  const overlapping = C.chooseConversationClips({
    reading: {
      questions: [{ at: 30, quote: "so why do small teams ship faster than big ones", answeredAt: 36 }],
      claims: [],
      peaks: [{ start: 40, end: 55, why: "the number", strength: 1 }],
      hook: null,
    },
    words: WORDS,
    duration: DURATION,
    count: 3,
    targetSeconds: 30,
  });
  check(
    "a question and a peak inside its answer are one clip, not two",
    overlapping.length === 1,
    JSON.stringify(overlapping.map((c) => [c.start, c.end, c.anchor])),
  );
  check("and the one that survives is the question", overlapping[0]?.anchor === "question", overlapping[0]?.anchor);
}

/* ── Titles, which are the speaker's words or nothing ─────────────────────── */

section("A clip is named by what was said in it");
{
  const clips = choose();
  const titled = clips.filter((c) => c.title !== null);
  check("the question clips are titled", titled.length > 0, JSON.stringify(clips.map((c) => c.title)));
  const transcript = WORDS.map((w) => w.text).join(" ").toLowerCase();
  check(
    "and every title is a run of words that is actually in the recording",
    titled.every((c) => transcript.includes(c.title.replace(/…$/, "").toLowerCase())),
    JSON.stringify(titled.map((c) => c.title)),
  );
  check(
    "a long question is cut at a word and marked, not chopped mid-word",
    clips.every((c) => c.title === null || !/\s…$/.test(c.title)),
    JSON.stringify(titled.map((c) => c.title)),
  );
}

/* ── Speakers, which are the whole reason this is different ───────────────── */

section("Who was talking, when the transcript was asked");
{
  const turns = C.turnsOf(WORDS);
  check("turns are found when the words carry labels", turns.length >= 8, String(turns.length));
  check(
    "and each is one voice, ending where the other starts",
    turns.every((t, i) => i === 0 || turns[i - 1].speaker !== t.speaker),
    JSON.stringify(turns.slice(0, 4)),
  );
  check("none are found when they do not", C.turnsOf(unlabelled(WORDS)).length === 0);

  // The same episode with the labels removed still produces clips — a
  // deployment whose provider returned no speakers gets pauses instead of
  // turns, which is worse and is not nothing.
  const withoutSpeakers = C.chooseConversationClips({
    reading: READING,
    words: unlabelled(WORDS),
    duration: DURATION,
    count: 3,
    targetSeconds: 30,
  });
  check("clips are still cut without speaker labels", withoutSpeakers.length > 0, String(withoutSpeakers.length));
  check(
    "and they still open on the question",
    withoutSpeakers.some((c) => Math.abs(c.start - 30) < 0.01),
    JSON.stringify(withoutSpeakers.map((c) => c.start)),
  );
}

/* ── Refusing ──────────────────────────────────────────────────────────────── */

section("What it declines to do");
{
  check(
    "no reading, no clips — the caller falls back to density and says so",
    C.chooseConversationClips({ reading: { questions: [], claims: [], peaks: [], hook: null }, words: WORDS, duration: DURATION, count: 3, targetSeconds: 30 }).length === 0,
  );
  check(
    "no words, no clips",
    C.chooseConversationClips({ reading: READING, words: [], duration: DURATION, count: 3, targetSeconds: 30 }).length === 0,
  );

  // A question floating in five minutes of silence. Every timestamp is real and
  // the window would be nine tenths dead air.
  const sparse = flatten([turn(A, 0, "so what happened next"), turn(B, 200, "well it took a while")]);
  check(
    "a window that is mostly silence is not a clip, however good the anchor",
    C.chooseConversationClips({
      reading: { questions: [{ at: 0, quote: "so what happened next", answeredAt: 200 }], claims: [], peaks: [], hook: null },
      words: sparse,
      duration: 240,
      count: 1,
      targetSeconds: 30,
    }).length === 0,
  );

  check(
    "a recording shorter than the shortest allowed clip yields nothing rather than the whole file",
    C.chooseConversationClips({ reading: READING, words: WORDS, duration: 5, count: 3, targetSeconds: 30 }).length === 0,
  );

  const nonsense = C.chooseConversationClips({
    reading: {
      questions: [{ at: Number.NaN, quote: "x", answeredAt: null }, { at: 9_000, quote: "y", answeredAt: null }],
      claims: [],
      peaks: [{ start: -50, end: -10, why: "", strength: 5 }],
      hook: null,
    },
    words: WORDS,
    duration: DURATION,
    count: 3,
    targetSeconds: 30,
  });
  check(
    "times that are not in the recording produce nothing rather than a window at the end of it",
    nonsense.every((c) => c.start >= 0 && c.end <= DURATION),
    JSON.stringify(nonsense.map((c) => [c.start, c.end])),
  );
}

/* ── The wiring ────────────────────────────────────────────────────────────── */

section("What the worker does with it");
{
  const worker = readFileSync(path.join(repoRoot, "artifacts/worker/src/index.ts"), "utf8");
  check("the clips path asks the conversation chooser first", /chooseConversationClips\(\{/.test(worker));
  check(
    "and falls back to the density chooser rather than returning nothing",
    /: chooseClips\(sourceSeconds, clipsOp\.count/.test(worker),
  );
  check(
    "a conversational window is not then dragged onto a nearby pause",
    /chosen\.how !== "conversation"/.test(worker),
  );
  check("the note says which of the two happened", /rather than from where the talking was densest/.test(worker));
  check("and the reason for each clip reaches the person", /clip \$\{index \+ 1\}/.test(worker));
  check("the question's own words become the clip's title", /conversational\[i\]\?\.title \?\? clipTitle/.test(worker));

  const enrich = readFileSync(path.join(repoRoot, "artifacts/worker/src/enrich.ts"), "utf8");
  check(
    "speaker labels are asked for on a clips plan, which nothing in this product had ever done",
    /wantsClips \? \{ diarize: true \}/.test(enrich),
  );
  check(
    "and only on a clips plan, because they cost more and buy nothing on one talking head",
    !/diarize: true \}\s*\)/.test(enrich.replace(/wantsClips \? \{ diarize: true \}/g, "")),
  );

  check(
    "the label reaches the words the chooser reads",
    /speaker: segment\.speaker/.test(worker),
  );
  check("and the reading reaches the renderer, for the one decision in it about content", /^      reading,$/m.test(worker));

  /*
    The other door into clipping, and the one the podcast template goes
    through.

    "Podcast clip" is `extractHighlight` pointed at a ninety-minute
    conversation. Improving the clip *set* and leaving that alone would have
    made the feature named after this audience the only one that did not get
    better.
  */
  const renderer = readFileSync(path.join(repoRoot, "artifacts/worker/src/ffmpeg.ts"), "utf8");
  check("the highlight asks the conversation chooser first too", /chooseConversationClips\(\{/.test(renderer));
  check(
    "and falls back to the density one rather than to nothing",
    /: chooseHighlight\(source\.duration, highlight\.targetSeconds, ctx\.words\)/.test(renderer),
  );
  check(
    "a window chosen from the reading is not then dragged onto a nearby pause",
    /choice\.how !== "conversation" && ctx\.words/.test(renderer),
  );
  check("and the note says where the window came from", /chosen from what was said/.test(renderer));
}

await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log("A clip that opens mid-sentence is a correct render nobody can post.");
  process.exit(1);
}
console.log("The pieces come from what was said, and they start where somebody started talking.");
