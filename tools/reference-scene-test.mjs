/**
 * What the reference drew, in the language we can draw it back in.
 *
 * `graphics-test.mjs` checks the half that is arithmetic. This checks the half
 * that comes back from a model, and the whole of it is about distrust: a
 * response schema is a request rather than a guarantee, and what this file
 * accepts reaches a stylesheet and a renderer.
 *
 * The last section is the one that matters most. Whatever the model says, the
 * layers that come out are parsed by the *real* `SceneLayer` schema — the same
 * one the API validates a customer's plan against. A template that produces
 * something the schema refuses is a feature that fails at render time, on a
 * machine nobody is watching.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-scene-test-"));
const modulePath = path.join(buildDir, "scene.mjs");
const build = spawnSync(
  require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/worker"] }),
  [
    path.join(repoRoot, "artifacts/worker/src/reference-scene.ts"),
    "--bundle", "--platform=node", "--format=esm", "--target=node22",
    `--outfile=${modulePath}`, "--log-level=error",
  ],
  { stdio: "inherit" },
);
if (build.status !== 0) process.exit(1);

const { parseSceneRead, fillTemplate, readReferenceScene, MAX_MOMENTS } =
  await import(pathToFileURL(modulePath).href);
const zodBundle = path.join(buildDir, "zod.mjs");
const zodBuild = spawnSync(
  require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/worker"] }),
  [
    path.join(repoRoot, "lib/api-zod/src/index.ts"),
    "--bundle", "--platform=node", "--format=esm", "--target=node22",
    `--outfile=${zodBundle}`, "--log-level=error",
  ],
  { stdio: "inherit" },
);
if (zodBuild.status !== 0) process.exit(1);
const { SceneLayer } = await import(pathToFileURL(zodBundle).href);

let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failed += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};
const section = (name) => console.log(`\n${name}`);

/** A model reply, shaped the way the provider returns one. */
const reply = (object) => ({
  candidates: [{ content: { parts: [{ text: JSON.stringify(object) }] } }],
});

const moment = (over = {}) => ({
  at: 2,
  settledAt: 2.4,
  leavesAt: 6,
  box: { x: 0, y: 0, w: 1, h: 1 },
  enter: "rise",
  travel: 0.12,
  ...over,
});

section("The answer is reduced to things the renderer can draw");
{
  const moments = [moment()];
  const parsed = parseSceneRead(
    reply({
      moments: [{
        index: 0,
        layers: [
          { kind: "fill", x: 0, y: 0, w: 1, h: 1, color: "#ECECEC" },
          { kind: "text", x: 0.1, y: 0.4, w: 0.8, h: 0.12, size: 0.07, weight: 800, color: "#111111", align: "center", words: 3, emphasis: false },
        ],
      }],
    }),
    moments,
  );
  check("a well-formed answer comes back as a template", parsed?.moments.length === 1, JSON.stringify(parsed));
  check("with both layers", parsed?.moments[0]?.layers.length === 2);

  /*
    Timing is measured, never described.

    The model is never asked when anything happens and could not be believed if
    it were: a still has no clock in it. Every number here comes from
    `graphics.ts`, and the check is that a model *volunteering* one changes
    nothing.
  */
  const lying = parseSceneRead(
    reply({ moments: [{ index: 0, at: 99, durationSeconds: 99, enter: "drop", layers: [{ kind: "fill", x: 0, y: 0, w: 1, h: 1, color: "#fff" }] }] }),
    moments,
  );
  check("a time the model volunteered is ignored", lying?.moments[0]?.at === 2, String(lying?.moments[0]?.at));
  check("and so is an entrance it volunteered", lying?.moments[0]?.enter === "rise", lying?.moments[0]?.enter);
  check("the duration is the measured one", lying?.moments[0]?.durationSeconds === 4, String(lying?.moments[0]?.durationSeconds));

  const never = parseSceneRead(
    reply({ moments: [{ index: 0, layers: [{ kind: "fill", x: 0, y: 0, w: 1, h: 1, color: "#fff" }] }] }),
    [moment({ leavesAt: null })],
  );
  check("a moment that never left is held for a stated length rather than forever",
    never?.moments[0]?.durationSeconds === 2.5, String(never?.moments[0]?.durationSeconds));
}

