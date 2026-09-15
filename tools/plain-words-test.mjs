/**
 * Noah explains himself to somebody who has never edited a video.
 *
 * Asked what he wants on screen before a render starts, Osama answered:
 *
 *   «اول اشي بيحكيلك شو رح يعمل الايديتور عشان يتاكد انه فهم طلبك، طبعاً يحكيه
 *    بصيغة يفهمها حد عمره ما عمل ايديت»
 *
 * That is a two-part instruction and both parts are testable. The sentence
 * exists so the person can **check that they were understood**, and it has to
 * be readable by somebody who has never opened editing software.
 *
 * It failed the second part badly. Of the eighty-five phrases the two planners
 * can put in that sentence, **forty-eight used editing jargon**: «الكادر»,
 * «أعيد تأطيره 9:16», «أذوّب بين القصّات», «أدرّجه warm», «فرشة», «لقطات
 * مساندة», «لفتة صاعدة إلى أوّل وصلة». Every one of those is a word you learn
 * *from* editing software, offered to somebody as proof that they were
 * understood.
 *
 * ## What this guards, and what it does not
 *
 * Not style, and not reading level. A table of terms that are only learned by
 * editing, each with the everyday phrase that replaces it. A sentence can be
 * long and detailed and pass; what it cannot do is name a thing by its trade
 * name.
 *
 * The ratios are a good example of the line. `shapeLabel` still returns
 * "9:16", because the render and the reports want the number. What changed is
 * only what the *sentence* says, and the sentence says «عمودي».
 *
 * Usage: node tools/plain-words-test.mjs
 */
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-plain-words-"));

async function load(source, name) {
  const outfile = path.join(buildDir, `${name}.mjs`);
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
  return import(pathToFileURL(outfile).href);
}

const { planFromText, replyFor } = await load("artifacts/api-server/src/lib/plan-from-text.ts", "plan-from-text");

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

/**
 * The trade words, and the everyday phrase that replaces each.
 *
 * Every entry was in this product's own confirmation sentence on 15 September.
 * The replacement is named in the failure, so a red check tells whoever wrote
 * the sentence what to write instead rather than only that they are wrong.
 */
const JARGON = [
  [/الكادر|\bthe frame\b/i, "الكادر / the frame", "الصورة · the video"],
  [/تأطير|\breframe\b/i, "تأطير / reframe", "أخلّيه عمودي · make it vertical"],
  [/9:16|16:9|\b1:1\b/, "نسبة أرقام / a ratio", "عمودي، عريض، مربّع · vertical, wide, square"],
  [/القصّات|كل قصّة|\bthe cuts\b|\bevery cut\b/i, "القصّات / the cuts", "تغيير المشهد · a change of scene"],
  [/أذوّب|\bdissolve\b/i, "أذوّب / dissolve", "يذوب بالتاني · fade into the next"],
  [/أدرّج|تدريج|\bgrade it\b|\bcolour grade\b|\bLUT\b/i, "أدرّج / grade", "أعطيه لون · give it a look"],
  [/فرشة|\ba .* bed under\b|\bmusic bed\b/i, "فرشة / bed", "موسيقى تحت الفيديو · music under the video"],
  [/لقطات مساندة|\bb-?roll\b/i, "لقطات مساندة / B-roll", "مقاطع تانية فوق كلامك · other clips over your talking"],
  [/التقريبات|\bpunch-?ins?\b/i, "التقريبات / punch-ins", "تقريب الصورة · zooming in"],
  [/المدى/, "المدى", "الجزء اللي طلبته · the part you asked for"],
  [/وصلة|\bدرز|لفتة صاعدة|\briser\b|\bseam\b/i, "وصلة / درز / riser / seam", "أول انتقال · the first one"],
  [/بطاقة قسم|\bsection card\b/i, "بطاقة قسم / section card", "شاشة فيها عنوان · a full-screen title"],
  [/أنزع اللون|\btake the colour out\b/i, "أنزع اللون", "أبيض وأسود · black and white"],
  [/التباين|\bcontrast\b/i, "التباين / contrast", "ألوان أقوى · stronger colours"],
  [/أحرق الترجمة|\bburn in\b/i, "أحرق / burn in", "أكتب على الفيديو · write onto the video"],
  [/العلامة المائية|\bwatermark\b/i, "العلامة المائية / watermark", "شعارك الصغير · your small logo"],
  [/\bطبقة\b|\bطبقات\b|\blayers?\b/i, "طبقة / layer", "إشي فوق الفيديو · something on top"],
  [/الترددات|\bhesitations\b|\bfalse starts\b|\bdead air\b/i, "الترددات / hesitations", "«آآ» و«يعني» · the ums"],
  [/مقطع مستقلّ/, "مقطع مستقلّ", "فيديو لحاله · a video on its own"],
  [/يُعرض الباقي|أُغلقه إليه/, "صياغة مقلوبة", "كلام عادي · plain wording"],
];

/*
  The words, without the code between `${` and `}`.

  A template literal's interpolations are identifiers, not sentences:
  `build a full screen out of ${op.layers.length} pieces` contains the word
  "layers" in a property name the customer never sees, and reading it as trade
  jargon is the guard failing on a sentence that is already plain. What the
  interpolation *evaluates* to is customer text, and it comes from tables of
  its own — the look names, the mood names, the file labels — which are
  readable on their own terms.
*/
const TEXT_NODE = (node) => node.getText().replace(/\$\{[^}]*\}/g, " … ").replace(/\s+/g, " ");

