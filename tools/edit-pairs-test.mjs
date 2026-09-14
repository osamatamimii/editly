/**
 * The record of our own decisions being corrected — and the one line it holds.
 *
 * Three places in the product tell a customer, in their own words, that we do
 * not use their **videos** to train models. That sentence is about their
 * footage, not about their instructions: the title they typed and the font they
 * chose are things they told us, in our product, about an edit. What came out of
 * the video is the burnt caption cues — the transcript — and those are the one
 * thing here that becomes a shape instead of a sentence.
 *
 * Which makes the rule a denylist, and a denylist is correct the day it is
 * written and wrong the day somebody adds a field. So the last section is the
 * one that matters in a year: it walks the *real* schema, collects every path in
 * a plan that can hold a string, and fails on any path nobody has classified.
 * Adding a field to the plan is a decision about `edit-pairs.ts`, made on
 * purpose, rather than a default nobody noticed.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-pairs-test-"));
const modulePath = path.join(buildDir, "pairs.mjs");
const build = spawnSync(
  require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/api-server"] }),
  [
    path.join(repoRoot, "artifacts/api-server/src/lib/edit-pairs.ts"),
    "--bundle", "--platform=node", "--format=esm", "--target=node22",
    `--outfile=${modulePath}`, "--log-level=error",
  ],
  { stdio: "inherit" },
);
if (build.status !== 0) process.exit(1);

const { redactPlan, pairFrom, worthKeeping, shapeOf, scriptOf } =
  await import(pathToFileURL(modulePath).href);

const zodBundle = path.join(buildDir, "zod.mjs");
const zodBuild = spawnSync(
  require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/api-server"] }),
  [
    path.join(repoRoot, "lib/api-zod/src/index.ts"),
    "--bundle", "--platform=node", "--format=esm", "--target=node22",
    `--outfile=${zodBundle}`, "--log-level=error",
  ],
  { stdio: "inherit" },
);
if (zodBuild.status !== 0) process.exit(1);
const { EditOperation } = await import(pathToFileURL(zodBundle).href);

let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failed += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};
const section = (name) => console.log(`\n${name}`);

/** A string nothing in the product could produce, so finding it means a leak. */
const SECRET = "ZZQXSECRETZZ";

section("The transcript is the one thing that becomes a shape");
{
  const plan = {
    version: 1,
    operations: [
      { type: "motionTitle", text: "Chapter two", at: 4, durationSeconds: 2.5, style: "card", position: "center" },
      { type: "burnCaptions", style: "karaoke", position: "bottom", size: "medium", font: "Cairo", fontArabic: "Cairo",
        cues: [{ start: 0, end: 1.2, text: `${SECRET} said out loud`, words: [{ start: 0, end: 0.4, text: SECRET }] }] },
      { type: "overlayImage", assetId: "asset_7f3", at: 2, durationSeconds: 3,
        position: "center", scale: 0.4, opacity: 1, fit: "cover" },
      { type: "drawLayers", layers: [
        { box: { x: 0, y: 0, w: 1, h: 1 }, content: { kind: "fill", color: "#ECECEC" }, at: 2, durationSeconds: 2, enter: "rise" },
        { box: { x: 0.1, y: 0.4, w: 0.8, h: 0.1 },
          content: { kind: "text", runs: [{ text: "Section" }, { text: "three", color: "#ff0000" }], size: 0.07, color: "#111111", weight: 800, align: "center" },
          at: 2, durationSeconds: 2, enter: "rise" },
      ] },
    ],
  };

  const redacted = redactPlan(plan);
  const asText = JSON.stringify(redacted);

  /*
    The words their recording said, and nothing else in the plan, are what the
    promise on the page is about. The secret is planted in both places a cue can
    hold one — the line and the word inside it — because redacting the line and
    keeping the word would read as a pass.
  */
  check("what the microphone heard is not kept", !asText.includes(SECRET), asText.slice(0, 300));
  const cue = redacted[1].cues[0];
  check("a cue becomes its shape", cue?.text?.words === 4, JSON.stringify(cue?.text));
  check("and so does each word inside it", typeof cue?.words?.[0]?.text?.words === "number",
    JSON.stringify(cue?.words?.[0]));
  check("while the cue's timing survives, because timing is craft",
    cue?.start === 0 && cue?.end === 1.2, JSON.stringify([cue?.start, cue?.end]));

  /*
    And everything they told *us* is kept, because that is the correction.

    "Your three words should have been five" is a lesson; "a string was here"
    is not. A title they typed, a font they picked and the id of the asset they
    reached for are instructions given to this product, not footage.
  */
  check("a title they typed is kept as written",
    redacted[0].text === "Chapter two", JSON.stringify(redacted[0].text));
  check("the font they chose is kept", redacted[1].font === "Cairo", String(redacted[1].font));
  check("and the asset they reached for", redacted[2].assetId === "asset_7f3", String(redacted[2].assetId));
  check("and the words inside a drawn layer",
    redacted[3].layers[1].content.runs[0].text === "Section",
    JSON.stringify(redacted[3].layers[1].content.runs));

  check("the operations are all still there, in order",
    redacted.map((o) => o.type).join(",") === "motionTitle,burnCaptions,overlayImage,drawLayers",
    redacted.map((o) => o.type).join(","));
  check("timings survive", redacted[0].at === 4 && redacted[0].durationSeconds === 2.5,
    JSON.stringify(redacted[0]));
  check("choices the schema defines survive",
    redacted[0].style === "card" && redacted[1].position === "bottom",
    JSON.stringify([redacted[0].style, redacted[1].position]));
  check("colours survive", redacted[3].layers[0].content.color === "#ECECEC",
    JSON.stringify(redacted[3].layers[0].content));
  check("geometry survives", redacted[3].layers[1].box.w === 0.8, JSON.stringify(redacted[3].layers[1].box));
}

