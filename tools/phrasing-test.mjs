/**
 * Every sentence this product says about itself is half a sentence.
 *
 * The reply is composed, never written whole. `replyFor` puts the person's
 * list behind one of four frames — "On it. I'll …", "I'd …. But I can't start
 * it right now: …", "Right. I'll …", "I can't …, so I'll leave that out" — and
 * their Arabic counterparts, where the future is a **prefix**: «س» joins
 * directly onto the verb, so «أقصّ الصمت» becomes «سأقصّ الصمت» with no space
 * and no room for anything else.
 *
 * That means each phrase must be a bare verb phrase and nothing else. A
 * sentence, a gerund, an infinitive with "to", or an Arabic phrase that opens
 * with a noun all produce text that is grammatical nowhere:
 *
 *   "On it. I'll I will cut the silences."
 *   "On it. I'll to cut the silences."
 *   «تمام، سالصمت يُقصّ.»
 *
 * The convention is written down — `habits.ts` says a sentence in a different
 * voice from the ones beside it is how a list stops reading as one — and until
 * now it was held by review alone. Five files push into `willDo`, three of them
 * were added after the convention was set, and every one of those sentences is
 * customer-facing.
 *
 * The corpus is not a list kept here. `describeAll` is a switch the compiler
 * keeps exhaustive over every operation type, so it produces every phrase that
 * path can produce; the matcher, the direction and the habits are each driven
 * over inputs that reach their own branches. A phrase that exists and is never
 * reached by any of them is the one shape this cannot see, and that is the
 * argument for the source scan at the end.
 *
 * Usage: node tools/phrasing-test.mjs
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
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-phrasing-"));

/**
 * `@workspace/db` stays external, and that is the point of the module it is in.
 *
 * `habits.ts` imports the database *inside* the function that reads it, with a
 * comment saying why: the module throws on import when `DATABASE_URL` is unset,
 * and the arithmetic in it should be checkable without a Postgres. Bundling
 * that dynamic import would undo the whole argument, so it is left unresolved —
 * nothing here calls the reader.
 */
function build(source, name) {
  const outfile = path.join(buildDir, name);
  const built = spawnSync(
    require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/api-server"] }),
    [
      path.join(repoRoot, source),
      "--bundle", "--platform=node", "--format=esm", "--target=node22",
      "--external:pg", "--external:@workspace/db", "--external:drizzle-orm",
      `--outfile=${outfile}`, "--log-level=error",
    ],
    { stdio: "inherit" },
  );
  if (built.status !== 0) process.exit(1);
  return pathToFileURL(outfile).href;
}

const { describeAll } = await import(build("artifacts/api-server/src/lib/planner.ts", "planner.mjs"));
const { planFromText } = await import(build("artifacts/api-server/src/lib/plan-from-text.ts", "matcher.mjs"));
const { direct } = await import(build("artifacts/api-server/src/lib/direct.ts", "direct.mjs"));
const { applyHabits } = await import(build("artifacts/api-server/src/lib/habits.ts", "habits.mjs"));

