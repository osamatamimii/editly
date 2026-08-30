/**
 * Can this product be asked, in Arabic, for the things it can do?
 *
 * The founder is Arabic-speaking and so are the first users. Every operation in
 * here was built to be reached from a sentence, and the matcher is the only way
 * a sentence becomes a plan on a deployment with no model key — which is this
 * one. So an operation with no Arabic way to ask for it is not a translation
 * gap. It is a feature that does not exist for the people it was built for.
 *
 * The last round found that «اقصّ الصمت وخليها عمودية» produced *nothing*, and
 * fixed those two. This suite asks the question that finding implied: which
 * others? The answer was captions — the most-asked-for edit there is —
 * plus punch-ins, the slow push, levelling the audio, and the whole highlight
 * cut. All of them worked in English. None could be asked for in Arabic.
 *
 * Three properties:
 *
 *   1. PARITY. For each capability, an English sentence and an Arabic sentence
 *      that mean the same thing produce the same operations — and where the
 *      answer is a refusal, the same refusal. Not a similar one: the same.
 *
 *   2. COVERAGE. Every operation type this matcher can emit appears in the
 *      table below. Read out of the source rather than listed by hand, so a
 *      new English-only operation cannot ship past this file quietly. That is
 *      the same trick `deploy-test` plays on the workflow's suite list, and it
 *      is the only kind of check that keeps working after everyone forgets it.
 *
 *   3. HONESTY. The refusals read as English sentences. This is here because
 *      they did not: every label already ended in "yet" and the reply appended
 *      another, so the product's most careful sentence — the one where it
 *      admits a limit — came out as "no clips to cut to yet yet".
 *
 * Usage: node tools/bilingual-test.mjs
 * Requires: nothing. No keys, no network, no ffmpeg.
 */
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const source = "artifacts/api-server/src/lib/plan-from-text.ts";
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-bilingual-"));
const outfile = path.join(buildDir, "matcher.mjs");

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
  console.error("could not bundle the matcher");
  process.exit(1);
}

const { planFromText, replyFor } = await import(pathToFileURL(outfile).href);

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

const typesOf = (text) => (planFromText(text).operations ?? []).map((o) => o.type).sort().join(",");
const refusalsOf = (text) => (planFromText(text).cannotYet ?? []).map((p) => p.en).sort().join(" | ");
const refusalsArOf = (text) => (planFromText(text).cannotYet ?? []).map((p) => p.ar).sort().join(" | ");

/**
 * The pairs.
 *
 * `expect` names the operations the pair must produce, so a check cannot pass
 * by both languages being equally broken — which is exactly what "the same
 * output" would have allowed, and is how a parity check quietly stops testing
 * anything. Where the honest answer is a refusal, `refuses` names a phrase
 * that must appear in it, in both languages.
 *
 * The Arabic is written the way people type, not the way a dictionary would:
 * «اقصّ» with its shadda and «اقص» without, «عمودي» and the Levantine
 * «عامودي», «ضيف» rather than the formal «أضف».
 */