section("The shape of a line is everything about it except what it says");
{
  check("words are counted", shapeOf("one two three").words === 3);
  check("an empty line is no words", shapeOf("   ").words === 0);
  check("Arabic is recognised", scriptOf("الفصل الثاني") === "arabic");
  check("and a line with both is mixed", scriptOf("الفصل two") === "mixed");
  check("and digits alone are neither", scriptOf("2026") === "other");
  check("characters are counted, because a long word is not three short ones",
    shapeOf("internationalisation").characters === 20, String(shapeOf("internationalisation").characters));
}

section("Every field in the schema has been classified by somebody");
{
  /*
    The check that makes a denylist safe.

    A list of fields to redact is correct the day it is written and wrong the
    day somebody adds one — and nothing fails, because the new field is simply
    not on the list. So this walks the real `EditOperation` union, collects
    every path a string can live at, and compares it against the two lists
    below. A field added to the plan fails here until a person decides which of
    the two it belongs in, which is the only moment at which that decision can
    be made honestly.
  */
  const unwrap = (node) => {
    let def = node?._zod?.def;
    while (def && ["optional", "nullable", "default", "catch"].includes(def.type)) {
      node = def.innerType;
      def = node?._zod?.def;
    }
    return node;
  };
  const found = new Set();
  const walk = (node, trail, seen) => {
    node = unwrap(node);
    const def = node?._zod?.def;
    if (!def || seen.has(node)) return;
    seen.add(node);
    if (def.type === "object") {
      for (const [key, value] of Object.entries(def.shape)) walk(value, trail ? `${trail}.${key}` : key, seen);
      return;
    }
    if (def.type === "array") { walk(def.element, `${trail}[]`, seen); return; }
    if (def.type === "union") { for (const option of def.options) walk(option, trail, seen); return; }
    if (def.type === "string") found.add(trail);
  };
  for (const option of EditOperation._zod.def.options) walk(option, "", new Set());

  check("the walk found the schema's string fields at all", found.size > 10, String(found.size));

  /** Their recording's own words. Shaped, never stored. */
  const FROM_THE_VIDEO = ["cues[].text", "cues[].words[].text"];

  /**
   * Instructions, not footage: things a person told this product about an edit,
   * or ids and names the product itself chose. Kept as written, because the
   * change between two of them is the lesson.
   */
  const INSTRUCTIONS = [
    "text",
    "assetId", "assetIds[]",
    "font", "fontArabic", "language", "lut",
    "layers[].content.assetId", "layers[].content.color", "layers[].content.from",
    "layers[].content.to", "layers[].content.shell",
    "layers[].content.runs[].text", "layers[].content.runs[].color",
    "layers[].content.runs[].background",
  ];

  const classified = new Set([...FROM_THE_VIDEO, ...INSTRUCTIONS]);
  const unclassified = [...found].filter((f) => !classified.has(f)).sort();
  check(
    "and every one of them has been put in a list by a person",
    unclassified.length === 0,
    unclassified.join(", ") + " — decide whether it came out of their video before it reaches the table",
  );

  const gone = [...classified].filter((f) => !found.has(f)).sort();
  check(
    "and nothing is classified that the schema no longer has",
    gone.length === 0,
    gone.join(", ") + " — a list entry for a field that is gone is a list nobody is reading",
  );

  // And the redaction agrees with the lists, rather than the lists being prose
  // beside it: every path named as video-derived is one the module shapes.
  const shaped = redactPlan({
    version: 1,
    operations: [{ type: "burnCaptions", style: "karaoke", position: "bottom", size: "medium",
      cues: [{ start: 0, end: 1, text: SECRET, words: [{ start: 0, end: 1, text: SECRET }] }] }],
  });
  check("the module shapes exactly what this section says it does",
    !JSON.stringify(shaped).includes(SECRET), JSON.stringify(shaped));
}

