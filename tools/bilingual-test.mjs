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

const { planFromText, replyFor, parseMoments } = await import(pathToFileURL(outfile).href);

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
    // The coverage check below found this one missing: `tighten` shipped, the
    // matcher understood it in both languages from the first day, and no pair
    // here said so — which is the difference between "it works" and "it is
    // known to work", and the whole reason that check reads the source.
    what: "cutting the hesitations, which is not the same as cutting the silence",
    en: "cut the ums",
    ar: "اقصّ الترددات",
    expect: ["tighten"],
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
    // Nobody types the operation's name. Both of these are the effect described
    // from the viewer's seat, which is the only way this is ever asked for.
    what: "two shot sizes out of one camera",
    en: "cut between wide and close so it looks like two cameras",
    ar: "خليه يبان كأنه مصوّر بكاميرتين",
    expect: ["alternateFraming"],
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
  {
    what: "sound effects",
    en: "add sound effects",
    ar: "ضيف مؤثرات صوتية",
    expect: ["soundEffects"],
  },
  {
    // The one refusal in this list that is about a project having no video at
    // all rather than no extra file, which is the whole reason the operation
    // exists. An Arabic-speaking shop owner who is told the fix only in English
    // has not been told the fix.
    what: "a video from photos, with no photos uploaded",
    en: "make a video from my product photos",
    ar: "اعمل فيديو من صور المنتج",
    expect: [],
    refuses: "add the product images",
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
const NEEDS_A_FILE = new Set(["insertBRoll", "overlayImage", "addMusic", "motionTitle", "stillsReel"]);
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

/**
 * Pointing at a moment, in both languages.
 *
 * `zoomPunch.at` is a list of seconds and the renderer has honoured it since it
 * was written. Both heads sent an empty list every single time, which means
 * "you choose" — so "punch in at 0:12" produced punches wherever the speaker
 * happened to lean on a word, and nothing anywhere said the moment had been
 * ignored. A capability that is built, tested and unreachable.
 */
console.log("\nA moment somebody points at");
{
  const punchAt = (text) => {
    const op = (planFromText(text).operations ?? []).find((o) => o.type === "zoomPunch");
    return op ? op.at : null;
  };

  const pairs = [
    ["punch in at 0:12", "قرّب الصورة عند 0:12", [12]],
    ["zoom at 1:05 and at 2:30", "زوم عند 1:05 وعند 2:30", [65, 150]],
    ["punch in at second 45", "زوم عند الثانية 45", [45]],
  ];
  for (const [en, ar, want] of pairs) {
    check(`«${en}» lands on ${want.join(", ")}`, JSON.stringify(punchAt(en)) === JSON.stringify(want), JSON.stringify(punchAt(en)));
    check(`«${ar}» lands on the same seconds`, JSON.stringify(punchAt(ar)) === JSON.stringify(want), JSON.stringify(punchAt(ar)));
  }

  // The imperative, which is the word somebody actually types. The list had the
  // noun and the loanword and not this, so the commonest phrasing matched
  // nothing at all.
  check("«قرّب الصورة» is a zoom at all", punchAt("قرّب الصورة") !== null, JSON.stringify(punchAt("قرّب الصورة")));

  // ...and the four ways this must NOT fire, which is most of the work. A
  // number in a sentence is a number; only a marker word makes it a moment.
  check("a length is not a moment", punchAt("zoom and make it 12 seconds long")?.length === 0);
  check("a named range is not a moment", punchAt("keep from 1:20 to 2:10 and punch in")?.length === 0);
  check("«أبقِ من 1:20 إلى 2:10» is not a moment either", punchAt("زوم وأبقِ من 1:20 إلى 2:10")?.length === 0);
  check("and asking for the beat still means the beat, not a moment", punchAt("punch in on the beat")?.length === 0);
  check("parseMoments alone agrees", JSON.stringify(parseMoments("at 0:12 and at second 45")) === "[12,45]", JSON.stringify(parseMoments("at 0:12 and at second 45")));

  // The reply has to name them, or the person cannot tell it heard the moment
  // rather than deciding for itself — which is the entire difference.
  /*
   * The sentence the editor composes from timeline marks, parsed by the head
   * that has to read it.
   *
   * `moment-marks.tsx` writes "At 0:26 punch in." and this file parses it, and
   * they are in packages that deploy separately — so the format is written
   * twice and this is what holds the two copies to each other. Change the
   * template there without changing the parser here and the marks silently
   * become prose with no moments in it, which is the failure this feature is
   * most likely to have.
   */
  const composed = "At 0:26 punch in. At 1:40 punch in.";
  check(
    "the sentence the timeline marks compose is one the matcher can read",
    JSON.stringify(parseMoments(composed)) === "[26,100]",
    JSON.stringify(parseMoments(composed)),
  );
  check(
    "and it produces a punch on exactly those seconds",
    JSON.stringify(punchAt(composed)) === "[26,100]",
    JSON.stringify(punchAt(composed)),
  );

  /*
   * A moment belongs to the instruction it was written beside.
   *
   * The first version scanned the whole message and put every second it found
   * on the single zoomPunch — so "At 0:12 cut. At 0:40 zoom in." punched at
   * both, inventing a punch at the exact moment somebody had asked to remove.
   * Marks from the timeline are one sentence each, which is precisely the shape
   * that made this wrong.
   */
  const mixed = "At 0:12 cut. At 0:40 zoom in.";
  check(
    "a moment beside a cut does not become a punch",
    JSON.stringify(punchAt(mixed)) === "[40]",
    JSON.stringify(punchAt(mixed)),
  );

  // "punch in" is a zoom. `\bpunch\b` was also a colour look, so asking for
  // this one thing quietly regraded the whole video — and the reply listed both
  // lines truthfully, which is why nobody caught it.
  const punchOps = (text) => (planFromText(text).operations ?? []).map((o) => o.type).sort();
  check("asking to punch in does not also regrade the video", !punchOps("punch in at 0:12").includes("grade"), JSON.stringify(punchOps("punch in at 0:12")));
  check("and 'punchy' still means the look, because that is what it means", punchOps("make the colours punchy").includes("grade"), JSON.stringify(punchOps("make the colours punchy")));

  /*
   * A moment nobody picked up is said out loud.
   *
   * Silence here was the worst of the three possible answers: no operation, and
   * nothing in the reply either, so it looked exactly like it had worked.
   */
  const unheard = planFromText("At 0:26 cut this bit.");
  check(
    "a moment nothing could use is admitted rather than dropped",
    unheard.cannotYet.some((c) => /0:26/.test(c.en)),
    JSON.stringify(unheard.cannotYet),
  );
  check(
    "in Arabic too",
    planFromText("عند 0:26 اقصص هذا الجزء.").cannotYet.some((c) => /0:26/.test(c.ar) && /[\u0600-\u06ff]/.test(c.ar)),
    JSON.stringify(planFromText("عند 0:26 اقصص هذا الجزء.").cannotYet),
  );
  check(
    "and a moment that *was* used is not apologised for",
    planFromText("punch in at 0:26").cannotYet.every((c) => !/0:26/.test(c.en)),
    JSON.stringify(planFromText("punch in at 0:26").cannotYet),
  );
  check(
    "a sentence with no moment in it says nothing about moments",
    planFromText("cut the dead air").cannotYet.every((c) => !/only at/.test(c.en)),
    JSON.stringify(planFromText("cut the dead air").cannotYet),
  );

  const said = replyFor(planFromText("punch in at 1:05"), { hasVideo: true });
  check("and the reply says which moment it heard", /1:05/.test(said), said);
  const saidAr = replyFor(planFromText("قرّب الصورة عند 1:05"), { hasVideo: true });
  check("in Arabic too", /1:05/.test(saidAr) && /[\u0600-\u06ff]/.test(saidAr), saidAr);
}

/**
 * Which language the microphone is asked to listen for.
 *
 * This was read from the chat input — and the chat input is empty when you
 * press the microphone, because that is the whole reason you are pressing it.
 * So the answer was always "not Arabic", and the recogniser was asked for
 * `en-US` while somebody spoke Arabic at it. The engine was working perfectly
 * and being asked the wrong question, which is a hard failure to diagnose from
 * the outside: it looks exactly like bad speech recognition.
 */
console.log("\nThe microphone is asked to listen for the right language");
{
  // Bundled the same way the matcher above is: this one lives in the frontend
  // package, and the rule it holds is a rule about language, which is what this
  // suite is for.
  const speechOut = path.join(buildDir, "speech-language.mjs");
  const speechBuilt = spawnSync(
    require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/api-server"] }),
    [
      path.join(repoRoot, "artifacts/editly/src/components/voice/speech-language.ts"),
      "--bundle", "--platform=node", "--format=esm", "--target=node22",
      `--outfile=${speechOut}`, "--log-level=error",
    ],
    { stdio: "inherit" },
  );
  if (speechBuilt.status !== 0) {
    console.error("could not bundle the speech language rule");
    process.exit(1);
  }
  const { guessSpeechLanguage } = await import(pathToFileURL(speechOut).href);

  check(
    "an empty box and an Arabic conversation is Arabic",
    guessSpeechLanguage({ said: ["اقص السكتات وخليه عمودي"], typed: "", browser: ["en-US"] }) === "ar",
  );
  check(
    "an empty box and an English conversation is English",
    guessSpeechLanguage({ said: ["cut the dead air"], typed: "", browser: ["ar-JO"] }) === "en",
  );
  // The newest line wins: a conversation that switched language switched for a
  // reason, and it is usually the reason somebody is about to speak.
  check(
    "a conversation that switched language follows the switch",
    guessSpeechLanguage({ said: ["cut the dead air", "خليه عمودي"], typed: "" }) === "ar",
  );
  check(
    "and the other way too",
    guessSpeechLanguage({ said: ["خليه عمودي", "cut the dead air"], typed: "" }) === "en",
  );
  // With nothing said yet, the browser is a far better guess than a coin toss.
  check(
    "with no conversation, an Arabic browser is Arabic",
    guessSpeechLanguage({ said: [], typed: "", browser: ["ar-JO", "en-US"] }) === "ar",
  );
  check(
    "and an English browser is English",
    guessSpeechLanguage({ said: [], typed: "", browser: ["en-GB"] }) === "en",
  );
  // The old rule, kept as a fallback rather than as the answer.
  check(
    "something half-typed still counts when nothing else is known",
    guessSpeechLanguage({ said: [], typed: "اقص", browser: ["en-US"] }) === "ar",
  );
  check(
    "and an empty everything is English rather than a crash",
    guessSpeechLanguage({}) === "en",
  );
  // The exact shape of the bug: empty box, Arabic person, English browser.
  check(
    "the case that was broken: empty box, Arabic conversation, English browser",
    guessSpeechLanguage({ said: ["قرّب الصورة عند 0:12"], typed: "", browser: ["en-US"] }) === "ar",
  );
}

await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
