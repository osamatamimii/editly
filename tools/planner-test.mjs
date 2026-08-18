/**
 * Checks the planner without an OpenAI key.
 *
 * The property under test is not "does the model choose well" — that is a
 * judgement, and it belongs in the quality harness once there is a key. It is
 * the harder guarantee: that a model cannot make this product lie. Whatever the
 * model returns, the plan that reaches the worker is one the worker can execute,
 * and the sentence the user reads describes that plan and nothing else.
 *
 * So every check here feeds the planner a deliberately hostile answer — an
 * operation that does not exist, a zoom of 3.0, prose where JSON was promised,
 * a timeout, a 500 — and asserts the product stays honest.
 *
 * Usage: node tools/planner-test.mjs
 * Requires: nothing. No keys, no network, no ffmpeg.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-planner-build-"));
const outfile = path.join(buildDir, "planner.mjs");

const built = spawnSync(
  require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/api-server"] }),
  [
    path.join(repoRoot, "artifacts/api-server/src/lib/planner.ts"),
    "--bundle", "--platform=node", "--format=esm", "--target=node22",
    `--outfile=${outfile}`, "--log-level=error",
  ],
  { stdio: "inherit" },
);
if (built.status !== 0) {
  console.error("could not bundle the planner");
  process.exit(1);
}

const { createPlanner, replyFor } = await import(pathToFileURL(outfile).href);

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

/** A stub that answers with whatever operations a test wants to inject. */
const answering = (operations, extra = {}) => async () =>
  new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify({ operations, ...extra }) } }] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );

console.log("\nWith no key at all");
{
  const planner = createPlanner({ apiKey: "" });
  check("it reports itself unavailable rather than pretending", planner.available === false, "");

  const result = await planner.plan("cut the dead air and make it vertical for tiktok", {});
  check("the keyword matcher still produces a plan", result.operations.length >= 2, JSON.stringify(result.operations.map((o) => o.type)));
  check("and says which path produced it", result.source === "keywords", result.source);
}

console.log("\nWhen the model answers well");
{
  const planner = createPlanner({
    apiKey: "test-key",
    fetchImpl: answering([
      { type: "removeSilence", minSilenceMs: 400 },
      { type: "autoCaptions", captionStyle: "karaoke-box", captionAnimation: "karaoke" },
      { type: "formatForPlatform", platform: "reels" },
    ]),
  });
  const result = await planner.plan("tighten it up, karaoke captions, for reels", {});

  check("the plan is the model's", result.source === "model", result.source);
  check(
    "and carries exactly what it chose",
    result.operations.map((o) => o.type).join(",") === "removeSilence,autoCaptions,formatForPlatform",
    JSON.stringify(result.operations.map((o) => o.type)),
  );
  check("its parameters survive", result.operations[0].minSilenceMs === 400 && result.operations[1].style === "karaoke-box", JSON.stringify(result.operations[0]));

  const reply = replyFor(result, { hasVideo: true });
  check("the reply names the captions", /caption it/.test(reply), reply);
  check("and the reframe", /reels/.test(reply), reply);
  check("and promises nothing else", !/music|b-roll|emoji|colou?r/i.test(reply), reply);
}

console.log("\nWhen the model answers badly");
{
  const invented = createPlanner({
    apiKey: "k",
    fetchImpl: answering([{ type: "addBRoll" }, { type: "syncToBeat" }]),
  });
  const result = await invented.plan("add b-roll and sync it to the beat", {});
  check(
    "an operation the worker does not have is discarded, not attempted",
    result.operations.every((o) => o.type !== "addBRoll" && o.type !== "syncToBeat"),
    JSON.stringify(result.operations.map((o) => o.type)),
  );
  check("and we say the model gave us nothing usable", /nothing we could execute/.test(result.degraded ?? ""), result.degraded);
  check("falling back rather than failing", result.source === "keywords", result.source);

  const outOfRange = createPlanner({
    apiKey: "k",
    fetchImpl: answering([{ type: "kenBurns", zoomTo: 3.0 }, { type: "removeSilence" }]),
  });
  const clamped = await outOfRange.plan("push in hard", {});
  check(
    "a zoom the schema forbids is rejected outright, not quietly clamped",
    !clamped.operations.some((o) => o.type === "kenBurns"),
    JSON.stringify(clamped.operations),
  );
  check("while the valid operation beside it survives", clamped.operations.some((o) => o.type === "removeSilence"), "");

  const prose = createPlanner({
    apiKey: "k",
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: "Sure! I'd love to help." } }] }), { status: 200 }),
  });
  const proseResult = await prose.plan("caption it", {});
  check("prose where JSON was promised falls back", proseResult.source === "keywords", proseResult.source);
  check("and the fallback still captions it", proseResult.operations.some((o) => o.type === "autoCaptions"), JSON.stringify(proseResult.operations.map((o) => o.type)));
}

