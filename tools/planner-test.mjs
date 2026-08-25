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
  check("music is offered, because there is a track", item.properties.type.enum.includes("addMusic"));
  check(
    "the only ids that exist are this project's",
    JSON.stringify(item.properties.assetId.enum) === JSON.stringify(["a1", "a2", "a3", null]),
    JSON.stringify(item.properties.assetId.enum),
  );
  // The audio id is offered now — addMusic is a real operation and a track is
  // a real choice. What must not happen is the model reaching for that id with
  // an operation that puts a file *on screen*, which the schema cannot express
  // and the kind check downstream has to catch. That is the check below, and
  // it is stronger than the one it replaced: the old version only proved the
  // id was withheld, which stopped being true the moment music shipped.
  const misuse = createPlanner({
    apiKey: "k",
    fetchImpl: answering([{ type: "insertBRoll", assetId: "a3", atSeconds: 4, durationSeconds: 3 }]),
  });
  const misused = await misuse.plan("cut away to something", { assets: LIBRARY });
  check(
    "a track handed to b-roll is discarded, not rendered as a picture",
    !misused.operations.some((o) => o.assetId === "a3" && o.type !== "addMusic"),
    JSON.stringify(misused.operations),
  );
  // And the fallback then does the sane thing rather than leaving them with
  // nothing: the request really was for a cutaway, and there really is a clip.
  check(
    "and the keyword fallback cuts away to the clip that does exist",
    misused.operations.some((o) => o.type === "insertBRoll" && o.assetId === "a1"),
    JSON.stringify(misused.operations),
  );
  const overlaid = await createPlanner({
    apiKey: "k",
    fetchImpl: answering([{ type: "overlayImage", assetId: "a3", atSeconds: 1, durationSeconds: 3 }]),
  }).plan("put it on screen", { assets: LIBRARY });
  check(
    "and so is a track handed to an image overlay",
    !overlaid.operations.some((o) => o.type === "overlayImage"),
    JSON.stringify(overlaid.operations),
  );
  const clipAsSong = await createPlanner({
    apiKey: "k",
    fetchImpl: answering([{ type: "addMusic", assetId: "a1" }]),
  }).plan("put music under it", { assets: LIBRARY });
  check(
    "the reverse too: a clip handed to addMusic is not played as a song",
    !clipAsSong.operations.some((o) => o.type === "addMusic" && o.assetId === "a1"),
    JSON.stringify(clipAsSong.operations),
  );
  const rightTrack = await createPlanner({
    apiKey: "k",
    fetchImpl: answering([{ type: "addMusic", assetId: "a3" }]),
  }).plan("put music under it", { assets: LIBRARY });
  check(
    "while the track itself is accepted, with the bed under the voice",
    rightTrack.operations.some((o) => o.type === "addMusic" && o.assetId === "a3" && o.duck === true),
    JSON.stringify(rightTrack.operations),
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

// ─── With no model at all, which is what this deployment actually is ────────
//
// Production has no OPENAI_API_KEY. Everything above about schemas and enums is
// therefore about a path that never runs there — and for months the b-roll
// operations, the library that holds the files and the renderer that composites
// them all existed while the only sentence a customer could get back was "I
// can't cut in B-roll yet". That reply was describing the planner, not the
// product, and it read as the product.
console.log("\nThe keyword matcher can reach the library too");
{
  const planner = createPlanner({ apiKey: "" });
  const result = await planner.plan("cut in some b-roll and tighten it up", { assets: LIBRARY });
  const cutaways = result.operations.filter((o) => o.type === "insertBRoll");

  check("it is the keyword path", result.source === "keywords");
  check("b-roll becomes a real operation", cutaways.length === 1, JSON.stringify(result.operations.map((o) => o.type)));
  check("using the clip that exists", cutaways[0]?.assetId === "a1", cutaways[0]?.assetId);
  check(
    "not over the opening, where a speaker establishes who they are",
    (cutaways[0]?.at ?? 0) >= 5,
    String(cutaways[0]?.at),
  );
  check("the speaker is still heard under it", cutaways[0]?.keepSourceAudio === true);
  check("the rest of the request still works", result.operations.some((o) => o.type === "removeSilence"));
  check(
    "and the reply names the file and the moment",
    /street at night/.test(result.willDo.join(" ")) && /5s/.test(result.willDo.join(" ")),
    JSON.stringify(result.willDo),
  );
  check("nothing is listed as impossible", result.cannotYet.length === 0, JSON.stringify(result.cannotYet));
}

console.log("\nThe best N seconds is a plan, not a shrug");
{
  const planner = createPlanner({ apiKey: "" });

  const asked = await planner.plan("just give me the best 45 seconds of this", {});
  const highlight = asked.operations.find((o) => o.type === "extractHighlight");
  check("asking for the best stretch becomes extractHighlight", Boolean(highlight), JSON.stringify(asked.operations));
  check("with the length they said, not our default", highlight?.targetSeconds === 45, String(highlight?.targetSeconds));
  check(
    "and the reply promises the judgement, not the mechanism",
    /strongest 45 seconds/.test(asked.willDo.join(" ")),
    JSON.stringify(asked.willDo),
  );

  const bare = await planner.plan("pull out the strongest part and make it vertical", {});
  const dflt = bare.operations.find((o) => o.type === "extractHighlight");
  check("no number falls back to 30 seconds", dflt?.targetSeconds === 30, String(dflt?.targetSeconds));
  check(
    "and composes with the rest of the sentence",
    bare.operations.some((o) => o.type === "formatForPlatform"),
    JSON.stringify(bare.operations.map((o) => o.type)),
  );

  // "highlight each word" is the caption style; it must not start cutting
  // the video down to 30 seconds because it heard the word "highlight".
  const karaoke = await planner.plan("caption it and highlight each word as it is said", {});
  check(
    "caption-highlighting does not trigger the cut",
    !karaoke.operations.some((o) => o.type === "extractHighlight"),
    JSON.stringify(karaoke.operations.map((o) => o.type)),
  );

  const absurd = await planner.plan("keep only the best 300 seconds", {});
  const clamped = absurd.operations.find((o) => o.type === "extractHighlight");
  check("an absurd length is clamped, not refused", clamped?.targetSeconds === 120, String(clamped?.targetSeconds));
}

// The mirror image of the highlight: the person names the moments, and no
// judgement is invited. This is also the substrate the clipping feature will
// stand on — a clip is a range some chooser decided on.
console.log("\nThe stretch they name is kept exactly");
{
  const planner = createPlanner({ apiKey: "" });

  const mmss = await planner.plan("keep just 1:20 to 2:10 and caption it", {});
  const range = mmss.operations.find((o) => o.type === "extractRange");
  check("1:20 to 2:10 becomes extractRange", Boolean(range), JSON.stringify(mmss.operations));
  check("in seconds on the source clock", range?.startSeconds === 80 && range?.endSeconds === 130, JSON.stringify(range));
  check(
    "said back as moments, not numbers",
    /1:20/.test(mmss.willDo.join(" ")) && /2:10/.test(mmss.willDo.join(" ")),
    JSON.stringify(mmss.willDo),
  );
  check("and composes with captions", mmss.operations.some((o) => o.type === "autoCaptions"));

  const minutes = await planner.plan("cut minute 2 to minute 3 out of this for me", {});
  const m = minutes.operations.find((o) => o.type === "extractRange");
  check("minutes convert to the marks they name", m?.startSeconds === 120 && m?.endSeconds === 180, JSON.stringify(m));

  const seconds = await planner.plan("from 40 to 90 seconds please", {});
  const s = seconds.operations.find((o) => o.type === "extractRange");
  check("a seconds pair works too", s?.startSeconds === 40 && s?.endSeconds === 90, JSON.stringify(s));

  const first = await planner.plan("give me the first 40 seconds, vertical", {});
  const f = first.operations.find((o) => o.type === "extractRange");
  check("the first N seconds starts at zero", f?.startSeconds === 0 && f?.endSeconds === 40, JSON.stringify(f));
  check(
    "and composes with the reframe",
    first.operations.some((o) => o.type === "formatForPlatform"),
    JSON.stringify(first.operations.map((o) => o.type)),
  );

  const arabic = await planner.plan("خذ من الدقيقة 2 إلى الدقيقة 3", {});
  const ar = arabic.operations.find((o) => o.type === "extractRange");
  check("Arabic minutes are understood", ar?.startSeconds === 120 && ar?.endSeconds === 180, JSON.stringify(ar));

  const inverted = await planner.plan("keep 2:10 to 1:20", {});
  const inv = inverted.operations.find((o) => o.type === "extractRange");
  check("an inverted window is re-ordered, not refused", inv?.startSeconds === 80 && inv?.endSeconds === 130, JSON.stringify(inv));

  // "The first 3 seconds" is hook territory, and the hook is built now — so
  // it produces a cold open rather than a cut, and nothing is refused. What
  // it must still never do is silently trim the video to three seconds.
  const hook = await planner.plan("build a hook from the first 3 seconds", {});
  check(
    "the first 3 seconds is a hook, never a three-second cut",
    !hook.operations.some((o) => o.type === "extractRange") &&
      hook.operations.some((o) => o.type === "coldOpen"),
    JSON.stringify({ ops: hook.operations, cannot: hook.cannotYet }),
  );

  const ratio = await planner.plan("make it 9:16 for tiktok", {});
  check(
    "9:16 is an aspect ratio, not a stretch",
    !ratio.operations.some((o) => o.type === "extractRange"),
    JSON.stringify(ratio.operations.map((o) => o.type)),
  );

  const best = await planner.plan("give me the best 45 seconds", {});
  check(
    "'the best 45 seconds' stays the worker's judgement",
    !best.operations.some((o) => o.type === "extractRange") &&
      best.operations.some((o) => o.type === "extractHighlight"),
    JSON.stringify(best.operations.map((o) => o.type)),
  );
}

// Several pieces, each its own output — the clipping feature's front door.
console.log("\nAsking for clips is a plan for several outputs");
{
  const planner = createPlanner({ apiKey: "" });

  const counted = await planner.plan("give me 3 clips from this for tiktok", {});
  const clips = counted.operations.find((o) => o.type === "extractClips");
  check("'3 clips' becomes extractClips", Boolean(clips), JSON.stringify(counted.operations));
  check("with the count they said", clips?.count === 3, String(clips?.count));
  check(
    "and composes with the reframe",
    counted.operations.some((o) => o.type === "formatForPlatform"),
    JSON.stringify(counted.operations.map((o) => o.type)),
  );
  check(
    "the reply promises pieces, not one video",
    /3 separate clips/.test(counted.willDo.join(" ")),
    JSON.stringify(counted.willDo),
  );

  const sized = await planner.plan("cut this into 2 clips of 20 seconds each", {});
  const two = sized.operations.find((o) => o.type === "extractClips");
  check("a per-clip length is heard too", two?.count === 2 && two?.targetSeconds === 20, JSON.stringify(two));

  const into = await planner.plan("split it into shorts please", {});
  const dflt = into.operations.find((o) => o.type === "extractClips");
  check("'into shorts' with no number defaults to three", dflt?.count === 3, JSON.stringify(dflt));

  const greedy = await planner.plan("make me 10 clips", {});
  const capped = greedy.operations.find((o) => o.type === "extractClips");
  check("ten clips is clamped to six, not refused", capped?.count === 6, String(capped?.count));

  const best = await planner.plan("give me the best 3 clips", {});
  check(
    "'the best 3 clips' is a clips ask, not a highlight",
    best.operations.some((o) => o.type === "extractClips") &&
      !best.operations.some((o) => o.type === "extractHighlight"),
    JSON.stringify(best.operations.map((o) => o.type)),
  );

  const arabic = await planner.plan("قسّم الفيديو إلى مقاطع", {});
  check(
    "the Arabic verb for dividing is understood",
    arabic.operations.some((o) => o.type === "extractClips"),
    JSON.stringify(arabic.operations.map((o) => o.type)),
  );

  // The words that must NOT trigger it: the video itself, and b-roll.
  const bare = await planner.plan("tighten this clip up for me", {});
  check(
    "'this clip' is the video, not a clips ask",
    !bare.operations.some((o) => o.type === "extractClips"),
    JSON.stringify(bare.operations.map((o) => o.type)),
  );
  const broll = await planner.plan("insert a clip of the city here", { assets: LIBRARY });
  check(
    "a b-roll ask stays a b-roll ask",
    !broll.operations.some((o) => o.type === "extractClips"),
    JSON.stringify(broll.operations.map((o) => o.type)),
  );
}

// The first transition: a fade at the ends, never between cuts.
console.log("\nAsking for a fade is a plan for the ends");
{
  const planner = createPlanner({ apiKey: "" });

  const asked = await planner.plan("fade it in and out please", {});
  const fade = asked.operations.find((o) => o.type === "fade");
  check("'fade it in and out' becomes a fade", Boolean(fade), JSON.stringify(asked.operations));
  check("half a second by default", fade?.durationMs === 500, String(fade?.durationMs));
  check(
    "and the reply promises black at both ends",
    /from black/.test(asked.willDo.join(" ")),
    JSON.stringify(asked.willDo),
  );

  const toBlack = await planner.plan("end it with a fade to black", {});
  check(
    "'fade to black' is heard",
    toBlack.operations.some((o) => o.type === "fade"),
    JSON.stringify(toBlack.operations.map((o) => o.type)),
  );

  const arabic = await planner.plan("أضف تلاشي في البداية والنهاية", {});
  check(
    "and so is the Arabic",
    arabic.operations.some((o) => o.type === "fade"),
    JSON.stringify(arabic.operations.map((o) => o.type)),
  );

  const composed = await planner.plan("cut the silences and fade it out, vertical for tiktok", {});
  const types = composed.operations.map((o) => o.type);
  check(
    "it composes with the rest of the plan",
    types.includes("removeSilence") && types.includes("fade") && types.includes("formatForPlatform"),
    JSON.stringify(types),
  );

  const plain = await planner.plan("tighten it up for tiktok", {});
  check(
    "nobody asked for a fade, nobody gets one",
    !plain.operations.some((o) => o.type === "fade"),
    JSON.stringify(plain.operations.map((o) => o.type)),
  );
  check(
    "and nobody gets a dissolve either",
    !plain.operations.some((o) => o.type === "transition"),
    JSON.stringify(plain.operations.map((o) => o.type)),
  );

  // The model path: an out-of-range duration is clamped, not refused — the
  // person plainly wanted a fade, and losing it to a keyword fallback would
  // lose the rest of their plan's nuance with it.
  const modelled = createPlanner({ apiKey: "k", fetchImpl: answering([{ type: "fade", durationSeconds: 9 }]) });
  const clamped = await modelled.plan("a slow fade at the end", {});
  const mFade = clamped.operations.find((o) => o.type === "fade");
  check("a nine-second fade from the model becomes the two-second cap", mFade?.durationMs === 2000, JSON.stringify(clamped.operations));
}

// Three shapes now: the vertical feeds, YouTube's widescreen, and the square
// several feeds share. The pricing page sold "Long-form: YouTube" long before
// the renderer could make anything but 9:16.
console.log("\nThe frame follows the platform that was named");
{
  const planner = createPlanner({ apiKey: "" });

  const yt = await planner.plan("make this landscape for youtube", {});
  const ytOp = yt.operations.find((o) => o.type === "formatForPlatform");
  check("'for youtube' is widescreen, not shorts", ytOp?.platform === "youtube", JSON.stringify(ytOp));
  check("and the reply says 16:9, not 9:16", /16:9/.test(yt.willDo.join(" ")), JSON.stringify(yt.willDo));

  const shorts = await planner.plan("cut this up for youtube shorts", {});
  const shortsOp = shorts.operations.find((o) => o.type === "formatForPlatform");
  check("'youtube shorts' is still vertical", shortsOp?.platform === "shorts", JSON.stringify(shortsOp));

  const square = await planner.plan("make it square for the feed", {});
  const squareOp = square.operations.find((o) => o.type === "formatForPlatform");
  check("'square' is its own shape", squareOp?.platform === "square", JSON.stringify(squareOp));
  check("and the reply says 1:1", /1:1/.test(square.willDo.join(" ")), JSON.stringify(square.willDo));

  const insta = await planner.plan("for instagram please", {});
  check(
    "instagram on its own is still a reel",
    insta.operations.find((o) => o.type === "formatForPlatform")?.platform === "reels",
    JSON.stringify(insta.operations),
  );

  const tik = await planner.plan("vertical for tiktok", {});
  check(
    "and nothing about the vertical feeds changed",
    tik.operations.find((o) => o.type === "formatForPlatform")?.platform === "tiktok",
    JSON.stringify(tik.operations),
  );

  // The model path: the widened enum reaches it too.
  const modelled = createPlanner({ apiKey: "k", fetchImpl: answering([{ type: "formatForPlatform", platform: "youtube" }]) });
  const fromModel = await modelled.plan("put it on youtube", {});
  check(
    "the model may choose widescreen as well",
    fromModel.operations.find((o) => o.type === "formatForPlatform")?.platform === "youtube",
    JSON.stringify(fromModel.operations),
  );
}

// The other transition: the join, not the ends.
console.log("\nAsking for a dissolve is a plan for the joins");
{
  const planner = createPlanner({ apiKey: "" });

  const asked = await planner.plan("cut the silences and crossfade between the cuts", {});
  const dissolve = asked.operations.find((o) => o.type === "transition");
  check("'crossfade' becomes a transition", Boolean(dissolve), JSON.stringify(asked.operations.map((o) => o.type)));
  check("a quarter of a second by default", dissolve?.durationMs === 250, String(dissolve?.durationMs));
  check(
    "and it rides along with the cut it needs to have something to join",
    asked.operations.some((o) => o.type === "removeSilence"),
    JSON.stringify(asked.operations.map((o) => o.type)),
  );
  check(
    "the reply says what the viewer will see",
    /dissolve between the cuts/.test(asked.willDo.join(" ")),
    JSON.stringify(asked.willDo),
  );

  // "fade to black" and "crossfade" are opposite ends of the same word. The
  // one must never trip the other.
  check(
    "a crossfade ask is not also a fade to black",
    !asked.operations.some((o) => o.type === "fade"),
    JSON.stringify(asked.operations.map((o) => o.type)),
  );
  const ends = await planner.plan("fade it in and out please", {});
  check(
    "and a fade ask is not also a dissolve",
    !ends.operations.some((o) => o.type === "transition"),
    JSON.stringify(ends.operations.map((o) => o.type)),
  );

  const smooth = await planner.plan("make the cuts smoother, less jumpy", {});
  check(
    "'smooth the cuts' is heard as the join",
    smooth.operations.some((o) => o.type === "transition"),
    JSON.stringify(smooth.operations.map((o) => o.type)),
  );

  const arabic = await planner.plan("خلي انتقال ناعم بين القصات", {});
  check(
    "and so is the Arabic",
    arabic.operations.some((o) => o.type === "transition"),
    JSON.stringify(arabic.operations.map((o) => o.type)),
  );

  // Said plainly, with nothing else, "transitions" means both — because that
  // is what the word means to someone who has never seen this menu.
  const both = await planner.plan("add some transitions please", {});
  const types = both.operations.map((o) => o.type);
  check("a bare transitions ask produces both kinds", types.includes("fade") && types.includes("transition"), JSON.stringify(types));
}

// The shapes, and the direction words that pick between them.
console.log("\nA transition with a shape is heard as that shape");
{
  const planner = createPlanner({ apiKey: "" });
  const styleOf = async (sentence) => {
    const plan = await planner.plan(sentence, {});
    return plan.operations.find((o) => o.type === "transition")?.style ?? null;
  };

  check("'wipe' alone is a left wipe", (await styleOf("cut the silences and wipe between the shots")) === "wipeLeft");
  check("'wipe right' is the other way", (await styleOf("wipe right between the shots")) === "wipeRight");
  check("'wipe up' too", (await styleOf("wipe up between the cuts")) === "wipeUp");
  check("'slide' alone is a left slide", (await styleOf("slide between the shots")) === "slideLeft");
  check("'push right' is a slide, because that is what people call it", (await styleOf("push right between the shots")) === "slideRight");
  check("'flash' is the white one", (await styleOf("put a white flash between the cuts")) === "flash");
  check("and the Arabic is heard", (await styleOf("خلي ومضة بين القصات")) === "flash");

  // A named shape beats the general word. Somebody who said "wipe" asked for a
  // wipe; answering the vaguer half of their sentence is answering somebody
  // else's question.
  check(
    "a named shape wins over a bare 'transitions'",
    (await styleOf("add transitions, wipe between the cuts")) === "wipeLeft",
  );
  check("and with nothing named it is still the dissolve", (await styleOf("add some transitions please")) === "dissolve");

  // The word has to be about the join. "Slide" turns up in sentences that are
  // not asking for one at all.
  const notATransition = await planner.plan("make a slideshow of my photos", {});
  check(
    "a sentence that merely contains the word is not a transition ask",
    !notATransition.operations.some((o) => o.type === "transition"),
    JSON.stringify(notATransition.operations.map((o) => o.type)),
  );
}

// The list of things we cannot do has to shrink as things get built, or it
// lies in the other direction.
console.log("\nWhat we cannot do yet is claimed no wider than it is");
{
  const planner = createPlanner({ apiKey: "" });

  const asked = await planner.plan("add some transitions please", {});
  check(
    "a bare transitions ask now produces the fade that exists",
    asked.operations.some((o) => o.type === "fade"),
    JSON.stringify(asked.operations.map((o) => o.type)),
  );
  check(
    "and no longer claims transitions are impossible",
    !asked.cannotYet.some((c) => /transition/i.test(c)),
    JSON.stringify(asked.cannotYet),
  );

  const between = await planner.plan("crossfade between the cuts", {});
  check(
    "the join between two cuts now produces the dissolve that exists",
    between.operations.some((o) => o.type === "transition"),
    JSON.stringify(between.operations.map((o) => o.type)),
  );
  check(
    "and is no longer claimed as missing",
    !between.cannotYet.some((c) => /between the cuts|crossfade|dissolve/i.test(c)),
    JSON.stringify(between.cannotYet),
  );

  const shaped = await planner.plan("wipe from one shot to the next", {});
  check(
    "a shaped transition is built now, not admitted as missing",
    shaped.operations.some((o) => o.type === "transition"),
    JSON.stringify(shaped.operations.map((o) => o.type)),
  );
  check(
    "and nothing about transitions is left on the cannot-do list",
    !shaped.cannotYet.some((c) => /wipe|slide|transition/i.test(c)),
    JSON.stringify(shaped.cannotYet),
  );

  const hook = await planner.plan("add a hook at the start", {});
  check(
    "a hook ask now produces the cold open that exists",
    hook.operations.some((o) => o.type === "coldOpen"),
    JSON.stringify(hook.operations.map((o) => o.type)),
  );
  check(
    "and the hook is no longer on the cannot-do list",
    !hook.cannotYet.some((c) => /hook/i.test(c)),
    JSON.stringify(hook.cannotYet),
  );
  const arabicHook = await planner.plan("ابدأ بالأقوى", {});
  check(
    "and the Arabic ask is heard too",
    arabicHook.operations.some((o) => o.type === "coldOpen"),
    JSON.stringify(arabicHook.operations.map((o) => o.type)),
  );

  const colour = await planner.plan("make the colour more cinematic", {});
  check(
    "a colour ask points at reference matching instead of refusing the subject",
    colour.cannotYet.some((c) => /match it/i.test(c)),
    JSON.stringify(colour.cannotYet),
  );

  const music = await planner.plan("add music to it", {});
  check(
    "and what really is missing is still refused plainly",
    music.cannotYet.some((c) => /music/i.test(c)),
    JSON.stringify(music.cannotYet),
  );
}

console.log("\nAsking for what the project does not have");
{
  const planner = createPlanner({ apiKey: "" });
  const result = await planner.plan("cut in some b-roll", { assets: [] });
  check("no operation is invented", result.operations.length === 0);
  check(
    "and the reason is the missing file, not a missing feature",
    /no clips to cut to/.test(result.cannotYet.join(" ")),
    JSON.stringify(result.cannotYet),
  );
}

console.log("\nA logo goes in the corner, not over the face");
{
  const planner = createPlanner({ apiKey: "" });
  const result = await planner.plan("put my logo on it", { assets: LIBRARY });
  const overlay = result.operations.find((o) => o.type === "overlayImage");
  check("the image is used", overlay?.assetId === "a2", JSON.stringify(result.operations));
  check("in a corner", overlay?.position === "top-right", overlay?.position);
  check("small enough not to be the subject", (overlay?.scale ?? 1) <= 0.3, String(overlay?.scale));
}

console.log("\nTitles: their words or none");
{
  const planner = createPlanner({ apiKey: "" });
  const quoted = await planner.plan('add a title saying "Half the price" please', { assets: LIBRARY });
  const title = quoted.operations.find((o) => o.type === "motionTitle");
  check("a quoted phrase becomes the title", title?.text === "Half the price", JSON.stringify(title));

  const unquoted = await planner.plan("put a title on it", { assets: LIBRARY });
  check(
    "and without quotes nothing is written for them",
    !unquoted.operations.some((o) => o.type === "motionTitle"),
    JSON.stringify(unquoted.operations),
  );
  check(
    "but they are told how to get one",
    /put them in quotes/.test(unquoted.cannotYet.join(" ")),
    JSON.stringify(unquoted.cannotYet),
  );

  // "caption" is a different feature and must not be hijacked by this.
  const captions = await planner.plan("add captions", { assets: LIBRARY });
  check(
    "asking for captions still means captions",
    captions.operations.some((o) => o.type === "autoCaptions") &&
      !captions.operations.some((o) => o.type === "motionTitle"),
    JSON.stringify(captions.operations.map((o) => o.type)),
  );
}

console.log("\nAn audio file is not something to put on screen");
{
  const planner = createPlanner({ apiKey: "" });
  const result = await planner.plan("cut in b-roll and show the logo", {
    assets: [{ id: "only-audio", kind: "audio", label: "a voice note" }],
  });
  check("nothing is placed", result.operations.length === 0, JSON.stringify(result.operations));
  check("and both are explained", result.cannotYet.length === 2, JSON.stringify(result.cannotYet));
}

console.log("\nMusic comes from the person's own library or not at all");
{
  const planner = createPlanner({ apiKey: "" });
  const withTrack = await planner.plan("add some music under it", { assets: LIBRARY });
  const op = withTrack.operations.find((o) => o.type === "addMusic");
  check("a music ask places a bed from the library", !!op, JSON.stringify(withTrack.operations));
  check("named by id, and the id is the audio file", op?.assetId === "a3", JSON.stringify(op));
  check("under the voice rather than level with it", op?.gainDb === -18 && op?.duck === true, JSON.stringify(op));
  check(
    "and the reply says which file it used",
    withTrack.willDo.some((w) => /a voice note/.test(w) && /under the whole edit/.test(w)),
    JSON.stringify(withTrack.willDo),
  );

  // No catalogue. The honest answer names the fix, not the limitation.
  const without = await planner.plan("can you put background music on this", { assets: [] });
  check("with nothing to play, no bed is invented", !without.operations.some((o) => o.type === "addMusic"), JSON.stringify(without.operations));
  check(
    "and the reply asks for the track rather than refusing music",
    without.cannotYet.some((c) => /upload the track you have the rights to/.test(c)),
    JSON.stringify(without.cannotYet),
  );

  // Syncing the cuts to a rhythm is a different feature and still unbuilt.
  const beat = await planner.plan("cut it to the beat", { assets: LIBRARY });
  check(
    "asking to cut to the beat still gets an honest no",
    beat.cannotYet.some((c) => /cut the picture to the beat/.test(c)),
    JSON.stringify(beat.cannotYet),
  );
  check(
    "and does not quietly lay a bed instead of the thing asked for",
    !beat.operations.some((o) => o.type === "addMusic"),
    JSON.stringify(beat.operations),
  );

  // Both asks in one sentence get both answers.
  const bothAsks = await planner.plan("add music and cut to the beat", { assets: LIBRARY });
  check(
    "a sentence asking for both gets the bed and the refusal",
    bothAsks.operations.some((o) => o.type === "addMusic") &&
      bothAsks.cannotYet.some((c) => /cut the picture to the beat/.test(c)),
    JSON.stringify([bothAsks.operations, bothAsks.cannotYet]),
  );

  const arabic = await planner.plan("ضيف موسيقى خلفية", { assets: LIBRARY });
  check("the Arabic ask is heard too", arabic.operations.some((o) => o.type === "addMusic"), JSON.stringify(arabic.operations));
}

console.log("\nA hook and a transition happen together again");
{
  const planner = createPlanner({ apiKey: "" });

  // For one round this pair was refused at plan time: a cold open reorders the
  // cut list, and the renderer's chained crossfade over a reordered list
  // deadlocked. The renderer now seeks each piece on its own input, so both
  // halves happen — and the reply is allowed to promise both again. This is
  // here so that a future refusal has to be a deliberate act rather than a
  // regression nobody noticed.
  const both = await planner.plan("start with the best bit and put dissolves between the cuts", {});
  check(
    "the hook is planned",
    both.operations.some((o) => o.type === "coldOpen"),
    JSON.stringify(both.operations.map((o) => o.type)),
  );
  check(
    "and so is the transition",
    both.operations.some((o) => o.type === "transition"),
    JSON.stringify(both.operations.map((o) => o.type)),
  );
  check("with nothing withheld", both.cannotYet.length === 0, JSON.stringify(both.cannotYet));

  const reply = replyFor(both, { hasVideo: true });
  check("and the reply promises both", /open on the strongest moment/.test(reply) && /dissolve between the cuts/.test(reply), reply);

  const faded = await planner.plan("give it a hook and fade it in and out", {});
  check(
    "a fade still composes with a hook",
    faded.operations.some((o) => o.type === "coldOpen") && faded.operations.some((o) => o.type === "fade"),
    JSON.stringify(faded.operations.map((o) => o.type)),
  );
}

await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("A model can choose the edit; it cannot make the product lie.");