section("What it refuses");
{
  const moments = [moment()];
  const bad = (layers) => parseSceneRead(reply({ moments: [{ index: 0, layers }] }), moments);

  /*
    A colour reaches a stylesheet, so it goes through the same gate the layer
    renderer uses rather than a second opinion about it. The value below is the
    one that closed `url()` and opened a new declaration.
  */
  check("a colour that is not a colour drops its layer",
    bad([{ kind: "fill", x: 0, y: 0, w: 1, h: 1, color: "red); background: url(http://x/y" }]) === null);
  check("and a real colour beside it survives on its own",
    bad([
      { kind: "fill", x: 0, y: 0, w: 1, h: 1, color: "javascript:alert(1)" },
      { kind: "fill", x: 0, y: 0, w: 1, h: 1, color: "#101010" },
    ])?.moments[0]?.layers.length === 1);

  check("a kind nobody can draw is dropped",
    bad([{ kind: "video", x: 0, y: 0, w: 1, h: 1 }]) === null);
  check("a device that is not one of the three is dropped",
    bad([{ kind: "device", x: 0, y: 0, w: 1, h: 1, device: "watch" }]) === null);

  const wild = bad([{ kind: "fill", x: -40, y: 0, w: 900, h: 1, color: "#111" }]);
  check("geometry far outside the frame is clamped rather than believed",
    wild?.moments[0]?.layers[0]?.box.w === 3 && wild?.moments[0]?.layers[0]?.box.x === -1,
    JSON.stringify(wild?.moments[0]?.layers[0]?.box));

  check("an index naming no moment is dropped",
    parseSceneRead(reply({ moments: [{ index: 7, layers: [{ kind: "fill", x: 0, y: 0, w: 1, h: 1, color: "#111" }] }] }), moments) === null);
  check("the same moment answered twice is taken once",
    parseSceneRead(reply({
      moments: [
        { index: 0, layers: [{ kind: "fill", x: 0, y: 0, w: 1, h: 1, color: "#111" }] },
        { index: 0, layers: [{ kind: "fill", x: 0, y: 0, w: 1, h: 1, color: "#222" }] },
      ],
    }), moments)?.moments.length === 1);

  check("a reply that is not JSON is nothing",
    parseSceneRead({ candidates: [{ content: { parts: [{ text: "sorry, I cannot" }] } }] }, moments) === null);
  check("and an empty reply is nothing", parseSceneRead({}, moments) === null);

  const many = bad(Array.from({ length: 20 }, () => ({ kind: "fill", x: 0, y: 0, w: 1, h: 1, color: "#111" })));
  check("and a moment cannot come back as twenty layers", many?.moments[0]?.layers.length === 6,
    String(many?.moments[0]?.layers.length));
}