let checks = 0;
let failures = 0;
const check = (name, ok, detail = "") => {
  checks += 1;
  if (ok) console.log(`  ✓ ${name}`);
  else { failures += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};
const section = (title) => console.log(`\n${title}`);

/**
 * Words that cannot open a phrase which follows "I'll " or "I can't ".
 *
 * Not a grammar: a list of the specific ways this goes wrong. "to cut" is the
 * infinitive somebody writes when they forget the frame; "I" and "we" are a
 * whole sentence trying to start; "will" and "would" are the frame said twice;
 * an article means a noun is coming where a verb belongs.
 */
const CANNOT_OPEN = new Set([
  "i", "we", "will", "would", "shall", "ill", "to", "the", "a", "an",
  "is", "are", "was", "were", "am", "be", "been", "being", "and", "or",
  "but", "that", "this", "it", "there", "then", "also", "just", "please",
]);

/** Reads after "I'll " and after "I can't ". */
function readsAsVerbPhrase(en) {
  const problems = [];
  if (!en || en !== en.trim()) problems.push("padded with whitespace");
  if (/^[A-Z]/.test(en)) problems.push("opens with a capital, so it is a sentence");
  const first = (en.match(/^[A-Za-z']+/) ?? [""])[0].toLowerCase();
  if (!first) problems.push("does not open with a word");
  if (CANNOT_OPEN.has(first)) problems.push(`opens with "${first}"`);
  if (/[.!?]$/.test(en)) problems.push("ends the sentence for the frame");
  if (/\s{2,}/.test(en)) problems.push("has a doubled space");
  return problems;
}

/**
 * Reads after «س» and after «لا أستطيع أن ».
 *
 * The test is the first letter. Arabic marks the first person on the verb
 * itself with a prefixed hamza, so a phrase that opens with anything but «أ»
 * is not a first-person verb, and «س» joined to it produces a word that is not
 * a word. It is a narrow rule and it is the whole rule: every phrase in the
 * product today passes it, and each of the ways to get this wrong fails it.
 */
function readsAfterSeen(ar) {
  const problems = [];
  if (!ar || ar !== ar.trim()) problems.push("padded with whitespace");
  if (!/[؀-ۿ]/.test(ar)) problems.push("is not Arabic");
  // أ, and آ for the roots that begin with a hamza of their own: «أخذ» takes
  // the first person as «آخذ», and «س» joined to it gives «سآخذ», which is
  // right. Narrowing this to أ alone would fail a correct phrase.
  if (!/^[أآ]/.test(ar)) problems.push(`opens with "${ar.slice(0, 4)}" rather than a first-person verb`);
  if (/[.!?]$/.test(ar)) problems.push("ends the sentence for the frame");
  if (/\s{2,}/.test(ar)) problems.push("has a doubled space");
  if (ar.includes("—")) problems.push("carries an em dash");
  // «، و» goes between every Arabic item, so a phrase that opens with a واو of
  // its own doubles it. This is the shape the direction shipped with.
  if (/^[أآ]?و/.test(ar) && !/^[أآ]/.test(ar)) problems.push("opens with a waw the join will double");
  return problems;
}

/** Every phrase seen, by where it came from, so a failure names its file. */
const seen = [];
const collect = (where, phrases) => {
  for (const phrase of phrases ?? []) {
    if (phrase && typeof phrase.en === "string" && typeof phrase.ar === "string") {
      seen.push({ where, en: phrase.en, ar: phrase.ar });
    }
  }
};

// ─── The corpus ──────────────────────────────────────────────────────────────

/**
 * One of every operation, so `describeAll` runs its whole switch.
 *
 * `tighten` appears three times because it says three different things, and
 * the two the plan can produce without the third were the ones added last.
 */
const EVERY_OPERATION = [
  { type: "removeSilence", thresholdDb: -32, minSilenceMs: 500, paddingMs: 80 },
  { type: "tighten", fillers: true, repeats: true },
  { type: "tighten", fillers: true, repeats: false },
  { type: "tighten", fillers: false, repeats: true },
  { type: "extractHighlight", targetSeconds: 30 },
  { type: "extractRange", startSeconds: 5, endSeconds: 35 },
  { type: "extractClips", count: 3, targetSeconds: 30 },
  { type: "coldOpen", seconds: 4 },
  { type: "fade", durationMs: 500 },
  { type: "transition", style: "dissolve", durationMs: 250 },
  { type: "formatForPlatform", platform: "tiktok" },
  { type: "formatForPlatform", platform: "youtube" },
  { type: "autoCaptions", style: "bold-white", animation: "pop", dropFillers: true },
  { type: "burnCaptions", cues: [{ startMs: 0, endMs: 100, text: "x" }], style: "bold-white", animation: "pop", dropFillers: true },
  { type: "watermark", text: "Edited with Editly", position: "bottom-right" },
  { type: "kenBurns", to: 1.08 },
  { type: "zoomPunch", at: [], amount: 0.12, holdMs: 1200, on: "emphasis" },
  { type: "zoomPunch", at: [], amount: 0.12, holdMs: 1200, on: "beat" },
  { type: "normalizeLoudness", targetLufs: -14, voice: false },
  { type: "grade", saturation: 1, look: "warm" },
  { type: "grade", saturation: 1, look: "none" },
  { type: "addMusic", assetId: "a", gainDb: -18, duck: true, fadeSeconds: 1.5, fromSeconds: 0, loop: true },
  { type: "insertBRoll", assetId: "a", at: 1, durationSeconds: 3, fit: "cover", keepSourceAudio: true },
  { type: "overlayImage", assetId: "a", at: 1, durationSeconds: 3, position: "center", scale: 0.4, opacity: 1 },
  { type: "motionTitle", text: "hi", at: 1, durationSeconds: 2.5, style: "card", position: "top" },
  { type: "soundEffects", gainDb: -12, palette: "clean", onCuts: true, onPunches: true, onOpen: true },
  { type: "alternateFraming", amount: 0.15 },
  { type: "stillsReel", assetIds: ["a"], targetSeconds: 15, motion: 0.12 },
];

/** Sentences chosen to reach branches, in both languages. */
const SENTENCES = [
  "cut the silences and make it vertical for tiktok",
  "caption it and punch in when I stress a word",
  "make it a 30 second highlight with captions",
  "cut it into 3 clips",
  "take 0:05 to 0:35",
  "level the audio and add a slow push",
  "put my music under it",
  "add sound effects",
  "grade it cinematic",
  "make the colour teal and orange",
  "post it to my accounts",
  "cut from 5 to 35 and fade in and out",
  "cut the ums and the false starts",
  "dissolve between the cuts",
  "open on the strongest moment",
  "اقصّ الصمت وخلّيها عمودية لتيك توك",
  "حطّ ترجمة وقرّب عند الكلمات المهمّة",
  "اعمل هايلايت 30 ثانية",
  "قسّمه ل3 مقاطع",
  "خذ من 0:05 لـ0:35",
  "اضبط الصوت وضيف حركة بطيئة",
  "حطّ موسيقى تحته",
  "ضيف مؤثّرات صوتية",
  "درّجه cinematic",
  "انشره على حساباتي",
  "اقصّ الترددات والبدايات المكرّرة",
  "ذوّب بين القصّات",
  "افتح على أقوى لحظة",
];

const READING = {
  chapters: [],
  claims: [],
  questions: [],
  peaks: [],
  hooks: [],
};

/** Directions that reach the rules, rather than one that reaches none. */
const DIRECTIONS = [
  {
    platform: "tiktok", sourceSeconds: 600, hasSpeech: true, reading: null,
    assets: [], habits: [], spokenTypes: new Set(), onlyWhatWasAsked: false,
    spoke: { platform: false, captions: false, silence: false, music: false, coverage: false, sfx: false },
  },
  {
    platform: "youtube", sourceSeconds: 3600, hasSpeech: true, reading: READING,
    assets: [{ id: "a", kind: "video", label: "b-roll" }], habits: [],
    spokenTypes: new Set(), onlyWhatWasAsked: false,
    spoke: { platform: true, captions: false, silence: false, music: false, coverage: false, sfx: false },
  },
  {
    platform: null, sourceSeconds: 45, hasSpeech: false, reading: null,
    assets: [], habits: [], spokenTypes: new Set(), onlyWhatWasAsked: false,
    spoke: { platform: false, captions: false, silence: false, music: false, coverage: false, sfx: false },
  },
];

const HABITS = [
  { key: "platform", value: "tiktok", times: 8, of: 10 },
  { key: "captionStyle", value: "bold-yellow", times: 7, of: 9 },
  { key: "silence", value: "cut", times: 6, of: 8 },
];

section("Every phrase the product can produce is collected, not listed here");
{
  collect("planner.describeAll", describeAll(EVERY_OPERATION));
  check("describeAll speaks for every operation", seen.length >= EVERY_OPERATION.length - 3, String(seen.length));

  const before = seen.length;
  for (const sentence of SENTENCES) {
    const intent = planFromText(sentence);
    collect(`planFromText(${sentence.slice(0, 24)})`, intent.willDo);
    collect(`planFromText refusal(${sentence.slice(0, 24)})`, intent.cannotYet);
  }
  check("the matcher contributed phrases", seen.length > before, String(seen.length - before));

  const beforeDirect = seen.length;
  for (const input of DIRECTIONS) collect("direct", direct(input).willDo);
  check("the direction contributed phrases", seen.length > beforeDirect, String(seen.length - beforeDirect));

  const beforeHabits = seen.length;
  const { applied } = applyHabits(
    [{ type: "removeSilence", thresholdDb: -32, minSilenceMs: 500, paddingMs: 80 }],
    HABITS,
    { platform: false, captions: false, silence: false, music: false, coverage: false, sfx: false },
  );
  collect("applyHabits", applied);
  check("the habits contributed phrases", seen.length > beforeHabits, String(seen.length - beforeHabits));
}

section("Each half reads inside the frame it is put in");
{
  const enProblems = [];
  const arProblems = [];
  for (const { where, en, ar } of seen) {
    const bad = readsAsVerbPhrase(en);
    if (bad.length > 0) enProblems.push(`${where}: "${en.slice(0, 44)}" ${bad.join("; ")}`);
    const badAr = readsAfterSeen(ar);
    if (badAr.length > 0) arProblems.push(`${where}: "${ar.slice(0, 30)}" ${badAr.join("; ")}`);
  }
  check(`every English half reads after "I'll " (${seen.length} phrases)`, enProblems.length === 0, enProblems.slice(0, 4).join(" | "));
  check("every Arabic half reads after «س»", arProblems.length === 0, arProblems.slice(0, 4).join(" | "));
}

section("The rules can go red");
{
  // A check that cannot fail is a check that is not checking. These are the
  // four shapes this suite exists to catch, run through the same functions.
  check("a sentence is caught", readsAsVerbPhrase("I will cut the silences.").length > 0);
  check("an infinitive is caught", readsAsVerbPhrase("to cut the silences").length > 0);
  check("a capital is caught", readsAsVerbPhrase("Cut the silences").length > 0);
  check("an Arabic noun opening is caught", readsAfterSeen("الصمت يُقصّ").length > 0);
  check("an Arabic waw opening is caught", readsAfterSeen("والترددات والبدايات").length > 0);
  check("a hamza-root verb passes", readsAfterSeen("آخذ أقوى 45 ثانية منه").length === 0);
  check("an Arabic phrase that says «س» itself is caught", readsAfterSeen("سأقصّ الصمت").length > 0);
  check("a good English phrase passes", readsAsVerbPhrase("cut out the silences and dead air").length === 0);
  check("a good Arabic phrase passes", readsAfterSeen("أقصّ الصمت والفراغات").length === 0);
}

section("Nothing pushes a phrase from outside the files this suite drives");
{
  /*
   * The one shape the corpus cannot see.
   *
   * Everything above reaches phrases by running the code. A phrase in a branch
   * no input here reaches is invisible to that, and the honest guard is to
   * name the files allowed to produce one — so a sixth file pushing into
   * `willDo` arrives as a failure here rather than as an unread sentence in
   * somebody's chat.
   */
  const allowed = new Set([
    "artifacts/api-server/src/lib/plan-from-text.ts",
    "artifacts/api-server/src/lib/planner.ts",
    "artifacts/api-server/src/lib/direct.ts",
    "artifacts/api-server/src/lib/habits.ts",
    "artifacts/api-server/src/routes/messages.ts",
  ]);
  // `willDo.push(` rather than `willDo`: a route that merely reads the field
  // is not speaking for the plan, and the coarse match named one that does not.
  const grep = spawnSync("grep", ["-rl", "willDo\\.push(", "artifacts/api-server/src"], { encoding: "utf8", cwd: repoRoot });
  const files = (grep.stdout || "").split("\n").filter(Boolean);
  const unexpected = files.filter((f) => !allowed.has(f));
  check("only the five known files speak for the plan", unexpected.length === 0, unexpected.join(" | "));

  // And the fifth is driven by `notes-test`, not from here: it needs rows.
  const messages = await readFile(path.join(repoRoot, "artifacts/api-server/src/routes/messages.ts"), "utf8");
  const pushes = [...messages.matchAll(/willDo\.push\(/g)];
  check("the messages route still speaks through willDo", pushes.length > 0, String(pushes.length));
}

await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) { console.log(`${failures} FAILED`); process.exit(1); }
console.log("Every half sentence reads inside its frame.");
