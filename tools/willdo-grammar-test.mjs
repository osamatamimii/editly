/**
 * Every phrase the product promises, read as the sentence it ends up inside.
 *
 * `willDo` is a list of bare verb phrases. Nothing stores the sentence they
 * become: the English ones are read after "I'll " or under "Here is what I
 * will do:", the Arabic ones after «رح» or under «رح:». A phrase that is
 * grammatical on its own and wrong in that frame is invisible to every other
 * suite here, because every other suite reads the phrase.
 *
 * That has already happened twice, and both times in the careful sentences:
 *
 *   "I can't cut in B-roll, because this project has no clips to cut to yet
 *    yet, so I'll leave that out"
 *
 * -- a "yet" appended to a phrase that carried its own. And a whole layer,
 * `direct.ts`, sat outside both voice guards for weeks writing nine of the ten
 * lines in an ordinary reply.
 *
 * So this suite does not read the source. It drives the real functions --
 * the matcher, the planner's describer, the director -- over a wide corpus,
 * collects every phrase that actually reaches `willDo`, and reads each one
 * back inside its frame. A phrase added tomorrow by any of those layers is in
 * the corpus tomorrow, without anybody listing it here.
 *
 * Usage: node tools/willdo-grammar-test.mjs
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-willdo-"));

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

const build = (source, name) => {
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
  if (built.status !== 0) {
    console.error(`could not bundle ${source}`);
    process.exit(1);
  }
  return pathToFileURL(outfile).href;
};

const { planFromText } = await import(build("artifacts/api-server/src/lib/plan-from-text.ts", "matcher.mjs"));
const { describeAll } = await import(build("artifacts/api-server/src/lib/planner.ts", "planner.mjs"));
const { direct } = await import(build("artifacts/api-server/src/lib/direct.ts", "direct.mjs"));

// ─── Gathering every phrase that actually reaches willDo ─────────────────────

/** Where each phrase came from, so a failure names the layer to open. */
const phrases = [];
const gather = (from, list) => {
  for (const p of list ?? []) {
    if (!p || typeof p.en !== "string" || typeof p.ar !== "string") continue;
    phrases.push({ from, en: p.en, ar: p.ar });
  }
};

/*
  The matcher, over sentences in both languages. Deliberately wide rather than
  clever: the point is coverage of the phrase table, and the cheapest way to
  reach a phrase is to say the thing that produces it.
*/
const SENTENCES = [
  "cut the silences and caption it",
  "make it vertical for tiktok",
  "make it wide for youtube",
  "make it square for a feed post",
  "give me the strongest 30 seconds",
  "keep from 1:20 to 2:10",
  "cut it into separate clips",
  "take out the ums",
  "add captions and music",
  "grade it warm",
  "grade it cinematic",
  "make it black and white",
  "fade it in and out",
  "level the audio",
  "add motion to the titles",
  "zoom in on the important bits",
  "start with the strongest line",
  "put my music under it",
  "add sound effects on the cuts",
  "post it to tiktok",
  "translate the captions to english",
  "add b-roll",
  "remove the captions",
  "keep the full length and clean it up",
  "اقصص السكتات وضيف ترجمة",
  "خليه عمودي لتيك توك",
  "اعطيني اقوى 30 ثانية",
  "قسمه مقاطع",
  "شيل الاه والاممم",
  "لونه دافي",
  "خليه ابيض واسود",
  "ظبط الصوت",
  "حط موسيقى تحته",
  "ضيف حركة للعناوين",
  "قرب على الاشياء المهمة",
  "شيل الترجمة",
  "خليه بنفس الطول ونظفه",
];
for (const text of SENTENCES) {
  const intent = planFromText(text, { assets: [{ id: "a", kind: "audio", label: "beat.mp3" }] });
  gather("plan-from-text.ts", intent.willDo);
  gather("plan-from-text.ts (cannotYet)", intent.cannotYet);
}

/*
  The planner's describer, over every operation it can be handed. Driven from
  the operations rather than from sentences, because the model can produce an
  operation no sentence in the corpus above happens to reach.
*/
const OPERATIONS = [
  { type: "removeSilence", paddingMs: 80, thresholdDb: -32, minSilenceMs: 500 },
  { type: "removeFillers" },
  { type: "formatForPlatform", platform: "tiktok" },
  { type: "formatForPlatform", platform: "youtube" },
  { type: "formatForPlatform", platform: "square" },
  { type: "formatForPlatform", platform: "reels" },
  { type: "autoCaptions", dropFillers: true },
  { type: "grade", look: "cinematic", saturation: 1 },
  { type: "grade", look: "warm", saturation: 1 },
  { type: "grade", look: "bw", saturation: 0 },
  { type: "normalizeLoudness", targetLufs: -14, voice: true, denoise: true },
  { type: "transition", style: "dissolve", where: "scenes", durationMs: 250 },
  { type: "transition", style: "whipPan", where: "scenes", durationMs: 250 },
  { type: "transition", style: "flashBlack", where: "scenes", durationMs: 250 },
  { type: "fade", fadeInMs: 500, fadeOutMs: 500, inMs: 500, outMs: 500, durationMs: 500 },
  { type: "coldOpen", atSeconds: 30, fromSeconds: 30, seconds: 8, durationSeconds: 8 },
  { type: "extractHighlight", seconds: 30, targetSeconds: 30, durationSeconds: 30 },
  { type: "keepRange", fromSeconds: 80, toSeconds: 130 },
  { type: "punchIn", strength: 0.55, atSeconds: [3, 9] },
  { type: "musicUnder", assetId: "a", duckDb: -12 },
  { type: "sfx", on: "cuts" },
];
for (const op of OPERATIONS) {
  try {
    gather("planner.ts", describeAll([op]));
  } catch {
    /* an operation this build does not know is not this suite's business */
  }
}

