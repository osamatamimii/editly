/**
 * Not every long video is a pile of clips waiting to happen.
 *
 * This product has been answering that question by itself, and not in the code
 * — nothing refuses a long edit, and captions, levelling, silence removal and
 * a grade all keep the length — but in everything a person reads. Four of six
 * first-run suggestions shorten the video. Both of the most-read sentences in
 * the product open with "I can pull out the strongest 30 seconds". And the
 * one ask that meant "keep most of it" was clamped at two minutes: "the best
 * ten minutes of my talk" produced a hundred and twenty seconds and said so.
 *
 * A forty-minute podcast and a forty-minute recording to harvest posts out of
 * are the same file. The difference is in somebody's head, so the product asks
 * — once — and starts nothing until it is answered.
 *
 * Half of this suite is about the question being answerable, which is the part
 * that is easy to get wrong: «مقاطع» on its own is not a request anywhere in
 * this codebase, and a product that asks a question it cannot read the answer
 * to is worse than one that never asked.
 *
 * Usage: node tools/long-form-test.mjs
 */
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-long-form-build-"));
const esbuild = require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/api-server"] });

async function load(source, name) {
  const outfile = path.join(buildDir, `${name}.mjs`);
  const built = spawnSync(
    esbuild,
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

const {
  planFromText,
  replyFor,
  deliverableShape,
  shapeAnswer,
  shapeAnswerAsRequest,
  WHOLE_OR_CLIPS,
  LONG_SOURCE_SECONDS,
} = await load("artifacts/api-server/src/lib/plan-from-text.ts", "plan-from-text");

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

const ops = (typed) => planFromText(typed, { assets: [] }).operations;
const types = (typed) => ops(typed).map((o) => o.type);

// ─────────────────────────────────────────────────────────────────────────────
section("A plan can be a good edit and still not say what shape it is");
{
  const cleanUp = ops("cut the silences and caption it");
  check("cleaning a recording up produces a real plan", cleanUp.length >= 2, JSON.stringify(types("cut the silences and caption it")));
  check(
    "and none of it says whether the result is one video or several",
    deliverableShape(cleanUp, "cut the silences and caption it") === "unsaid",
  );

  /*
    The four that settle it, each for its own reason: clips are several, a
    highlight and a range are one short piece, a stills reel is a video built
    out of photographs. Any of them means the person already said.
  */
  const settled = [
    ["cut it into 3 clips", "clips"],
    ["pull out the strongest 30 seconds", "a highlight"],
    ["keep from 1:20 to 2:10", "a named range"],
  ];
  for (const [typed, what] of settled) {
    check(
      `asking for ${what} settles the shape`,
      deliverableShape(ops(typed), typed) === "settled",
      JSON.stringify(types(typed)),
    );
  }

  // And the ask this product had no words for at all.
  for (const typed of ["keep the whole thing, just clean it up", "cut the silences but keep it full-length"]) {
    check(
      `"${typed.slice(0, 28)}…" settles it too`,
      deliverableShape(ops(typed), typed) === "settled",
    );
  }
  for (const typed of ["نظّفه بس خليه كامل", "اقصص السكتات وخلي الطول متل ما هو"]) {
    check(`«${typed.slice(0, 22)}…» settles it in Arabic`, deliverableShape(ops(typed), typed) === "settled");
  }
}

section("The question is asked instead of the answer, not beside it");
{
  const intent = planFromText("cut the silences and caption it", { assets: [] });
  const asked = replyFor(intent, { hasVideo: true, ask: "wholeOrClips" });
  check("asking replaces the reply entirely", asked === WHOLE_OR_CLIPS.en, asked);
  /*
    Not a keyword check on "I'll" — the question itself ends with "and I will
    go", which is a promise about the answer rather than about the edit. What
    must not be there is the *plan*: every phrase the matcher put in `willDo`
    describes work that is not happening while the question stands.
  */
  check(
    "so nothing from the plan is recited as though it were under way",
    intent.willDo.length > 0 && intent.willDo.every((p) => !asked.includes(p.en)),
    `${intent.willDo.length} phrases in the plan, reply: ${asked}`,
  );

  const ar = planFromText("اقصص السكتات وضيف ترجمة", { assets: [] });
  check("and in Arabic it is the Arabic question", replyFor(ar, { hasVideo: true, ask: "wholeOrClips" }) === WHOLE_OR_CLIPS.ar);
  check("the two are not the same string", WHOLE_OR_CLIPS.en !== WHOLE_OR_CLIPS.ar);

  // The house rule, which is easiest to forget in a sentence written today.
  for (const [lang, text] of Object.entries(WHOLE_OR_CLIPS)) {
    check(`no em dash in the ${lang} question`, !text.includes("—"), text);
  }

  check(
    "it offers both answers in the words they can type back",
    /whole/i.test(WHOLE_OR_CLIPS.en) && /clips/i.test(WHOLE_OR_CLIPS.en),
    WHOLE_OR_CLIPS.en,
  );
  check(
    "and the Arabic offers its own two",
    /كامل/.test(WHOLE_OR_CLIPS.ar) && /مقاطع/.test(WHOLE_OR_CLIPS.ar),
    WHOLE_OR_CLIPS.ar,
  );

  // Without the ask, the reply is what it always was.
  const normal = replyFor(intent, { hasVideo: true, render: { started: true } });
  check("and with nothing to ask, nothing changed", /rendering now/i.test(normal), normal);
}

section("A question you cannot answer is worse than no question");
{
  /*
    The trap this section exists for.

    `parseClips` needs a count or a "cut it into", on purpose: "add transitions
    between the clips" must not split anybody's video. So «مقاطع» — the exact
    word the question tells people to type — parses as nothing at all. The
    answer is read as an answer and folded back onto the request it qualifies,
    and these are the two halves of that.
  */
  check("«مقاطع» is read as an answer", shapeAnswer("مقاطع") === "clips");
  check("and so is a bare \"clips\"", shapeAnswer("clips") === "clips");
  check("«كامل» is the other answer", shapeAnswer("كامل") === "whole");
  check('and so is "the whole thing"', shapeAnswer("the whole thing") === "whole");
  check('and "one video"', shapeAnswer("one video please") === "whole");

  check(
    "a request is not mistaken for an answer",
    shapeAnswer("add a warm grade and level the audio") === null,
    String(shapeAnswer("add a warm grade and level the audio")),
  );

  /*
    And the join: the canonical form of each answer has to be a sentence this
    file's own matcher reads. A canonical sentence nobody can parse is the same
    bug one level further in.
  */
  for (const lang of ["en", "ar"]) {
    const clips = shapeAnswerAsRequest("clips", lang);
    check(
      `the ${lang} clips answer parses as clips`,
      types(clips).includes("extractClips"),
      `${clips} → ${JSON.stringify(types(clips))}`,
    );
    const whole = shapeAnswerAsRequest("whole", lang);
    check(
      `the ${lang} whole answer settles the shape`,
      deliverableShape(ops(whole), whole) === "settled",
      whole,
    );
    check(
      `and does not smuggle in a cut of its own`,
      !types(whole).some((t) => ["extractClips", "extractHighlight", "extractRange"].includes(t)),
      `${whole} → ${JSON.stringify(types(whole))}`,
    );
  }

  // The whole point: the original request survives the answer.
  const folded = `cut the silences and caption it ${shapeAnswerAsRequest("clips", "en")}`;
  const foldedTypes = types(folded);
  check("the request they made before the question is still in the plan", foldedTypes.includes("removeSilence"), JSON.stringify(foldedTypes));
  check("and so is the answer", foldedTypes.includes("extractClips"), JSON.stringify(foldedTypes));
}

section("Ten minutes, and why it is ten");
{
  check("the threshold is ten minutes", LONG_SOURCE_SECONDS === 600, String(LONG_SOURCE_SECONDS));
  /*
    Longer than anything that goes anywhere social in one piece: TikTok's
    ceiling is ten minutes and Reels and Shorts are far shorter. Under this, a
    file could plausibly be posted whole and the two answers are closer to the
    same thing. Over it, "post it whole" means a different platform entirely.
  */
  check("which is at least as long as the longest social clip", LONG_SOURCE_SECONDS >= 600);
  check("and not so long that a podcast falls under it", LONG_SOURCE_SECONDS <= 1200);
}

section("The best ten minutes means ten minutes");
{
  const asked = ops("give me the best 600 seconds");
  const highlight = asked.find((o) => o.type === "extractHighlight");
  check("a long highlight is asked for", Boolean(highlight), JSON.stringify(types("give me the best 600 seconds")));
  check(
    "and it is not silently cut to two minutes",
    highlight?.targetSeconds === 600,
    String(highlight?.targetSeconds),
  );

  const short = ops("give me the strongest 30 seconds").find((o) => o.type === "extractHighlight");
  check("while the ordinary ask is untouched", short?.targetSeconds === 30, String(short?.targetSeconds));

  const tiny = ops("give me the best 2 seconds").find((o) => o.type === "extractHighlight");
  check("and the floor is still a floor", tiny?.targetSeconds === 5, String(tiny?.targetSeconds));

  // The model's copy of the same clamp, which is a second place to drift from.
  const planner = readFileSync(path.join(repoRoot, "artifacts/api-server/src/lib/planner.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const branch = planner.slice(planner.indexOf('case "extractHighlight":'), planner.indexOf('case "extractClips":'));
  check(
    "and the model's path has no ceiling either",
    !/Math\.min\(\s*120/.test(branch),
    branch.replace(/\s+/g, " ").slice(0, 140),
  );
}

section("Nothing is started while the question stands");
{
  /*
    Read from the route, because the property is about order rather than about
    a value: a render started before the answer is a render of the wrong thing,
    and the customer's minutes are spent either way.
  */
  const route = readFileSync(path.join(repoRoot, "artifacts/api-server/src/routes/messages.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  check(
    "the render is gated on there being nothing to ask",
    /if \(!ask && intent\.operations\.length > 0 && project\.videoPath\)/.test(route),
    "a render started before the answer spends the minutes on the wrong deliverable",
  );
  check(
    "the question is asked at most once per project",
    /alreadyAskedShape\(/.test(route) && /askedBefore/.test(route),
    "a product that asks twice about one thing is worse than one that guesses",
  );
  check(
    "and it is recognised by the constant, not by a phrase copied out again",
    /WHOLE_OR_CLIPS\.en/.test(route) && /WHOLE_OR_CLIPS\.ar/.test(route),
    "rewording the question must not make it start asking everybody again",
  );
  check(
    "no plan is handed back for an editor to display as running",
    /plan: !ask &&/.test(route),
    "showing the plan while nothing runs is the same promise, made silently",
  );
  check(
    "the answer is folded onto the request it qualifies",
    /requestAwaitingShape\(/.test(route) && /shapeAnswerAsRequest\(/.test(route),
    "a question whose answer produces nothing is a dead end",
  );
  check(
    "and what gets planned is what the shape check reads",
    /deliverableShape\(intent\.operations, toPlan\)/.test(route),
    "checking the shape of one sentence and planning another is two answers to one question",
  );
}

await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log("A long video is still being treated as a pile of clips.");
  process.exit(1);
}
console.log("A long recording gets asked about, and the answer is one it can read.");
