/**
 * Noah speaks the way the person typing does.
 *
 * On 15 September Osama said it plainly: «اسلوب العامل بالكلام مش مرن و بحسسك
 * انه الة و ما بفهمك». Half of that was a queue fault and is fixed elsewhere.
 * The other half was real and is this: he types Levantine and the product
 * answered in Modern Standard Arabic, which is the register of a form, a news
 * bulletin and a machine translation. «لست متأكّدًا ما الذي أغيّره من ذلك» is a
 * correct sentence that nobody has ever said out loud.
 *
 * Asked to choose, he chose **عامية دائمًا** — one white Levantine for
 * everyone — and **زميل بيفهم عليك** as the voice. `claude/briefs/07-progress.md`
 * carries the decision.
 *
 * ## Why a guard and not a review
 *
 * Because register is not something you fix once. Every new sentence is
 * written by whoever is in that file that day, and the pull toward MSA is
 * strong: it is what everybody was taught to write. The em-dash guard in
 * `browser-test.mjs` exists for exactly this reason and works, and this is the
 * same shape of check pointed at a different property.
 *
 * ## What it is not
 *
 * It is not a judge of style. It reads a short table of **markers** — words
 * that are unambiguously written-register and have an ordinary spoken
 * equivalent — and names the spoken one when it finds a written one. A
 * sentence can be perfectly formal and pass, because most Arabic is shared;
 * what it catches is the handful of words that only ever appear in writing.
 *
 * ## Scope, and why it is a list
 *
 * A guard with an exclusion list lies: the list grows, nobody reads it, and
 * the check quietly covers nothing. So the scope is the opposite — a list of
 * files that **are** converted and must stay converted, and it grows as the
 * conversion does. A file outside it is honestly outside it.
 *
 * Usage: node tools/voice-test.mjs
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const repoRoot = process.cwd();

/**
 * The files Noah's voice has been converted in.
 *
 * Add a file here the day it is converted, not before: a file listed and not
 * converted turns this suite red for everybody, and a file converted and not
 * listed drifts back to MSA the first time somebody adds a sentence to it.
 *
 * Still outside, deliberately, and each for its own reason:
 *
 *   · `landing-copy.ts` — the landing page is not Noah talking. Whether
 *     marketing copy should be in dialect is a separate decision and Osama has
 *     not been asked it.
 *   · `artifacts/worker/src/index.ts` — the progress bar (`jobs.stage`) is
 *     English-only and has been since it was written. That is gap #1 of brief
 *     07 and a bigger change than a register: the strings have to go through
 *     `say` first.
 *   · the rest of `copy/**` — account, billing, admin and the other panels.
 *     Converted file by file.
 */
const SCOPE = [
  "artifacts/api-server/src/lib/plan-from-text.ts",
  "artifacts/editly/src/lib/copy/editor.ts",
  "artifacts/worker/src/say.ts",
  "artifacts/worker/src/disk.ts",
];

/**
 * The markers, and the word to reach for instead.
 *
 * Each one is a word that appears in writing and does not appear in speech,
 * with an everyday equivalent. Kept short on purpose: a long list starts
 * catching words that are simply Arabic, and a guard that fires on correct
 * sentences is one somebody switches off.
 *
 * The boundaries are written out rather than using `\b`, which cannot match
 * next to an Arabic letter — every Arabic character is a non-word character to
 * a JavaScript regular expression. That trap is documented five times over in
 * `plan-from-text.ts` and it would silently disable half of this table.
 */
const EDGE = `(^|[\\s"'\`،.:؛!؟()\\\\n])`;
const END = `([\\s"'\`،.:؛!؟()]|\\\\n|$)`;
const MARKERS = [
  [new RegExp(`${EDGE}سأ`, "u"), "«سأ…»", "«رح …»"],
  [new RegExp(`${EDGE}سي[أتنيرسصضطظعغفقكلمهوىءبجحخدذز]`, "u"), "«سيـ…»", "«رح يـ…»"],
  [new RegExp(`${EDGE}سوف${END}`, "u"), "«سوف»", "«رح»"],
  [/أستطيع|تستطيع|نستطيع|يستطيع/u, "«أستطيع»", "«بقدر»"],
  [new RegExp(`${EDGE}ل[سي]س[تن]?${END}`, "u"), "«لست» / «ليس»", "«مش» / «ما»"],
  [new RegExp(`${EDGE}(الذي|التي|الذين|اللذان)${END}`, "u"), "«الذي» / «التي»", "«اللي»"],
  [/حالما|فورًا|فوراً/u, "«حالما» / «فورًا»", "«أول ما»"],
  [/بدلًا|بدلاً/u, "«بدلًا»", "«بدل ما»"],
  [/يُرجى|الرجاء/u, "«يُرجى»", "a verb: «جرّب»، «ابعت»"],
  [new RegExp(`${EDGE}ماذا${END}`, "u"), "«ماذا»", "«شو»"],
  [new RegExp(`${EDGE}قل لي${END}`, "u"), "«قل لي»", "«قلّي»"],
  [new RegExp(`${EDGE}لم [يت]`, "u"), "«لم يـ…»", "«ما …»"],
];