/*
  And the director, which writes most of an ordinary reply and was for weeks
  the layer nothing read. Several inputs, because what it says depends on what
  it was given: a track changes the join, a hook changes the opening, length
  changes whether it restructures at all.
*/
const NOTHING_SPOKEN = {
  platform: false,
  captions: false,
  silence: false,
  music: false,
  coverage: false,
  sfx: false,
};
const BASE_DIRECTION = {
  platform: null,
  sourceSeconds: 600,
  hasSpeech: true,
  reading: null,
  assets: [],
  habits: [],
  spokenTypes: new Set(),
  spoke: NOTHING_SPOKEN,
  onlyWhatWasAsked: false,
};
const DIRECTIONS = [
  {},
  { platform: "tiktok", reading: { peaks: [], hook: { at: 30 }, chapters: 2, how: "model" } },
  { platform: "youtube", sourceSeconds: 3600, reading: { peaks: [], hook: null, chapters: 8, how: "model" } },
  {
    platform: "tiktok",
    assets: [{ id: "track", kind: "audio", label: "beat.mp3" }],
    reading: { peaks: [], hook: null, chapters: 2, how: "model" },
  },
  {
    platform: "square",
    sourceSeconds: 240,
    reading: { peaks: [{ start: 10, strength: 0.9 }], hook: { at: 5 }, chapters: 3, how: "model" },
  },
  { platform: "reels", sourceSeconds: 45, hasSpeech: false, reading: null },
];
for (const input of DIRECTIONS) {
  gather("direct.ts", direct({ ...BASE_DIRECTION, ...input }).willDo);
}

// Unique by the pair, so one phrase reached five ways is checked once.
const unique = [...new Map(phrases.map((p) => [`${p.en}|${p.ar}`, p])).values()];

section("There are phrases to read, from every layer that writes one");
{
  check("the corpus produced phrases", unique.length >= 40, String(unique.length));
  for (const layer of ["plan-from-text.ts", "planner.ts", "direct.ts"]) {
    check(
      `${layer} contributed some`,
      unique.some((p) => p.from.startsWith(layer)),
      "a layer that reaches willDo and is not in this corpus is a layer nothing reads",
    );
  }
}

// ─── English: read after "I'll " ─────────────────────────────────────────────

section('Every English phrase reads as a sentence after "I will "');
{
  /*
    A bare verb phrase, which after "I'll " is a sentence and inside "Here is
    what I will do:" is a line. The four ways that goes wrong are a subject in
    front of the verb, a tense already on it, a modal already there, and a
    finished sentence pasted in whole.
  */
  const SUBJECT = /^(?:i|we|it|you|he|she|they)\b/i;
  const MODAL = /^(?:will|would|can|could|shall|should|may|might|must)\b/i;
  /*
    -ing as the head word: "adding captions" reads "I'll adding captions".

    The stem has to be a word in its own right, or this flags "swing", "bring"
    and "sing" -- which it did, on a phrase that was perfectly correct. Three
    letters is the line: "add" is a verb, "sw" is not.
  */
  const GERUND = /^(\w{3,})ing\b/i;
  // A past tense we can actually detect: the regular -ed head word.
  const PAST = /^\w+ed\b/i;
  /*
    Three heads are exceptions and they are deliberate. "even out the sound"
    heads on a word that is part of its verb; "let" and "go" head phrasal verbs
    the -ed and -ing patterns have no opinion about. Listed rather than
    pattern-matched, so adding a fourth is a decision somebody makes here.
  */
  const ALLOWED_HEADS = new Set(["even", "let", "go"]);

  for (const p of unique) {
    const head = p.en.split(/\s+/)[0] ?? "";
    const label = `«${p.en.slice(0, 38)}${p.en.length > 38 ? "…" : ""}»`;
    check(`${label} has no subject in front of the verb`, !SUBJECT.test(p.en), `${p.from}: ${p.en}`);
    check(`${label} carries no modal of its own`, !MODAL.test(p.en), `${p.from}: ${p.en}`);
    check(
      `${label} heads on a plain verb`,
      ALLOWED_HEADS.has(head.toLowerCase()) || (!GERUND.test(p.en) && !PAST.test(p.en)),
      `${p.from}: ${p.en}`,
    );
    /*
      No full stop and no capital. Both are how a sentence written somewhere
      else looks when it is pasted into a list, and both read wrong in the
      frame: "I'll Take out the silent bits." is two mistakes in six words.
    */
    check(`${label} does not end in a full stop`, !/[.!?]$/.test(p.en.trim()), `${p.from}: ${p.en}`);
    check(
      `${label} does not open with a capital`,
      !/^[A-Z]/.test(p.en) || /^(?:TikTok|YouTube|Reels|Shorts|Instagram)\b/.test(p.en),
      `${p.from}: ${p.en}`,
    );
    // The house rule, which is easiest to break in a phrase written today.
    check(`${label} has no em dash`, !p.en.includes("—"), `${p.from}: ${p.en}`);
  }
}