const PAIRS = [
  {
    what: "captions",
    en: "add captions to this",
    ar: "ضيف ترجمة على الفيديو",
    expect: ["autoCaptions"],
  },
  {
    what: "captions, said as subtitles",
    en: "put subtitles on it",
    ar: "حط سبتايتل على الفيديو",
    expect: ["autoCaptions"],
  },
  {
    what: "captions, word by word",
    en: "karaoke captions word by word",
    ar: "ترجمة كلمة كلمة",
    expect: ["autoCaptions"],
    also: (plan) => plan.operations[0]?.animation === "karaoke",
    alsoName: "and both ask for the karaoke animation",
  },
  {
    what: "captions in yellow",
    en: "captions in yellow",
    ar: "ترجمة باللون الأصفر",
    expect: ["autoCaptions"],
    also: (plan) => plan.operations[0]?.style === "bold-yellow",
    alsoName: "and both ask for the yellow style",
  },
  {
    what: "cutting the silence",
    en: "cut the silence out",
    ar: "اقصّ الصمت",
    expect: ["removeSilence"],
  },
  {
    what: "going vertical",
    en: "make it vertical",
    ar: "خليها عمودية",
    expect: ["formatForPlatform"],
  },
  {
    what: "vertical for a platform by name",
    en: "cut it for tiktok",
    ar: "جهزها للتيك توك",
    expect: ["formatForPlatform"],
  },
  {
    what: "punch-in zooms",
    en: "add some zoom punches for energy",
    ar: "زوم على الكلام المهم",
    expect: ["zoomPunch"],
  },
  {
    what: "the slow push",
    en: "give it a slow push",
    ar: "حركة بطيئة على الصورة",
    expect: ["kenBurns"],
  },
  {
    what: "levelling the audio",
    en: "level the audio",
    ar: "عدّل الصوت",
    expect: ["normalizeLoudness"],
  },
  {
    what: "a named look",
    en: "give it a cinematic look",
    ar: "لون سينمائي",
    expect: ["grade"],
  },
  {
    what: "the strongest stretch, opened on",
    en: "start with the strongest moment",
    ar: "ابدأ بأقوى لحظة",
    expect: ["coldOpen", "extractHighlight"],
  },
  {
    what: "a soft join between the cuts",
    en: "add a dissolve between the cuts",
    ar: "انتقال ناعم بين المقاطع",
    expect: ["transition"],
  },
  {
    what: "music with nothing uploaded",
    en: "add background music",
    ar: "ضيف موسيقى خلفية",
    expect: [],
    refuses: "upload the track you have the rights to",
  },
  {
    what: "B-roll with no clips",
    en: "cut in some b-roll",
    ar: "ضيف لقطات مساندة",
    expect: [],
    refuses: "no clips to cut to",
  },
  {
    what: "a logo with no images",
    en: "put my logo on it",
    ar: "حط الشعار عليه",
    expect: [],
    refuses: "no images",
  },
  {
    what: "cutting it into clips",
    en: "cut it into separate clips",
    ar: "قسّمها إلى مقاطع منفصلة",
    expect: ["extractClips"],
  },
  {
    what: "a stretch named by the clock",
    en: "keep from 1:20 to 2:10",
    ar: "خذ من 1:20 إلى 2:10",
    expect: ["extractRange"],
  },
  {
    what: "fading the ends",
    en: "fade it in and out",
    ar: "خليها تتلاشى في البداية والنهاية",
    expect: ["fade"],
  },
  {
    // Emojis left the "cannot yet" list this round, and what is left in its
    // place is a refusal with a *fix* in it: type the ones you want. Which
    // makes this pair a check that the fix is bilingual — a way out named only
    // in English is not a way out for the half of the users who wrote Arabic.
    what: "emojis nobody typed",
    en: "add emojis",
    ar: "ضيف إيموجي",
    expect: [],
    refuses: "type the ones you want",
  },
  {
    what: "an emoji they did type",
    en: "add the emoji 🔥",
    ar: "ضيف الإيموجي 🔥",
    expect: ["motionTitle"],
  },
  {
    // The refusal did not disappear this round, it moved: cutting to the beat
    // needs a bed, and these pairs are planned against an empty library. Which
    // makes this the pair that checks the *reason* is bilingual, not just the
    // "no" — the reason names the fix, and a fix named only in English is a
    // dead end for the half of the users who wrote in Arabic.
    what: "cutting to the beat with nothing to cut against",
    en: "cut it to the beat",
    ar: "قص على الإيقاع",
    expect: [],
    refuses: "no music to cut to",
  },
];

console.log("\nthe same ask, in both languages");
for (const pair of PAIRS) {
  const en = planFromText(pair.en);
  const ar = planFromText(pair.ar);
  const wanted = [...pair.expect].sort().join(",");

  check(
    `${pair.what}: English produces ${wanted || "no operations"}`,
    typesOf(pair.en) === wanted,
    `got ${typesOf(pair.en) || "none"}`,
  );
  check(
    `${pair.what}: and «${pair.ar}» produces the same`,
    typesOf(pair.ar) === wanted,
    `got ${typesOf(pair.ar) || "none"}`,
  );

  if (pair.refuses) {
    check(
      `${pair.what}: refused in English, and the reason is named`,
      // Case-insensitive: these fragments sit mid-sentence in some refusals and
      // open one in others, and which it is has changed with the prose. The
      // check is that the fix is named, not how it is capitalised.
      refusalsOf(pair.en).toLowerCase().includes(pair.refuses.toLowerCase()),
      refusalsOf(pair.en) || "no refusal at all",
    );
    check(
      `${pair.what}: refused in Arabic with the same words, not a shrug`,
      refusalsOf(pair.ar) === refusalsOf(pair.en),
      `EN ${refusalsOf(pair.en)} / AR ${refusalsOf(pair.ar) || "«I'm not sure what to change»"}`,
    );
  } else {
    check(
      `${pair.what}: and neither language withholds anything`,
      en.cannotYet.length === 0 && ar.cannotYet.length === 0,
      JSON.stringify([en.cannotYet, ar.cannotYet]),
    );
  }

  if (pair.also) {
    check(`${pair.what}: ${pair.alsoName}`, pair.also(en) && pair.also(ar));
  }
}