const TEXT = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.JsxText,
]);
const ARABIC = /[؀-ۿ]/;

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

/** Every Arabic-bearing string literal in a file, with its line. */
function arabicStrings(file) {
  const src = readFileSync(path.join(repoRoot, file), "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found = [];
  const visit = (node) => {
    const text = node.getText ? node.getText() : "";
    if (TEXT.has(node.kind) && ARABIC.test(text)) {
      found.push({ text, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

console.log("\nThe table catches what it says it catches");
{
  /*
    The guard tested before the product is, because a guard that cannot fire is
    worse than no guard: it reports success forever about a property nobody is
    holding. Each of these is a sentence the product used to contain.
  */
  const was = [
    "لست متأكّدًا ما الذي أغيّره من ذلك",
    "أستطيع أن أستخرج أقوى 30 ثانية",
    "وسأضمّ هذا إليه حالما ينتهي",
    "لم يُعثر على المشروع",
    "ماذا يحدث هنا؟",
    "قل لي الإحساس الذي تريده",
    "بدلًا من أن أدّعي",
  ];
  for (const sentence of was) {
    check(
      `«${sentence.slice(0, 26)}…» is caught`,
      MARKERS.some(([re]) => re.test(sentence)),
      sentence,
    );
  }

  // And the other direction, which is the half that decides whether anybody
  // keeps this check switched on.
  const now = [
    "تمام، رح أقصّ السكتات. التصيير شغّال هلق",
    "ما بقدر أعمل هاد لسا",
    "قلّي بكلماتك وبقلّك إذا بقدر",
    "هالفيديو أكبر من اللي بنقدر نشتغل عليه",
    "ارفع فيديو وببلّش",
    "الكلمة اللي بتشدّد عليها بترسمها أكبر",
    "شو بدك يصير هون؟",
  ];
  for (const sentence of now) {
    const hit = MARKERS.find(([re]) => re.test(sentence));
    check(
      `«${sentence.slice(0, 26)}…» passes`,
      !hit,
      hit ? `flagged as ${hit[1]}` : "",
    );
  }

  /*
    Ordinary Arabic that happens to contain the letters of a marker must not
    fire. `\b` does not work in front of an Arabic letter, so a marker written
    carelessly matches inside words — «سيارة» would read as the future «سيـ»,
    «مالست» would read as «لست» — and a guard that fires on correct sentences
    is one somebody switches off within a week.
  */
  const innocent = ["سيارة الزفاف", "سنة كاملة", "جلست على الكرسي", "التيار الكهربائي"];
  for (const sentence of innocent) {
    const hit = MARKERS.find(([re]) => re.test(sentence));
    check(`«${sentence}» is not a marker`, !hit, hit ? `flagged as ${hit[1]}` : "");
  }
}

console.log("\nThe scope is a list of what is done, not a list of exceptions");
{
  check("there are files in scope", SCOPE.length > 0);
  for (const file of SCOPE) {
    let strings;
    try {
      strings = arabicStrings(file);
    } catch (error) {
      check(`${file} can be read`, false, String(error));
      continue;
    }
    check(`${file} has Arabic to check`, strings.length > 0, `${strings.length} strings`);
  }
}

console.log("\nEvery converted file stays converted");
for (const file of SCOPE) {
  let strings;
  try {
    strings = arabicStrings(file);
  } catch {
    continue;
  }
  const flagged = [];
  for (const { text, line } of strings) {
    for (const [re, marker, instead] of MARKERS) {
      if (re.test(text)) {
        flagged.push(`${file}:${line} ${marker} → ${instead}  ${text.replace(/\s+/g, " ").slice(0, 60)}`);
        break;
      }
    }
  }
  check(
    `${path.basename(file)} is in Noah's voice`,
    flagged.length === 0,
    flagged.length > 0 ? `\n      ${flagged.join("\n      ")}` : "",
  );
}

console.log("\nThe decision is written down where the next session will look");
{
  // A voice held only by a check is a voice nobody can argue with. The brief
  // is where it is argued; this is where it is enforced.
  check(
    "the guard names the brief that carries the decision",
    readFileSync(path.join(repoRoot, "tools/voice-test.mjs"), "utf8").includes("briefs/07-progress.md"),
  );
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log("Noah has slipped back into the register of a form.");
  process.exit(1);
}
console.log("Noah talks like the person typing.");