section("The customer's own words go into the slots");
{
  const template = {
    moments: [{
      at: 2, durationSeconds: 4, enter: "rise", travel: 0.12,
      layers: [
        { box: { x: 0, y: 0, w: 1, h: 1 }, content: { kind: "fill", color: "#ECECEC" } },
        { box: { x: 0.1, y: 0.4, w: 0.8, h: 0.12 },
          content: { kind: "text", size: 0.07, weight: 800, color: "#111", align: "center", words: 3, emphasis: false } },
      ],
    }],
  };

  const filled = fillTemplate(template, ["Chapter two"]);
  check("the plate and the line both come out", filled.layers.length === 2, String(filled.layers.length));
  const text = filled.layers.find((l) => l.content.kind === "text");
  check("and the line carries the words that were given",
    text?.content.runs?.[0]?.text === "Chapter two", JSON.stringify(text?.content.runs));
  check("set the way the reference set it",
    text?.content.size === 0.07 && text?.content.weight === 800, JSON.stringify([text?.content.size, text?.content.weight]));
  check("at the measured time", text?.at === 2 && text?.durationSeconds === 4);
  check("with the measured entrance", text?.enter === "rise" && text?.travel === 0.12);
  check("and painted in the order the model reported",
    filled.layers[0]?.z === 0 && filled.layers[1]?.z === 1);

  /*
    A card that arrives empty is worse than one that does not arrive.

    The first spelling filled a slot it had no words for with an empty string,
    which rendered a plate with nothing on it and told nobody.

    The blank-line case is checked *first*, deliberately. Removing the guard
    makes the no-words-left case throw rather than answer, and a suite that
    stops does say something is wrong — but it stops before reaching the named
    check, so the thing that goes red is a stack trace instead of a sentence.
  */
  check("a blank line counts as no words", fillTemplate(template, ["   "]).unfilled === 1,
    String(fillTemplate(template, ["   "]).unfilled));

  const short = fillTemplate(
    { moments: [{ ...template.moments[0], layers: [...template.moments[0].layers, { box: { x: 0.1, y: 0.6, w: 0.8, h: 0.1 }, content: { kind: "text", size: 0.04, weight: 400, color: "#555", align: "center", words: 5, emphasis: false } }] }] },
    ["Only one line"],
  );
  check("a slot with no words left is dropped", short.layers.length === 2, String(short.layers.length));
  check("and counted rather than hidden", short.unfilled === 1, String(short.unfilled));

  const single = fillTemplate(
    { moments: [{ ...template.moments[0], layers: [{ ...template.moments[0].layers[1], content: { ...template.moments[0].layers[1].content, words: 1 } }] }] },
    ["Now"],
  );
  check("one word arrives as one thing, not staggered",
    single.layers[0]?.content.staggerRuns === false, String(single.layers[0]?.content.staggerRuns));
  check("and several words arrive one at a time",
    text?.content.staggerRuns === true, String(text?.content.staggerRuns));

  /*
    A count the model left out is a count, not a missing one.

    `words` never reaches the schema — its only job is to decide whether the
    line arrives as a block or a word at a time. So an absent value that fell
    through as NaN would quietly answer "one word" for every line in every
    reference, and the whole difference between a caption and a title would go
    away with nothing to see.
  */
  const countless = parseSceneRead(
    reply({ moments: [{ index: 0, layers: [{ kind: "text", x: 0.1, y: 0.4, w: 0.8, h: 0.1, size: 0.06, weight: 700, color: "#111", align: "center" }] }] }),
    [moment()],
  );
  check("a line the model gave no word count for still has one",
    countless?.moments[0]?.layers[0]?.content.words >= 1,
    String(countless?.moments[0]?.layers[0]?.content.words));
  check("and still arrives a word at a time",
    fillTemplate(countless, ["Three whole words"]).layers[0]?.content.staggerRuns === true);

  const still = fillTemplate(
    { moments: [{ ...template.moments[0], travel: 0 }] },
    ["Chapter two"],
  );
  check("a moment that did not travel does not ask for a travel",
    still.layers.every((l) => l.travel === undefined), JSON.stringify(still.layers.map((l) => l.travel)));
}

section("Whatever comes back, what comes out is drawable");
{
  /*
    The check this file exists for.

    Every layer produced is parsed by the same schema the API validates a
    customer's plan with. A model answering nonsense must still produce either
    nothing or something the renderer can draw — never something that fails at
    render time on a machine nobody is watching.
  */
  const nonsense = parseSceneRead(
    reply({
      moments: [{
        index: 0,
        layers: [
          { kind: "gradient", x: -3, y: 4, w: 0, h: -2, from: "#000", to: "hsl(200 60% 40%)", angle: 4000 },
          { kind: "device", x: 0.2, y: 0.2, w: 0.6, h: 0.6, device: "phone", shell: "#101014", shadow: 9 },
          { kind: "text", x: 0.1, y: 0.4, w: 0.8, h: 0.2, size: 90, weight: 4000, color: "rgb(17,17,17)", align: "middle", words: 400, emphasis: "yes" },
        ],
      }],
    }),
    [moment()],
  );
  check("nonsense still produces a template", nonsense !== null);

  const out = fillTemplate(nonsense, ["Words of their own"]);
  check("and it produces layers", out.layers.length === 3, String(out.layers.length));
  const results = out.layers.map((layer) => SceneLayer.safeParse(layer));
  const bad = results.map((r, i) => (r.success ? null : `${i}: ${r.error.issues[0]?.path.join(".")} ${r.error.issues[0]?.message}`)).filter(Boolean);
  check("every one of which the real schema accepts", bad.length === 0, bad.join(" | "));

  check("an alignment nobody defined falls back rather than passing through",
    out.layers[2]?.content.align === "center", String(out.layers[2]?.content.align));
  check("and 'emphasis: \"yes\"' is not true", nonsense.moments[0].layers[2].content.emphasis === false);
}