console.log("\nWhen the model is not there");
{
  const broken = createPlanner({ apiKey: "k", fetchImpl: async () => new Response("nope", { status: 500 }) });
  const result = await broken.plan("cut the silences", {});
  check("a 500 does not reach the user", result.operations.length > 0, "");
  check("it is recorded as a degradation", /500/.test(result.degraded ?? ""), result.degraded);

  const hanging = createPlanner({
    apiKey: "k",
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      }),
  });
  const slow = await hanging.plan("cut the silences", {});
  check("and neither does an unreachable one", slow.source === "keywords", slow.source);
  check("reported as such", /unreachable|timed out/.test(slow.degraded ?? ""), slow.degraded);
}

console.log("\nThe key never leaves the request");
{
  let seen = null;
  const planner = createPlanner({
    apiKey: "sk-secret-value",
    fetchImpl: async (_url, init) => {
      seen = init;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ operations: [{ type: "removeSilence" }] }) } }] }), { status: 200 });
    },
  });
  const result = await planner.plan("tighten it", {});

  check("it is sent as a bearer token", String(seen.headers.Authorization).startsWith("Bearer "), "");
  check(
    "and appears nowhere in what we return",
    !JSON.stringify(result).includes("sk-secret-value"),
    "",
  );
  check(
    "including in a degradation message",
    !String(result.degraded ?? "").includes("sk-"),
    "",
  );
}

console.log("\nThe project's platform is respected");
{
  const planner = createPlanner({ apiKey: "k", fetchImpl: answering([{ type: "formatForPlatform" }]) });
  const result = await planner.plan("make it vertical", { defaultPlatform: "shorts" });
  check(
    "a reframe with no platform named takes the project's",
    result.operations[0]?.platform === "shorts",
    JSON.stringify(result.operations[0]),
  );
}

// ─── The library, and the id a model will invent if you let it ──────────────
//
// Two of these operations name a file. A model asked to name one will name one:
// a plausible id for a clip that does not exist, every time. So the ids this
// project holds go into the schema as an enum, and are checked again on the way
// back — against the *kind* too, because the schema cannot say "a video here
// and an image there", and an image handed to insertBRoll is not a wrong edit,
// it is a worker crash.
const LIBRARY = [
  { id: "a1", kind: "video", label: "street at night" },
  { id: "a2", kind: "image", label: "the logo" },
  { id: "a3", kind: "audio", label: "a voice note" },
];

/** What the request actually asked the model for. */
function sentBody(calls) {
  return JSON.parse(calls[0][1].body);
}

console.log("\nWhat the model is allowed to choose from");
{
  const calls = [];
  const spy = (url, init) => {
    calls.push([url, init]);
    return answering([])(url, init);
  };

  const planner = createPlanner({ apiKey: "k", fetchImpl: spy });
  await planner.plan("cut to the street shot", { assets: LIBRARY });
  const body = sentBody(calls);
  const item = body.response_format.json_schema.schema.properties.operations.items;

  check("b-roll is offered, because there is a clip", item.properties.type.enum.includes("insertBRoll"));
  check("so is an overlay, because there is an image", item.properties.type.enum.includes("overlayImage"));
  check("titles need no file, so they are always offered", item.properties.type.enum.includes("motionTitle"));
  check(
    "the only ids that exist are this project's",
    JSON.stringify(item.properties.assetId.enum) === JSON.stringify(["a1", "a2", null]),
    JSON.stringify(item.properties.assetId.enum),
  );
  check(
    "the audio file is not offered as something to put on screen",
    !(item.properties.assetId.enum ?? []).includes("a3"),
  );
  check(
    "every property is required, because strict mode refuses anything else",
    item.required.length === Object.keys(item.properties).length,
    `${item.required.length} required vs ${Object.keys(item.properties).length} properties`,
  );
  check(
    "and the files are listed in the request, or the model cannot tell them apart",
    /street at night/.test(body.messages[1].content) && /a1/.test(body.messages[1].content),
  );
}