/** The phrases the two planners can put in the confirmation sentence. */
function phrasesOf(file, mode) {
  const src = readFileSync(path.join(repoRoot, file), "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const out = [];
  const visit = (node) => {
    if (mode === "say" && ts.isCallExpression(node) && node.expression.getText() === "say" && node.arguments.length === 2) {
      out.push({ text: `${TEXT_NODE(node.arguments[0])} ${TEXT_NODE(node.arguments[1])}`, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
    }
    if (mode === "prop" && ts.isPropertyAssignment(node) && (node.name.getText() === "ar" || node.name.getText() === "en")) {
      out.push({ text: TEXT_NODE(node.initializer), line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out.filter((p) => /[؀-ۿ]/.test(p.text) || /[a-z]/i.test(p.text));
}

console.log("\nThe table catches trade words and leaves ordinary sentences alone");
{
  /*
    Tested before it is pointed at the product, in both directions. A table
    that cannot fire reports success forever about a property nobody holds; a
    table that fires on correct sentences gets switched off.
  */
  const was = [
    "أعيد تأطيره 9:16 لـtiktok",
    "أذوّب بين كل قصّة وأختها",
    "أدرّجه warm",
    "أضع فرشة هادئة تحت التعديل كلّه",
    "أضيف لقطات مساندة",
    "أضع مؤثّرات صوتية على القصّات وتحت التقريبات، ولفتة صاعدة إلى أوّل وصلة",
    "أرسم طبقة فوق الكادر",
    "reframe it to 9:16 for tiktok",
    "dissolve between every cut",
    "lay a calm bed under the whole edit",
    "put a section card in",
    "burn in the captions",
  ];
  for (const sentence of was) {
    check(`«${sentence.slice(0, 30)}…» is caught`, JARGON.some(([re]) => re.test(sentence)), sentence);
  }

  // And a template literal whose *identifier* carries a trade word while the
  // sentence does not. This is the case the guard got wrong first.
  check(
    "a property name inside ${…} is not the sentence",
    !JARGON.some(([re]) => re.test("build a full screen out of  …  pieces")),
    "reading `op.layers.length` as the word \"layers\" fails a sentence that is already plain",
  );

  const now = [
    "أخلّيه عمودي لـtiktok",
    "أخلّي كل مشهد يذوب بالتاني بدل ما ينطّ",
    "أعطيه لون warm",
    "أحطّ موسيقى هادية تحت الفيديو كلّه، بتنخفض لمّا تحكي",
    "أورّي مقاطع تانية فوق كلامك",
    "أشيل السكتات",
    "أكتب الكلام اللي بتحكيه عالصورة",
    "make it vertical for tiktok",
    "take out the silent bits",
    "write what you say on the screen",
    "give it a warm look",
    "put calm music under the whole video",
  ];
  for (const sentence of now) {
    const hit = JARGON.find(([re]) => re.test(sentence));
    check(`«${sentence.slice(0, 30)}…» passes`, !hit, hit ? `flagged as ${hit[1]}` : "");
  }
}

console.log("\nEvery phrase either planner can say is in plain words");
for (const [file, mode] of [
  ["artifacts/api-server/src/lib/plan-from-text.ts", "say"],
  ["artifacts/api-server/src/lib/planner.ts", "prop"],
]) {
  const found = phrasesOf(file, mode);
  check(`${path.basename(file)} has phrases to read`, found.length > 20, `${found.length} found`);
  const flagged = [];
  for (const { text, line } of found) {
    for (const [re, term, instead] of JARGON) {
      if (re.test(text)) {
        flagged.push(`${path.basename(file)}:${line} [${term} → ${instead}] ${text.slice(0, 64)}`);
        break;
      }
    }
  }
  check(
    `${path.basename(file)} says nothing only an editor would understand`,
    flagged.length === 0,
    flagged.length > 0 ? `\n      ${flagged.join("\n      ")}` : "",
  );
}

console.log("\nThe sentence is shaped so a person can check it");
{
  /*
    A confirmation is read *down*, not across. Joined by "and", four decisions
    are one long clause that gets skimmed once, and the wrong one is not
    spotted. One per line, and a wrong line is visible without re-reading.
  */
  const three = planFromText("cut the silences, caption it, make it vertical for tiktok", { assets: [] });
  const reply = replyFor(three, { hasVideo: true, render: { started: true } });
  check("three things are three lines", (reply.match(/^• /gm) ?? []).length === 3, reply);
  check("with a heading that says these are the things", /Here is what I will do:/.test(reply), reply);
  check(
    "and the sentence about what happens next is not one of the lines",
    /\n\n/.test(reply) && !/^• .*rendering now/m.test(reply),
    reply,
  );

  const ar = planFromText("اقصص السكتات وضيف ترجمة وخلّيه عمودي لتيك توك", { assets: [] });
  const arReply = replyFor(ar, { hasVideo: true, render: { started: true } });
  check("and the same in Arabic", (arReply.match(/^• /gm) ?? []).length === 3, arReply);
  check("with its own heading", /تمام، فهمت\. رح:/.test(arReply), arReply);

  /* One thing is a sentence. A bullet list of one is a list about nothing. */
  const one = planFromText("cut the silences", { assets: [] });
  const oneReply = replyFor(one, { hasVideo: true, render: { started: true } });
  check("one thing stays a sentence", !oneReply.includes("• "), oneReply);
  check("and still says what happens next", /rendering now/.test(oneReply), oneReply);

  /* And the refusal keeps its shape: it is the most careful sentence here. */
  const blocked = replyFor(three, {
    hasVideo: true,
    render: { started: false, because: "a render is already running" },
  });
  check("a blocked render lists what it would have done", /^• /m.test(blocked), blocked);
  check("and says why it cannot, once, at the end", (blocked.match(/can't start it right now/g) ?? []).length === 1, blocked);
}

await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log("Noah is explaining an edit in the words of somebody who already edits.");
  process.exit(1);
}
console.log("Noah says what he is about to do in words anybody can check.");