section("The ask itself");
{
  const work = await mkdtemp(path.join(tmpdir(), "editly-scene-"));
  const read = {
    measured: true,
    sampledSeconds: 20,
    moments: Array.from({ length: 9 }, (_, i) => moment({ at: i * 2, settledAt: i * 2 + 0.4 })),
  };
  // Writes a real file, because the ask reads the still back off disk and a
  // stub that only pretends turns every check below into a check that the
  // failure path works.
  const grabStill = async (_file, _at, to) => { await writeFile(to, Buffer.from([0xff, 0xd8, 0xff, 0xd9])); };
  let sent = null;
  const fetchImpl = async (_url, init) => {
    sent = JSON.parse(init.body);
    return {
      ok: true,
      json: async () => reply({ moments: [{ index: 0, layers: [{ kind: "fill", x: 0, y: 0, w: 1, h: 1, color: "#111" }] }] }),
    };
  };

  const warnings = [];
  // Without a key there is nothing to buy, and nothing to complain about.
  const none = await readReferenceScene("ref.mp4", read, { workDir: work, apiKey: "", grabStill, fetchImpl }, warnings);
  check("no key means no ask and no noise", none === null && warnings.length === 0, warnings.join("; "));

  const template = await readReferenceScene("ref.mp4", read, { workDir: work, apiKey: "k", grabStill, fetchImpl }, warnings);
  check("with a key it asks and comes back with a template", template?.moments.length === 1, JSON.stringify(template));

  const stills = sent.contents[0].parts.filter((p) => p.inlineData).length;
  check("and it asks about a handful of moments, not all of them",
    stills === MAX_MOMENTS, `${stills} stills for ${read.moments.length} moments`);

  const prose = sent.contents[0].parts.map((p) => p.text ?? "").join("\n");
  check("the measured rectangle is in the question, so the model is told where to look",
    /Rectangle: x=0\.000 y=0\.000 w=1\.000 h=1\.000/.test(prose), prose.slice(0, 120));
  /*
    The words in a customer's video are the customer's.

    This is a product decision before it is a legal one, and the only place it
    is enforced is the sentence in the prompt — so the sentence is checked.
  */
  check("and it is told not to transcribe anybody's words",
    /Do NOT transcribe the words/.test(prose));

  const refusedWarnings = [];
  const refused = await readReferenceScene(
    "ref.mp4", read,
    { workDir: work, apiKey: "k", grabStill, fetchImpl: async () => ({ ok: false, status: 429 }) },
    refusedWarnings,
  );
  check("a refusal is a null and a line, never a thrown render",
    refused === null && refusedWarnings.some((w) => w.includes("429")), refusedWarnings.join("; "));

  const thrownWarnings = [];
  const thrown = await readReferenceScene(
    "ref.mp4", read,
    { workDir: work, apiKey: "k", grabStill, fetchImpl: async () => { throw new Error("socket hang up"); } },
    thrownWarnings,
  );
  check("and so is a network that gave up",
    thrown === null && thrownWarnings.some((w) => w.includes("hang up")), thrownWarnings.join("; "));

  const nothingRead = await readReferenceScene(
    "ref.mp4", { measured: false, sampledSeconds: 0, moments: [] },
    { workDir: work, apiKey: "k", grabStill, fetchImpl }, warnings,
  );
  check("a reference that drew nothing is not asked about", nothingRead === null);

  const noStills = [];
  const failedGrab = await readReferenceScene(
    "ref.mp4", read,
    { workDir: work, apiKey: "k", grabStill: async () => { throw new Error("no"); }, fetchImpl }, noStills,
  );
  check("and a reference no still could be taken from says so",
    failedGrab === null && noStills.some((w) => w.includes("could not read a single still")), noStills.join("; "));

  await rm(work, { recursive: true, force: true });
}

await rm(buildDir, { recursive: true, force: true });
console.log(`\n${passed}/${passed + failed} checks passed`);
if (failed > 0) {
  console.log(`${failed} FAILED`);
  process.exit(1);
}
console.log("The reference is read as a template, and filled with words of their own.");