// ─── Arabic: read after «رح» ─────────────────────────────────────────────────

section("وكل جملة عربية تُقرأ بعد «رح»");
{
  /*
    The Arabic frame is «رح:» above the list, or «تمام، رح <phrase>» for a
    single one. What follows «رح» is a first-person imperfect verb, which in
    this dialect takes the أ- prefix: أشيل, أكتب, أخلّي. Anything else reads as
    a noun phrase dangling off a future marker.

    The shape words are the one exception: «عريض», «مربّع», «عمودي» are
    adjectives that only ever appear inside «أخلّيه X لـY» and never alone.
  */
  const FIRST_PERSON = /^[\u0623\u0627\u0622]/;
  const SHAPE_WORDS = new Set(["عريض", "مربّع", "عمودي", "مربع"]);
  for (const p of unique) {
    const head = p.ar.split(/\s+/)[0] ?? "";
    const label = `«${p.ar.slice(0, 30)}${p.ar.length > 30 ? "…" : ""}»`;
    check(
      `${label} تبدأ بفعل بصيغة المتكلّم`,
      SHAPE_WORDS.has(head) || FIRST_PERSON.test(head),
      `${p.from}: ${p.ar}`,
    );
    check(`${label} بلا نقطة في آخرها`, !/[.!؟?]$/.test(p.ar.trim()), `${p.from}: ${p.ar}`);
    check(`${label} بلا شرطة طويلة`, !p.ar.includes("—"), `${p.from}: ${p.ar}`);
    /*
      And no English inside an Arabic phrase, with one class of exception: the
      platform names and the grade names are words people use in Arabic as they
      are, and translating "TikTok" helps nobody.
    */
    const stripped = p.ar
      // A filename is the person's own word for their own file. Quoting it and
      // then refusing it for being English would mean renaming their upload.
      .replace(/"[^"]*"|«[^»]*»/g, "")
      .replace(/tiktok|reels|shorts|youtube|square|instagram|snapchat|linkedin|facebook/gi, "")
      .replace(/warm|cool|cinematic|bw|vivid|flat/gi, "")
      .replace(/[0-9:.]/g, "");
    check(`${label} بلا إنجليزية`, !/[A-Za-z]{2}/.test(stripped), `${p.from}: ${p.ar}`);
  }
}

section("A platform is named the way its own logo names it");
{
  /*
    `op.platform` is a lowercase key -- `tiktok`, `youtube` -- and it used to be
    interpolated straight into the sentence, so the most-read line in the
    product read «أخلّيه عمودي لـtiktok»: an English word in lowercase, glued to
    an Arabic preposition by a connector that only exists because what followed
    was Latin script.

    Four lines further down, the same reply says it will write captions
    "because most people watch with the sound off". One of those two sentences
    was written for a person and the other was not, and they were in the same
    list.
  */
  /*
    The four brand keys, lowercase. Not `square`: that is also the shape word,
    and "make it square for a feed post" is the sentence working correctly.
    These four are names and a name is spelled the way its owner spells it.
  */
  const RAW_KEY = /\b(?:tiktok|youtube|reels|shorts)\b/;
  for (const p of unique) {
    if (!RAW_KEY.test(p.en) && !RAW_KEY.test(p.ar)) continue;
    const label = `«${p.en.slice(0, 34)}…»`;
    check(`${label} does not carry a lowercase key in the English`, !RAW_KEY.test(p.en), `${p.from}: ${p.en}`);
    check(`${label} nor in the Arabic`, !RAW_KEY.test(p.ar), `${p.from}: ${p.ar}`);
  }
  /*
    And the Arabic preposition attaches the ordinary way now, because what
    follows it is an Arabic word. «لـتيك توك» is a seam showing.
  */
  for (const p of unique) {
    check(
      `«${p.ar.slice(0, 30)}…» has no Latin connector before an Arabic word`,
      !/\u0644\u0640[\u0621-\u06ff]/.test(p.ar),
      `${p.from}: ${p.ar}`,
    );
  }
}

section("Both halves exist, and they are not the same string");
{
  for (const p of unique) {
    const label = `«${p.en.slice(0, 30)}${p.en.length > 30 ? "…" : ""}»`;
    check(`${label} has both halves`, p.en.trim().length > 0 && p.ar.trim().length > 0, p.from);
    check(`${label} is not the English twice`, p.en !== p.ar, p.from);
  }
}

await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("Every promise reads as a sentence in the frame it is read in.");