console.log("\nA project with nothing in it");
{
  const calls = [];
  const spy = (url, init) => {
    calls.push([url, init]);
    return answering([])(url, init);
  };
  const planner = createPlanner({ apiKey: "k", fetchImpl: spy });
  await planner.plan("cut in some b-roll", { assets: [] });
  const body = sentBody(calls);
  const types = body.response_format.json_schema.schema.properties.operations.items.properties.type.enum;

  check("b-roll is not on the menu", !types.includes("insertBRoll"));
  check("neither is an overlay", !types.includes("overlayImage"));
  check("titles still are", types.includes("motionTitle"));
  check(
    "and the model is told to say they need a file first",
    /add the file first/.test(body.messages[0].content),
    body.messages[0].content.slice(-120),
  );
}

console.log("\nAn id the model invented");
{
  const planner = createPlanner({
    apiKey: "k",
    fetchImpl: answering([
      { type: "insertBRoll", assetId: "not-a-real-id", atSeconds: 4, durationSeconds: 3 },
      { type: "autoCaptions" },
    ]),
  });
  const result = await planner.plan("cut to the b-roll", { assets: LIBRARY });
  check(
    "does not become an operation",
    !result.operations.some((o) => o.type === "insertBRoll"),
    JSON.stringify(result.operations.map((o) => o.type)),
  );
  check("and the real operation beside it survives", result.operations.some((o) => o.type === "autoCaptions"));
  check("so nothing in the reply promises the cutaway", !/cut away/i.test(result.willDo.join(" ")));
}

console.log("\nAn image where a clip belongs");
{
  const planner = createPlanner({
    apiKey: "k",
    fetchImpl: answering([{ type: "insertBRoll", assetId: "a2", atSeconds: 2, durationSeconds: 3 }]),
  });
  const result = await planner.plan("cut to it", { assets: LIBRARY });
  check(
    "is refused, because the worker would not survive it",
    !result.operations.some((o) => o.type === "insertBRoll"),
    JSON.stringify(result.operations),
  );
}

console.log("\nWhen it chooses well");
{
  const planner = createPlanner({
    apiKey: "k",
    fetchImpl: answering([
      { type: "insertBRoll", assetId: "a1", atSeconds: 6.5, durationSeconds: 2.5 },
      { type: "overlayImage", assetId: "a2", atSeconds: 1, durationSeconds: 4, placement: "top-right" },
      { type: "motionTitle", titleText: "  Half the price  ", atSeconds: 0.5, titleStyle: "word", placement: "bottom" },
    ]),
  });
  const result = await planner.plan("cut to the street at 6s, logo top right, and the words half the price", {
    assets: LIBRARY,
  });
  const byType = Object.fromEntries(result.operations.map((o) => [o.type, o]));

  check("the cutaway carries the clip and the moment", byType.insertBRoll?.assetId === "a1" && byType.insertBRoll?.at === 6.5);
  check(
    "and keeps the speaker's audio, because a cutaway that silences them is a cut",
    byType.insertBRoll?.keepSourceAudio === true,
  );
  check("the overlay lands in the corner it was given", byType.overlayImage?.position === "top-right");
  check("the title carries their words, trimmed and not embellished", byType.motionTitle?.text === "Half the price");
  check("in the style asked for", byType.motionTitle?.style === "word" && byType.motionTitle?.position === "bottom");
  check(
    "and the reply describes all three",
    result.willDo.length === 3 && /half the price/i.test(result.willDo.join(" ")),
    JSON.stringify(result.willDo),
  );
}

console.log("\nTitles the model got wrong");
{
  const planner = createPlanner({
    apiKey: "k",
    fetchImpl: answering([
      { type: "motionTitle", titleText: "   ", atSeconds: 1 },
      { type: "motionTitle", titleText: "ok", atSeconds: -5, placement: "top-left", titleStyle: "banner" },
    ]),
  });
  const result = await planner.plan("titles", { assets: LIBRARY });
  const titles = result.operations.filter((o) => o.type === "motionTitle");

  check("a title with no words is not a title", titles.length === 1, JSON.stringify(titles));
  check("a negative moment is clamped rather than rejected", titles[0]?.at === 0);
  check(
    "a corner is not a title position, so it takes the safe one",
    titles[0]?.position === "center",
    titles[0]?.position,
  );
  check("and a style that does not exist becomes the plain one", titles[0]?.style === "card", titles[0]?.style);
}

await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("A model can choose the edit; it cannot make the product lie.");