section("What changed, as a list rather than as two documents");
{
  const before = {
    version: 1,
    operations: [
      { type: "removeSilence", thresholdDb: -35, minSilenceMs: 320, paddingMs: 60 },
      { type: "motionTitle", text: "Chapter two", at: 12, durationSeconds: 2.5, style: "card", position: "center" },
    ],
  };
  const after = {
    version: 1,
    operations: [
      { type: "removeSilence", thresholdDb: -35, minSilenceMs: 500, paddingMs: 60 },
      { type: "motionTitle", text: "Chapter two", at: 12, durationSeconds: 4, style: "lower-third", position: "bottom" },
    ],
  };

  const pair = pairFrom(before, after);
  const field = (name) => pair.changes.find((c) => c.field === name);
  check("a threshold the customer moved is one change",
    field("minSilenceMs")?.from === 320 && field("minSilenceMs")?.to === 500, JSON.stringify(field("minSilenceMs")));
  check("and so is a title held longer",
    field("durationSeconds")?.from === 2.5 && field("durationSeconds")?.to === 4, JSON.stringify(field("durationSeconds")));
  check("and a style they preferred", field("style")?.to === "lower-third", JSON.stringify(field("style")));
  check("nothing they did not touch is listed",
    !pair.changes.some((c) => c.field === "thresholdDb" || c.field === "paddingMs"),
    JSON.stringify(pair.changes.map((c) => c.field)));
  check("the change names which operation it was about",
    field("minSilenceMs")?.op === "removeSilence", field("minSilenceMs")?.op);
  check("and the pair keeps both plans, because a change means nothing without what it changed",
    pair.before.length === 2 && pair.after.length === 2);
  check("and the pair carries what they wrote, because a rewrite is a correction",
    JSON.stringify(pair).includes("Chapter"), JSON.stringify(pair).slice(0, 120));

  const added = pairFrom(before, {
    version: 1,
    operations: [...before.operations, { type: "addMusic", assetId: "a", volumeDb: -18, fadeInMs: 500, fadeOutMs: 500, duckDb: -8, startSeconds: 0, loop: true }],
  });
  check("an operation they added is structure, not a field",
    added.structure.some((s) => s.op === "addMusic" && s.kind === "added"), JSON.stringify(added.structure));
  const removed = pairFrom(before, { version: 1, operations: [before.operations[0]] });
  check("and one they took away is too",
    removed.structure.some((s) => s.op === "motionTitle" && s.kind === "removed"), JSON.stringify(removed.structure));

  /*
    A title rewritten is a correction, and one of the most useful there is.
    "Your three words should have been five" is only a lesson if both sets of
    words are there — this is an instruction they gave us, not a frame of their
    video, so it is kept as written.
  */
  const rewritten = pairFrom(before, {
    version: 1,
    operations: [before.operations[0], { ...before.operations[1], text: "A rather longer chapter title" }],
  });
  const words = rewritten.changes.find((c) => c.field === "text");
  check("a rewritten line is a change from what they had to what they wanted",
    words?.from === "Chapter two" && words?.to === "A rather longer chapter title", JSON.stringify(words));
}

section("A customer pressing the button twice is not a lesson");
{
  const plan = {
    version: 1,
    operations: [{ type: "motionTitle", text: "Chapter two", at: 12, durationSeconds: 2.5, style: "card", position: "center" }],
  };
  check("an identical re-render is not worth keeping", !worthKeeping(pairFrom(plan, plan)));
  check("and a real correction is",
    worthKeeping(pairFrom(plan, { version: 1, operations: [{ ...plan.operations[0], durationSeconds: 4 }] })));
  /*
    Including a change to nothing but the words.

    The shape moved, so the pair has something to say; a rewrite that kept the
    same number of words in the same script has not been dropped by accident
    either, because the characters moved with it.
  */
  check("so is a line rewritten to the same length in different words",
    worthKeeping(pairFrom(plan, { version: 1, operations: [{ ...plan.operations[0], text: "Section three" }] })) === true);
}

await rm(buildDir, { recursive: true, force: true });
console.log(`\n${passed}/${passed + failed} checks passed`);
if (failed > 0) {
  console.log(`${failed} FAILED`);
  process.exit(1);
}
console.log("We keep what we got wrong, and never what their recording said.");