/**
 * Coverage: the table above must name every operation the matcher can emit.
 *
 * Read out of the source, because a list written by hand is a list that is
 * right on the day it is written. `insertBRoll`, `overlayImage`, `addMusic`
 * and `motionTitle` are reached only with a file in the project, so the pairs
 * cover their *refusals* instead — which is the branch an Arabic speaker with
 * an empty library actually hits, and the one that was falling through to the
 * generic shrug.
 */
console.log("\nnothing gets built in English only");
const text = await readFile(path.join(repoRoot, source), "utf8");
const emitted = new Set([...text.matchAll(/operations\.push\(\{\s*\n?\s*type: "(\w+)"/g)].map((m) => m[1]));
const NEEDS_A_FILE = new Set(["insertBRoll", "overlayImage", "addMusic", "motionTitle"]);
const covered = new Set(PAIRS.flatMap((p) => p.expect));

check("the matcher's operations were found in the source at all", emitted.size >= 8, `${emitted.size} found`);
for (const type of [...emitted].sort()) {
  if (NEEDS_A_FILE.has(type)) {
    check(`${type} needs a file, so its refusal is the pair instead`, true);
    continue;
  }
  check(`${type} has an Arabic sentence that reaches it`, covered.has(type), "add a pair for it above");
}

/**
 * Honesty: the refusal has to read like a sentence.
 *
 * "yet yet" is the specific failure this caught, but the check is written
 * against doubled words generally, because the next one will not be "yet".
 */
console.log("\nthe refusals read like English");
const SPOKEN = [
  "add background music",
  "cut in some b-roll and put my logo on it",
  "add emojis",
  "translate it to english",
  "ضيف موسيقى خلفية",
  "ترجم الفيديو للإنجليزي",
];
for (const sentence of SPOKEN) {
  const reply = replyFor(planFromText(sentence), { hasVideo: true });
  check(
    `«${sentence}» is answered with a refusal, not a shrug`,
    /I can't |لا أستطيع أن /.test(reply),
    reply.slice(0, 120),
  );
  check(
    `«${sentence}» says no word twice in a row`,
    !/\b(\w+) \1\b/i.test(reply),
    (reply.match(/\b(\w+) \1\b/i) ?? [])[0] ?? "",
  );
}

/**
 * The one word that is two requests.
 *
 * «ترجمة» is captions; «ترجم» is translate. They share four letters, and the
 * caption pattern matches both. Getting this wrong does not produce nothing —
 * it produces a finished file with same-language captions, handed over as
 * though it were the thing that was asked for.
 */
console.log("\nترجمة is captions; ترجم is a translation we do not do");
for (const asked of ["ترجم الفيديو للإنجليزي", "translate it to english", "dub it in english"]) {
  const plan = planFromText(asked);
  check(`«${asked}» is refused`, /another language/.test(refusalsOf(asked)), refusalsOf(asked) || "nothing");
  check(
    `«${asked}» does not quietly caption it instead`,
    !plan.operations.some((o) => o.type === "autoCaptions"),
    typesOf(asked),
  );
}
for (const asked of ["ضيف ترجمة", "ترجمة عربية على الفيديو"]) {
  check(
    `«${asked}» is still read as captions`,
    planFromText(asked).operations.some((o) => o.type === "autoCaptions"),
    typesOf(asked),
  );
}

/**
 * "slow zoom" is the gentle one.
 *
 * PUSH_WORDS has always named it. PUNCH_WORDS' bare \bzoom was tested first
 * and ate it, so the one phrase that unambiguously means *gentle* was the one
 * phrase that produced punch-ins. The intent was written down and the order
 * defeated it — which is a bug no amount of reading the patterns would find.
 */
console.log("\nthe more specific pattern is read first");
check("«slow zoom» is a drift, not a hit", typesOf("slow zoom") === "kenBurns", typesOf("slow zoom"));
check("«زوم بطيء» is a drift too", typesOf("زوم بطيء") === "kenBurns", typesOf("زوم بطيء"));
check("«zoom punches» is still a hit", typesOf("zoom punches") === "zoomPunch", typesOf("zoom punches"));
check("«energetic» is still a hit", typesOf("energetic") === "zoomPunch", typesOf("energetic"));

/**
 * A whole sentence, the way it would actually be typed.
 */
console.log("\nsentences, not keywords");
const SENTENCES = [
  ["اقصّ الصمت، ضيف ترجمة، وخليها عمودية للتيك توك", ["autoCaptions", "formatForPlatform", "removeSilence"]],
  ["cut the silence, caption it, and make it vertical for tiktok", ["autoCaptions", "formatForPlatform", "removeSilence"]],
  ["ابدأ بأقوى لحظة وعدّل الصوت", ["coldOpen", "extractHighlight", "normalizeLoudness"]],
];
for (const [sentence, expect] of SENTENCES) {
  check(
    `«${sentence}»`,
    typesOf(sentence) === [...expect].sort().join(","),
    `got ${typesOf(sentence) || "nothing at all"}`,
  );
}

/**
 * The digits an Arabic keyboard types.
 *
 * ٠-٩ are the same numbers to a reader and different characters to a regex,
 * and every number pattern in the matcher was written against 0-9. So the
 * count in «قسّمها إلى ٥ مقاطع» was not misread — it was not read at all, and
 * quietly replaced by the default of three. The person asked for five, got
 * three, and was told it was done. That is the failure worth a suite of its
 * own: not a refusal, an answer.
 */
console.log("\nthe numbers an Arabic keyboard types");
const { parseClips, parseRange } = await import(pathToFileURL(outfile).href);
check("«قسّمها إلى ٥ مقاطع» is five clips, not the default three",
  parseClips("قسّمها إلى ٥ مقاطع")?.count === 5, JSON.stringify(parseClips("قسّمها إلى ٥ مقاطع")));
check("and the same ask in ASCII digits agrees",
  parseClips("قسّمها إلى 5 مقاطع")?.count === 5, JSON.stringify(parseClips("قسّمها إلى 5 مقاطع")));
check("«من ١:٢٠ إلى ٢:١٠» is the same stretch as 1:20 to 2:10",
  JSON.stringify(parseRange("من ١:٢٠ إلى ٢:١٠")) === JSON.stringify(parseRange("from 1:20 to 2:10")),
  JSON.stringify([parseRange("من ١:٢٠ إلى ٢:١٠"), parseRange("from 1:20 to 2:10")]));
check("«أول ٤٠ ثانية» is the first forty seconds",
  parseRange("أول ٤٠ ثانية")?.endSeconds === 40, JSON.stringify(parseRange("أول ٤٠ ثانية")));
check("and «أول 40 ثانية» too — \\b never matched before an Arabic letter",
  parseRange("أول 40 ثانية")?.endSeconds === 40, JSON.stringify(parseRange("أول 40 ثانية")));
check("«split it into 6 pieces» is six, which English could not ask for either",
  parseClips("split it into 6 pieces")?.count === 6, JSON.stringify(parseClips("split it into 6 pieces")));
check("«cut it into separate clips» is heard at all — the reply advertises it",
  parseClips("cut it into separate clips") !== null, "the fallback reply offers this exact phrase");

/**
 * Their words come back as they typed them. The normalisation is for matching
 * and must not reach anything echoed — a title in quotes is theirs.
 */
const titled = planFromText('ضع العنوان "٥ أسرار"');
check("a title in quotes keeps the digits they typed",
  titled.operations.some((o) => o.type === "motionTitle" && o.text === "٥ أسرار"),
  JSON.stringify(titled.operations.map((o) => o.text)));

/**
 * The reply answers in the language it was asked in.
 *
 * Round 34 made «ضيف ترجمة» produce captions. It still answered "Right — I'll
 * caption it from what is actually said." — in English, to somebody who had
 * just written Arabic. The matcher understood and the product replied in a
 * language the person had not used, which is its own kind of not listening.
 *
 * The checks below are written against the *frames* rather than the notes,
 * because a half-translated reply — an Arabic sentence with an English clause
 * inside it — is the failure mode this will actually have, and it reads worse
 * than either language on its own.
 */
console.log("\nthe reply answers in the language it was asked in");

// The opening words of each reply the matcher can produce, in each language.
// They carried em dashes until the punctuation was taken out of the product's
// writing; what they are testing is which language answered, so the frames
// follow the prose rather than pinning a dash.
const ENGLISH_FRAMES = [/\bOn it\. I'll /, /\bRight\. I'll /, /\bI can't /, /\bI'd .* But I can't/, /I'm not sure what to change/, /Upload a video first/];
const ARABIC_FRAMES = [/تمام، س/, /لا أستطيع أن /, /كنت س/, /لست متأكّدًا/, /ارفع فيديو أوّلًا/];
const hasAny = (patterns, text) => patterns.some((p) => p.test(text));

const REPLY_CASES = [
  { what: "a plan that starts rendering", ctx: { hasVideo: true, render: { started: true } },
    en: "cut the silence and caption it", ar: "اقصّ الصمت وضيف ترجمة" },
  { what: "a plan waiting on the button", ctx: { hasVideo: true },
    en: "cut the silence", ar: "اقصّ الصمت" },
  { what: "a render that could not start", ctx: { hasVideo: true, render: { started: false, because: "a render is already running" } },
    en: "cut the silence", ar: "اقصّ الصمت" },
  { what: "a refusal", ctx: { hasVideo: true },
    en: "add background music", ar: "ضيف موسيقى خلفية" },
  { what: "a sentence we could not read", ctx: { hasVideo: true },
    en: "asdfgh qwerty", ar: "شي حلو بسرعة كذا" },
  { what: "an empty project", ctx: { hasVideo: false },
    en: "cut the silence", ar: "اقصّ الصمت" },
];

for (const c of REPLY_CASES) {
  const english = replyFor(planFromText(c.en), c.ctx);
  const arabic = replyFor(planFromText(c.ar), c.ctx);

  check(`${c.what}: the English ask is answered in English`,
    hasAny(ENGLISH_FRAMES, english) && !hasAny(ARABIC_FRAMES, english), english.slice(0, 100));
  check(`${c.what}: the Arabic ask is answered in Arabic`,
    hasAny(ARABIC_FRAMES, arabic) && !hasAny(ENGLISH_FRAMES, arabic), arabic.slice(0, 100));
  check(`${c.what}: and the Arabic reply is not half-English`,
    !/\b(?:and|the|it|with|from|into|your|so I'll|rather than)\b/.test(arabic), arabic.slice(0, 160));
}

/**
 * A mixed sentence is an Arabic sentence. Somebody who typed any Arabic reads
 * Arabic, and there is no setting for this because they already told us.
 */
check("a sentence with Arabic and English in it is answered in Arabic",
  hasAny(ARABIC_FRAMES, replyFor(planFromText("اقصّ الصمت and make it vertical"), { hasVideo: true })),
  replyFor(planFromText("اقصّ الصمت and make it vertical"), { hasVideo: true }).slice(0, 120));

/**
 * Arabic joins lists with و, not with a Latin comma and a trailing "and".
 * Punctuation is the tell that a page was translated rather than written.
 */
const three = replyFor(planFromText("اقصّ الصمت وضيف ترجمة وخليها عمودية"), { hasVideo: true });
check("three things are joined the way Arabic joins them", /، و/.test(three) && !/, and /.test(three), three.slice(0, 160));

/** Both halves exist for every note a real sentence can produce. */
console.log("\nno note has one half missing");
for (const pair of PAIRS) {
  for (const asked of [pair.en, pair.ar]) {
    const plan = planFromText(asked);
    const notes = [...plan.willDo, ...plan.cannotYet];
    check(`«${asked}» — every note carries both languages`,
      notes.every((n) => typeof n.en === "string" && n.en.length > 0 && typeof n.ar === "string" && n.ar.length > 0),
      JSON.stringify(notes));
    check(`«${asked}» — and the Arabic half is actually Arabic`,
      notes.every((n) => /[\u0600-\u06ff]/.test(n.ar)),
      JSON.stringify(notes.map((n) => n.ar)));
  }
}

await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
