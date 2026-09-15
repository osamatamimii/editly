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
import { readFileSync } from "node:fs";
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

// The keyword planner on its own, for the negations it reads directly.
const kwOut = path.join(buildDir, "plan-from-text.mjs");
{
  const b = spawnSync(
    require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/api-server"] }),
    [
      path.join(repoRoot, "artifacts/api-server/src/lib/plan-from-text.ts"),
      "--bundle", "--platform=node", "--format=esm", "--target=node22",
      `--outfile=${kwOut}`, "--log-level=error",
    ],
    { stdio: "inherit" },
  );
  if (b.status !== 0) { console.error("could not bundle plan-from-text"); process.exit(1); }
}
const { planFromText, saysOnlyThis, asksForAnEdit } = await import(pathToFileURL(kwOut).href);

/**
 * Every note the planner produces now carries both languages (`{ en, ar }`),
 * because the reply answers in the language it was asked in. These checks are
 * about the English wording, so they read the English half; the Arabic half is
 * checked by tools/bilingual-test.mjs.
 */
const inEnglish = (phrase) => phrase.en;

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

console.log("\nThe moments a person points at reach the plan");
{
  /*
   * `zoomPunch.at` is a list of seconds the renderer has honoured since it was
   * written, and every plan either head produced sent it empty — which means
   * "you choose". So the product could not say "here". The matcher can now;
   * this is the other head, which must not be the one that cannot.
   */
  const planner = createPlanner({
    apiKey: "k",
    fetchImpl: answering([{ type: "zoomPunch", punchAt: [12, 65.5], punchOn: "emphasis", punchAmount: 0.2 }]),
  });
  const named = await planner.plan("punch in at 0:12 and 1:05", {});
  const punch = named.operations.find((o) => o.type === "zoomPunch");
  check("the model can name moments", JSON.stringify(punch?.at) === "[12,65.5]", JSON.stringify(punch));
  check("and its amount survives with them", punch?.amount === 0.2, JSON.stringify(punch));

  /*
   * Asked for the beat *and* a moment, the moment survives — because the
   * renderer already decided this and decided it that way.
   *
   * `ffmpeg.ts` reaches for the beat grid only when `at` is empty, so an
   * explicit second is more specific than "the beat" there. The first version
   * of this planner cleared the list instead, which would have been one file
   * quietly overruling the file that runs. The check is written against the
   * renderer's rule, not against the planner's, so the two cannot drift apart
   * without this going red.
   */
  const beat = createPlanner({
    apiKey: "k",
    fetchImpl: answering([{ type: "zoomPunch", punchAt: [12], punchOn: "beat" }]),
  });
  const onBeat = (await beat.plan("punch on the beat at 0:12", {})).operations.find((o) => o.type === "zoomPunch");
  check("a named moment survives a beat ask", JSON.stringify(onBeat?.at) === "[12]", JSON.stringify(onBeat));
  // And with no track in this project the beat itself is demoted to emphasis,
  // which is existing behaviour — the point is that the moment is not demoted
  // with it.
  check("and is not thrown away when the beat cannot be honoured", onBeat?.at?.length === 1, JSON.stringify(onBeat));

  // Whatever comes back has to be numbers on a real clock. A model that
  // answers with a string, a negative, or a week is answering wrongly, and the
  // renderer must never be handed it.
  const junk = createPlanner({
    apiKey: "k",
    fetchImpl: answering([
      { type: "zoomPunch", punchAt: ["twelve", -4, 1e9, 30, null, 12], punchOn: "emphasis" },
    ]),
  });
  const cleaned = (await junk.plan("punch in", {})).operations.find((o) => o.type === "zoomPunch");
  check(
    "nonsense moments are dropped rather than passed on",
    JSON.stringify(cleaned?.at) === "[12,30]",
    JSON.stringify(cleaned),
  );

  const none = createPlanner({
    apiKey: "k",
    fetchImpl: answering([{ type: "zoomPunch", punchAt: null, punchOn: "emphasis" }]),
  });
  const chose = (await none.plan("punch in", {})).operations.find((o) => o.type === "zoomPunch");
  check(
    "naming none still means 'you choose', exactly as before",
    JSON.stringify(chose?.at) === "[]",
    JSON.stringify(chose),
  );
}

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
  check("the reply names the captions", /write what you say/.test(reply), reply);
  // "Reels", capitalised, because the reply spells a platform the way its own
  // logo spells it rather than echoing the lowercase key out of the plan.
  check("and the reframe", /\bReels\b/.test(reply), reply);
  check("and not as the lowercase key", !/\breels\b/.test(reply), reply);
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

  /*
    And the reason, which used to be thrown away.

    On 15 September every message in the product logged `planner returned 400`
    and nothing else, so every sentence was read by the keyword matcher instead
    of by a model and the line that said why was a sentence in the response
    body this code discarded. The provider had already written the answer down.
  */
  const refused = createPlanner({
    apiKey: "k",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({ error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model." } }),
        { status: 400 },
      ),
  });
  const refusedResult = await refused.plan("cut the silences", {});
  check(
    "a refusal carries the provider's own words",
    /max_tokens/.test(refusedResult.degraded ?? ""),
    refusedResult.degraded,
  );
  check(
    "and is cut short, because it goes in a log line",
    (refusedResult.degraded ?? "").length < 400,
    String((refusedResult.degraded ?? "").length),
  );

  /*
    The parameter that caused it. `max_tokens` is refused outright by the
    models this product asks for, and the fallback is silent by design — so
    nothing goes red, and every sentence is greped instead of read.
  */
  let sentBody = null;
  const watching = createPlanner({
    apiKey: "k",
    fetchImpl: async (_url, init) => {
      sentBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ operations: [] }) } }] }), { status: 200 });
    },
  });
  await watching.plan("cut the silences", {});
  check("the ceiling is sent under the name the models accept", typeof sentBody?.max_completion_tokens === "number", JSON.stringify(Object.keys(sentBody ?? {})));
  check("and not under the one they refuse", sentBody?.max_tokens === undefined, JSON.stringify(Object.keys(sentBody ?? {})));

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

/**
 * The prompt must not refuse what the product does.
 *
 * The instructions carried a sentence naming emojis, colour grading and
 * cutting in time with a beat as things "none of these operations do". All
 * three had been built, and the same prompt explained each of them a few
 * paragraphs earlier — so the model was handed a flat contradiction and
 * resolved it whichever way it liked. Nothing failed: some requests simply
 * came back refused, in a sentence that reads like a considered answer.
 *
 * This is the same rule the two-heads guard enforces on the matcher, pointed
 * at the prose: the model may not be told it cannot do a thing its own schema
 * offers it.
 */
console.log("\nThe prompt does not refuse what the product does");
{
  const calls = [];
  const spy = (url, init) => {
    calls.push([url, init]);
    return answering([])(url, init);
  };
  const planner = createPlanner({ apiKey: "k", fetchImpl: spy });
  await planner.plan("do something", { assets: LIBRARY });
  const instructions = sentBody(calls).messages[0].content;

  for (const [subject, probe] of [
    ["emojis", "emoji"],
    ["colour grading to a look we have", "colou?r grading"],
    ["cutting to the beat", "cutting in time with a beat|to the beat"],
  ]) {
    const refuses = new RegExp(
      `(?:${probe})[^.]{0,120}return no operations|return no operations[^.]{0,120}(?:${probe})`,
      "i",
    ).test(instructions);
    check(`the model is not told to refuse ${subject}`, !refuses, instructions.slice(-400));
  }

  // And the one thing it should still refuse is still refused, so the checks
  // above cannot be satisfied by deleting the sentence.
  check(
    "but a colour look nobody has named is still outside the product",
    /colour look nobody has named/i.test(instructions),
    instructions.slice(-400),
  );
}

/**
 * A punch on the beat needs a beat to be on.
 *
 * The instructions say the two go together; an instruction is not a guarantee.
 * A plan with `punchOn: beat` and no `addMusic` is one the renderer can only
 * answer with a note — no music, so no beat, so no punches — and the person
 * who asked for cuts on the beat gets a video with nothing done to it. The
 * keyword matcher has always laid the bed itself here, so this is the
 * two-heads rule as well: the cheap head must not produce an edit the paid one
 * cannot.
 */
console.log("\nA beat punch the model forgot to give a beat");
{
  const planner = createPlanner({
    apiKey: "k",
    fetchImpl: answering([{ type: "zoomPunch", punchOn: "beat", punchAmount: 0.15 }]),
  });
  const result = await planner.plan("cut it to the beat", { assets: LIBRARY });
  const punch = result.operations.find((o) => o.type === "zoomPunch");
  const music = result.operations.find((o) => o.type === "addMusic");
  check("the bed is laid for it", Boolean(music), JSON.stringify(result.operations));
  check(
    "using this project's own track",
    music?.assetId === LIBRARY.find((a) => a.kind === "audio")?.id,
    JSON.stringify(music),
  );
  check("and the punch stays on the beat", punch?.on === "beat", JSON.stringify(punch));
  check(
    "and the reply says the music is going under",
    result.willDo.map(inEnglish).some((w) => /music/i.test(w)),
    JSON.stringify(result.willDo),
  );

  /**
   * And the reply names the beat, which is the thing they asked for.
   *
   * The two-heads rule has a second edge nobody had checked: the matcher must
   * not be able to express an *edit* the model cannot — that is the guard at
   * the end of this file — but the model must also not describe an edit *worse*
   * than the matcher does. It did. `describeAll` returned one sentence for
   * `zoomPunch` regardless of `on`, so a beat-synced plan produced by the model
   * was reported as "I'll punch in where you lean on a word": the music
   * mentioned, the beat never. The matcher has said "on the beat of that track
   * rather than on your voice" since beat punches existed, so a deployment with
   * a key described the plan worse than one without — the rule pointing the
   * wrong way.
   *
   * It matters beyond wording: if no steady pulse turns up, the worker drops
   * the punches and says so in the render notes. Somebody who was never told
   * the beat was involved has no way to connect those two sentences.
   */
  check(
    "and the reply names the beat, not the voice",
    /beat/i.test(result.willDo.map(inEnglish).join(" ")) &&
      !/lean on a word/i.test(result.willDo.map(inEnglish).join(" ")),
    JSON.stringify(result.willDo.map(inEnglish)),
  );
  check(
    "in Arabic too, because the reply follows the request's language",
    result.willDo.some((phrase) => /ضربات/.test(phrase.ar ?? "")),
    JSON.stringify(result.willDo),
  );

  // With no track in the project there is no bed to lay, so the punch goes
  // back to the speaker's emphasis — an edit that works on any footage, and
  // the one they would have got had they never mentioned the music.
  const bare = createPlanner({
    apiKey: "k",
    fetchImpl: answering([{ type: "zoomPunch", punchOn: "beat", punchAmount: 0.15 }]),
  });
  const nothing = await bare.plan("cut it to the beat", { assets: [] });
  const barePunch = nothing.operations.find((o) => o.type === "zoomPunch");
  check("with no track at all, the punch goes back on the voice", barePunch?.on === "emphasis", JSON.stringify(nothing.operations));
  check("and no music is invented for it", !nothing.operations.some((o) => o.type === "addMusic"), JSON.stringify(nothing.operations));
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
  check("so nothing in the reply promises the cutaway", !/cut away/i.test(result.willDo.map(inEnglish).join(" ")));
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
    result.willDo.length === 3 && /half the price/i.test(result.willDo.map(inEnglish).join(" ")),
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
    /street at night/.test(result.willDo.map(inEnglish).join(" ")) && /5s/.test(result.willDo.map(inEnglish).join(" ")),
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
    /strongest 45 seconds/.test(asked.willDo.map(inEnglish).join(" ")),
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

  /*
    Five minutes is not an absurd length, and this check used to say it was.

    It asserted a clamp at 120 seconds, under the heading "an absurd length is
    clamped, not refused". The clamp was real and the word was the bug: nothing
    in `highlight.ts` has a ceiling — `chooseHighlight` slides a window of
    whatever length it is given and returns the whole recording when the window
    is longer than it — so the only thing 120 ever did was turn "the best ten
    minutes of my talk" into two and then say so, in a sentence the person had
    to argue with.

    That is the same assumption the rest of this product makes in its framing:
    that the answer to a long video is a short one. A ceiling on the output
    belongs where the other ceilings are, in `duration.ts`, which measures the
    real file and refuses with numbers.
  */
  const long = await planner.plan("keep only the best 300 seconds", {});
  const kept = long.operations.find((o) => o.type === "extractHighlight");
  check("five minutes is five minutes", kept?.targetSeconds === 300, String(kept?.targetSeconds));

  const tenMinutes = await planner.plan("give me the best 600 seconds of this talk", {});
  const long10 = tenMinutes.operations.find((o) => o.type === "extractHighlight");
  check("and ten minutes is ten minutes", long10?.targetSeconds === 600, String(long10?.targetSeconds));

  // The floor stays, because a two-second highlight is not a thing anybody
  // wants and the renderer has to have something to slide.
  const tiny = await planner.plan("just the best 2 seconds", {});
  const floored = tiny.operations.find((o) => o.type === "extractHighlight");
  check("while the floor is still a floor", floored?.targetSeconds === 5, String(floored?.targetSeconds));
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
    /1:20/.test(mmss.willDo.map(inEnglish).join(" ")) && /2:10/.test(mmss.willDo.map(inEnglish).join(" ")),
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
    /3 separate clips/.test(counted.willDo.map(inEnglish).join(" ")),
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
    /black screen/.test(asked.willDo.map(inEnglish).join(" ")),
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
  /*
    The sentence says "wide"; the ratio is still 16:9 everywhere it matters.
    `shapeInWords` is why: a ratio is a thing you learn from editing software,
    and this sentence is the one a person reads to check they were understood.
  */
  check(
    "and the reply says wide, not vertical",
    /\bwide\b/.test(yt.willDo.map(inEnglish).join(" ")) && !/vertical/.test(yt.willDo.map(inEnglish).join(" ")),
    JSON.stringify(yt.willDo),
  );

  const shorts = await planner.plan("cut this up for youtube shorts", {});
  const shortsOp = shorts.operations.find((o) => o.type === "formatForPlatform");
  check("'youtube shorts' is still vertical", shortsOp?.platform === "shorts", JSON.stringify(shortsOp));

  const square = await planner.plan("make it square for the feed", {});
  const squareOp = square.operations.find((o) => o.type === "formatForPlatform");
  check("'square' is its own shape", squareOp?.platform === "square", JSON.stringify(squareOp));
  check("and the reply says square", /\bsquare\b/.test(square.willDo.map(inEnglish).join(" ")), JSON.stringify(square.willDo));

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
    /fade only where the recording jumps/.test(asked.willDo.map(inEnglish).join(" ")),
    JSON.stringify(asked.willDo),
  );
  /*
    Where, and the default is the judgement rather than the filter.

    "Crossfade between the cuts" is the sentence somebody types when they mean
    "make this look edited", and the renderer answers it by dissolving where the
    recording jumps and leaving every removed breath as a hard cut. A person who
    actually wants one on all of them has to say so, and a montage or a
    slideshow is a real reason to.
  */
  check("and they are put where the edit moves, not on every cut", dissolve?.where === "scenes", String(dissolve?.where));

  for (const sentence of [
    "cut the silences and put a transition between every cut",
    "cut the silences and dissolve on each cut",
    "اقصّ الصمت وحط انتقال بين كل قصّة",
    "اقصّ الصمت وحط انتقال بين كل مقطع",
  ]) {
    const insisted = await planner.plan(sentence, {});
    const join = insisted.operations.find((o) => o.type === "transition");
    check(
      `"${sentence}" asks for one on every cut and gets it`,
      join?.where === "everyCut",
      JSON.stringify(join),
    );
  }
  /*
    And the near-miss stays a judgement. "All of it" is an emphasis on the
    sentence, not an instruction about the seams, and a rule that read "all" on
    its own would turn the most ordinary phrasing there is into the filter.
  */
  /*
    And the Arabic for it works at all, which it did not.

    `\bانتقال` can never match: a boundary sits between a word character and a
    non-word one, and every Arabic letter is a non-word character to a
    JavaScript regular expression. So the singular Arabic word for a transition
    produced nothing, on the one feature whose name it is. The plural happened
    to work, because the alternative beside it carried no `\b` — which is how a
    dead branch survives, by sitting next to a live one.
  */
  for (const sentence of ["اقصّ الصمت وحط انتقال", "اقصّ الصمت وحط انتقالات", "اشتغل على الترانزشنز"]) {
    const arabic = await planner.plan(sentence, {});
    check(
      `"${sentence}" is heard`,
      arabic.operations.some((o) => o.type === "transition"),
      JSON.stringify(arabic.operations.map((o) => o.type)),
    );
  }

  /*
    The other two colours of the flash, and the bare word staying white.

    "Flash to black" and "flash" are the same word with opposite meanings: one
    is the full stop between two sections, the other is energy inside one. The
    colour is checked before the bare word for the same reason "wipe left" is
    checked before "wipe", and the bare word keeps meaning white, which is what
    it means when nobody says otherwise.
  */
  for (const [sentence, style] of [
    ["cut the silences and flash to black between the cuts", "flashBlack"],
    ["cut the silences and put a black flash between the shots", "flashBlack"],
    ["cut the silences and flash through grey between the cuts", "flashGrey"],
    ["cut the silences and flash between the cuts", "flash"],
  ]) {
    const asked = await planner.plan(sentence, {});
    check(
      `"${sentence}" is a ${style}`,
      asked.operations.find((o) => o.type === "transition")?.style === style,
      JSON.stringify(asked.operations.find((o) => o.type === "transition")),
    );
  }

  /*
    And the model is told the rule the director obeys.

    Read out of the instructions rather than exercised, because exercising it
    would mean asking a model to not do something, which passes by luck. What
    can be checked is that the sentence is in front of it at all: a model free
    to put a wipe on somebody's podcast because nobody mentioned it is the same
    hole as a schema with no property for the style, and that one shipped for
    months.
  */
  const told = readFileSync(
    path.join(repoRoot, "artifacts/api-server/src/lib/planner.ts"),
    "utf8",
  );
  check(
    "the model is told not to reach for a decorative join on its own",
    /Never choose a wipe, a slide, zoomBlur or glitch unless they ask/.test(told),
    "the sentence is not in the instructions",
  );
  check(
    "and is told which three it may choose",
    /three you may choose on your own are dissolve, whipPan/.test(told),
    "the three are not named",
  );

  const emphatic = await planner.plan("cut the silences and add transitions to all of it", {});
  check(
    "but an emphasis on the whole video is not an instruction about the seams",
    emphatic.operations.find((o) => o.type === "transition")?.where === "scenes",
    JSON.stringify(emphatic.operations.find((o) => o.type === "transition")),
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

  /*
    A wipe asked for by the bare word is the soft-edged one.

    The edge is the whole of how a wipe reads, and ffmpeg's hard one is a line
    crossing the frame with nothing either side of it — the slideshow look, and
    the one shape in the vocabulary that dates the video it is in. Somebody who
    writes "wipe" has not asked for that; they have not said anything about the
    edge at all, and this is the answer that is right when they have not.

    A stored plan is untouched by this. `wipeLeft` still renders the hard wipe,
    and a job row replayed produces the video it was paid for; what changed is
    which style a *sentence* turns into.
  */
  check("'wipe' alone is the soft-edged one", (await styleOf("cut the silences and wipe between the shots")) === "softWipeLeft");
  check("'wipe right' is the other way", (await styleOf("wipe right between the shots")) === "softWipeRight");
  check("'wipe up' too", (await styleOf("wipe up between the cuts")) === "softWipeUp");
  // And the hard edge is one word away, in both languages.
  check("a hard edge asked for by name is the hard one", (await styleOf("hard wipe between the shots")) === "wipeLeft");
  check("and to the right as well", (await styleOf("a sharp wipe to the right between the cuts")) === "wipeRight");
  check("and in Arabic", (await styleOf("مسحة حادة بين القصات")) === "wipeLeft");
  check("while the plain Arabic word stays soft", (await styleOf("مسحة بين القصات")) === "softWipeLeft");
  check("'slide' alone is a left slide", (await styleOf("slide between the shots")) === "slideLeft");
  check("'push right' is a slide, because that is what people call it", (await styleOf("push right between the shots")) === "slideRight");
  check("'flash' is the white one", (await styleOf("put a white flash between the cuts")) === "flash");
  check("and the Arabic is heard", (await styleOf("خلي ومضة بين القصات")) === "flash");

  // A named shape beats the general word. Somebody who said "wipe" asked for a
  // wipe; answering the vaguer half of their sentence is answering somebody
  // else's question.
  check(
    "a named shape wins over a bare 'transitions'",
    (await styleOf("add transitions, wipe between the cuts")) === "softWipeLeft",
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
    !asked.cannotYet.map(inEnglish).some((c) => /transition/i.test(c)),
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
    !between.cannotYet.map(inEnglish).some((c) => /between the cuts|crossfade|dissolve/i.test(c)),
    JSON.stringify(between.cannotYet),
  );

  /*
    Asking for it to be posted.

    The scheduling is built and no platform has approved this app to post on
    anybody's behalf, so the honest answer is a refusal that says which half is
    ready. What it must never be is silence — a sentence that asks for
    something and gets no operation and no mention reads as having worked.

    The narrowness is the interesting half. "post" lives inside
    "post-production" and "share" lives inside half of everything, so a
    platform has to be named beside a posting verb, or the sentence has to say
    "schedule" outright.
  */
  {
    const said = async (sentence) => (await planner.plan(sentence, {})).cannotYet.map(inEnglish);
    const mentionsPosting = (list) => list.some((c) => /post it to your accounts/i.test(c));

    for (const sentence of [
      "cut the silence and post it to Instagram",
      "make it vertical then upload to tiktok",
      "schedule it for tomorrow morning",
      "قص الصمت وانشرها على انستغرام",
    ]) {
      check(
        `heard: "${sentence}"`,
        mentionsPosting(await said(sentence)),
        JSON.stringify(await said(sentence)),
      );
    }

    for (const sentence of [
      "give it a post-production look",
      "share the screen recording I uploaded",
      "cut the silence and caption it",
    ]) {
      check(
        `not heard as posting: "${sentence}"`,
        !mentionsPosting(await said(sentence)),
        // A refusal on a sentence that never asked is worse than a missing
        // one: it tells somebody the product misunderstood them.
        JSON.stringify(await said(sentence)),
      );
    }

    check(
      "and the rest of the sentence is still planned",
      (await planner.plan("cut the silence and post it to Instagram", {})).operations.some(
        (o) => o.type === "removeSilence",
      ),
      "a refusal about one half must not swallow the other",
    );
  }

  const shaped = await planner.plan("wipe from one shot to the next", {});
  check(
    "a shaped transition is built now, not admitted as missing",
    shaped.operations.some((o) => o.type === "transition"),
    JSON.stringify(shaped.operations.map((o) => o.type)),
  );
  check(
    "and nothing about transitions is left on the cannot-do list",
    !shaped.cannotYet.map(inEnglish).some((c) => /wipe|slide|transition/i.test(c)),
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
    !hook.cannotYet.map(inEnglish).some((c) => /hook/i.test(c)),
    JSON.stringify(hook.cannotYet),
  );
  const arabicHook = await planner.plan("ابدأ بالأقوى", {});
  check(
    "and the Arabic ask is heard too",
    arabicHook.operations.some((o) => o.type === "coldOpen"),
    JSON.stringify(arabicHook.operations.map((o) => o.type)),
  );

  // This used to assert that a colour ask was *refused* with a pointer at
  // reference matching, which was the honest answer while a look could only
  // come from a clip the person supplied. Named looks made it a real answer,
  // so the check moves with it rather than being deleted: the property worth
  // keeping is that a colour ask is answered at all.
  const colour = await planner.plan("make the colour more cinematic", {});
  check(
    "a colour ask is answered rather than refused",
    colour.operations.some((o) => o.type === "grade" && o.look === "cinematic") && colour.cannotYet.length === 0,
    JSON.stringify([colour.operations, colour.cannotYet]),
  );

  /*
    Music stopped being on the "cannot yet" list.

    It was there for as long as the only possible bed was a recording somebody
    else owned. A bed generated to our own account is ours to hand on, so a
    project with no audio file gets one instead of an apology. What is checked
    here now is that the *bed still happens* without a library, which is the
    thing that changed and the thing that could regress.
  */
  const music = await planner.plan("add music to it", {});
  check(
    "and a project with no library still gets a bed, from a mood",
    music.operations.some((o) => o.type === "addMusic" && typeof o.mood === "string" && !o.assetId),
    JSON.stringify([music.operations, music.cannotYet]),
  );
}

console.log("\nAsking for what the project does not have");
{
  const planner = createPlanner({ apiKey: "" });
  const result = await planner.plan("cut in some b-roll", { assets: [] });
  check("no operation is invented", result.operations.length === 0);
  check(
    "and the reason is the missing file, not a missing feature",
    /no clips to show/.test(result.cannotYet.map(inEnglish).join(" ")),
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

  check("held as a card unless they asked for something else", title?.style === "card", JSON.stringify(title));

  /**
   * And kinetic when that is what was asked for.
   *
   * The style exists and the model can choose it. This is the matcher learning
   * the same word — the direction the two-heads rule allows, since the cheap
   * head may know less than the paid one and never more. It matters because the
   * matcher is what answers when the model times out, and "the words came in as
   * a slab today" is not a difference anybody reports as a bug.
   */
  for (const [ask, note] of [
    ['add a kinetic title saying "Half the price"', "kinetic"],
    ['title "Half the price" word by word', "word by word"],
    ['put "Half the price" on it, one word at a time', "one at a time"],
  ]) {
    const kinetic = await planner.plan(ask, { assets: LIBRARY });
    const op = kinetic.operations.find((o) => o.type === "motionTitle");
    check(`"${note}" lands the words one at a time`, op?.style === "word", JSON.stringify(op));
    check(
      "and the reply says so, because the two look nothing alike on the frame",
      kinetic.willDo.map(inEnglish).some((w) => /one at a time/.test(w)),
      JSON.stringify(kinetic.willDo),
    );
  }

  // Arabic, and with no word boundary in front of it — `\b` before an Arabic
  // letter never matches, which is the trap this file has fallen into three
  // times now.
  const arabic = await planner.plan('اكتب "نصف السعر" كلمة كلمة', { assets: LIBRARY });
  const arabicTitle = arabic.operations.find((o) => o.type === "motionTitle");
  check("«كلمة كلمة» asks for the same thing", arabicTitle?.style === "word", JSON.stringify(arabicTitle));
  check(
    "and is answered in Arabic",
    arabic.willDo.some((w) => /واحدةً واحدة/.test(w.ar ?? "")),
    JSON.stringify(arabic.willDo),
  );

  const unquoted = await planner.plan("put a title on it", { assets: LIBRARY });
  check(
    "and without quotes nothing is written for them",
    !unquoted.operations.some((o) => o.type === "motionTitle"),
    JSON.stringify(unquoted.operations),
  );
  check(
    "but they are told how to get one",
    /put them in quotes/i.test(unquoted.cannotYet.map(inEnglish).join(" ")),
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
    withTrack.willDo.map(inEnglish).some((w) => /a voice note/.test(w) && /under the whole edit/.test(w)),
    JSON.stringify(withTrack.willDo),
  );

  /*
    No library, and a bed anyway — made rather than borrowed.

    This pair used to assert the refusal, and the refusal was right while the
    only source was somebody else's catalogue. Generated audio is ours, so the
    person who owns no music is no longer sent away to find some. Their own
    upload still wins where it exists: the check above proves that, and it is
    the one that must never flip.
  */
  const without = await planner.plan("can you put background music on this", { assets: [] });
  const made = without.operations.find((o) => o.type === "addMusic");
  check("with nothing to play, a bed is made rather than refused", !!made, JSON.stringify(without.operations));
  check(
    "and it names a mood rather than an id it could not have",
    typeof made?.mood === "string" && !made?.assetId,
    JSON.stringify(made),
  );

  // Cutting to the beat, which stopped being on the "cannot yet" list this
  // round. It needs a bed to land on, and asking for it is also asking for the
  // bed — making somebody say both would be the product being pedantic about
  // its own internal shape.
  const beat = await planner.plan("cut it to the beat", { assets: LIBRARY });
  const beatPunch = beat.operations.find((o) => o.type === "zoomPunch");
  check(
    "cutting to the beat lays the bed as well, because it cannot happen without one",
    beat.operations.some((o) => o.type === "addMusic"),
    JSON.stringify(beat.operations),
  );
  check(
    "and the punches are told to follow the music, not the voice",
    beatPunch?.on === "beat" && beatPunch?.at.length === 0,
    JSON.stringify(beatPunch),
  );
  check(
    "and the reply says which of the two it is",
    beat.willDo.map(inEnglish).some((w) => /on the beat of that track instead of on your voice/.test(w)),
    JSON.stringify(beat.willDo),
  );

  // The refusal did not disappear, it moved: with nothing to cut against there
  // is still no beat, and the reply names the fix rather than the limitation.
  const noTrack = await planner.plan("cut it to the beat", { assets: [] });
  check(
    "with no music in the project the answer is still no",
    noTrack.cannotYet.map(inEnglish).some((c) => /no music to follow/.test(c)),
    JSON.stringify(noTrack.cannotYet),
  );
  check(
    "and no punch operation is emitted that could never land anywhere",
    !noTrack.operations.some((o) => o.type === "zoomPunch"),
    JSON.stringify(noTrack.operations),
  );

  // Asking for punches *and* for the beat is one ask, not two. The more
  // specific answer wins — the same rule "slow zoom" taught this file.
  const bothAsks = await planner.plan("punch in on the words and cut to the beat", { assets: LIBRARY });
  const punches = bothAsks.operations.filter((o) => o.type === "zoomPunch");
  check(
    "a sentence asking for punches and for the beat gets one punch operation, on the beat",
    punches.length === 1 && punches[0]?.on === "beat",
    JSON.stringify(punches),
  );

  // And the bed is laid once, however many ways the sentence asks for it.
  const musicTwice = await planner.plan("add music and cut to the beat", { assets: LIBRARY });
  check(
    "and the bed is laid once, not twice",
    musicTwice.operations.filter((o) => o.type === "addMusic").length === 1,
    JSON.stringify(musicTwice.operations),
  );

  const arabic = await planner.plan("ضيف موسيقى خلفية", { assets: LIBRARY });
  check("the Arabic ask is heard too", arabic.operations.some((o) => o.type === "addMusic"), JSON.stringify(arabic.operations));
}

/**
 * Emojis: theirs, or none.
 *
 * This was the oldest item on the "cannot yet" list, and the reason it stayed
 * there is not that stickers are hard. It is that choosing somebody's emojis
 * for them is writing copy nobody asked for, which is the one thing the
 * animated title already refuses to do. So the ask alone gets a refusal that
 * names the fix, and the emojis they typed get placed.
 *
 * And the third case is the one worth the section: typing an emoji is not an
 * ask. "cut the silence 🙏" is a person being polite, and burning their
 * politeness into the video would be the product reading punctuation as an
 * instruction.
 */
/**
 * The two heads have to be able to say the same things.
 *
 * This product plans a sentence twice over: a keyword matcher that runs
 * everywhere, and a model that runs where there is a key. They are not meant to
 * be identical — the model reads sentences the matcher cannot — but the matcher
 * must never be able to express an *edit* the model cannot, because that means
 * paying for a key makes the product worse and nothing anywhere says so.
 *
 * It happened the round beat sync was built: the matcher could say "put the
 * punches on the beat" and the model's vocabulary had no word for it, so a
 * deployment with a key would have quietly gone back to punching the voice. The
 * check below is what would have caught it, and it works the only way this kind
 * of check can: it reads the *matcher's source* for the literal values it
 * assigns to operation fields, and asks whether each one appears anywhere in
 * the schema the model is handed.
 */
console.log("\nThe matcher cannot say anything the model has no word for");
{
  const calls = [];
  const spy = (url, init) => {
    calls.push([url, init]);
    return answering([])(url, init);
  };
  const planner = createPlanner({ apiKey: "k", fetchImpl: spy });
  await planner.plan("do everything", { assets: LIBRARY });
  const schema = JSON.stringify(sentBody(calls).response_format.json_schema.schema);

  const matcher = readFileSync(path.join(repoRoot, "artifacts/api-server/src/lib/plan-from-text.ts"), "utf8");

  /**
   * Values the matcher writes into an operation, taken from the source rather
   * than from a list somebody maintains — a list is the thing that goes stale
   * the week this matters.
   */
  const chosen = new Set();
  // Every place the matcher names one of these fields, and whatever it assigns
  // on the rest of that line — which covers the ternary chains, the multi-line
  // object literals and the one-line pushes alike. The first version of this
  // only read lines that *began* with a field name, and the one value the
  // section was written to catch is written mid-line: it passed while reading
  // nothing, which is the failure a guard is most likely to have.
  const ASSIGNMENT = /\b(?:type|style|animation|platform|look|position|on)\s*:\s*([^,}\n]*)/g;
  for (const [, assigned] of matcher.matchAll(ASSIGNMENT)) {
    /*
      A value that opens a bilingual pair is prose, not vocabulary.

      `platform: { en: "reframing", ar: "إعادة تأطير" }` is a row in a table of
      words for the *customer*, and the field it sits under happens to be named
      after the subject it describes. Read as an operation value it is a word
      the model has never heard of, which is exactly what this section reports
      -- and it would be reporting a sentence.
    */
    if (/^\s*\{\s*en\s*:/.test(assigned)) continue;
    for (const [, value] of assigned.matchAll(/"([a-z][a-zA-Z-]*)"/g)) chosen.add(value);
  }

  /**
   * What the model legitimately cannot choose, each with the reason. Anything
   * not on this list and not in the schema is the drift this section exists to
   * catch — so adding to it should feel like a decision, not a fix.
   */
  const NOT_THE_MODEL_S_TO_CHOOSE = new Map([
    // Chosen by the renderer from what it hears, never by a planner.
    ["burnCaptions", "the worker turns autoCaptions into this once it has words"],
    ["watermark", "forced by the server on free plans, never asked for"],
    // Read off the person's own sentence, not selected from a vocabulary.
    ["and", "a word in a joined list, not a value"],
  ]);

  const missing = [...chosen].filter(
    (value) => !schema.includes(`"${value}"`) && !NOT_THE_MODEL_S_TO_CHOOSE.has(value),
  );
  check(
    "every value the matcher can choose is a value the model can choose",
    missing.length === 0,
    `the model has no word for: ${missing.join(", ")} — a key would make the product worse at these`,
  );

  // The model can now actually choose the transition it was told to choose.
  {
    const chosenStyle = [];
    const styled = createPlanner({
      apiKey: "k",
      fetchImpl: answering([{ type: "transition", transitionStyle: "wipeLeft", durationSeconds: 0.3 }]),
    });
    const out = await styled.plan("wipe between the cuts", { assets: [] });
    const op = out.operations.find((o) => o.type === "transition");
    chosenStyle.push(op?.style);
    check(
      "a transition style the model names is the style it gets",
      op?.style === "wipeLeft",
      JSON.stringify(op),
    );
  }
  // And an invented one still becomes the dissolve, which is what the comment
  // in the transformer has always claimed and was never once exercised.
  {
    const invented = createPlanner({
      apiKey: "k",
      fetchImpl: answering([{ type: "transition", transitionStyle: "swirl", durationSeconds: 0.3 }]),
    });
    const out = await invented.plan("swirl between the cuts", { assets: [] });
    check(
      "and a style it invented becomes the dissolve rather than a failure",
      out.operations.find((o) => o.type === "transition")?.style === "dissolve",
      JSON.stringify(out.operations),
    );
  }

  /**
   * And the other half of the same question: a knob the transformer reads that
   * the schema cannot carry is always undefined.
   *
   * This is where the transition style hid, and where four more were hiding
   * behind it: gainDb, duck, fadeSeconds, fromSeconds and loop were all read
   * off a model answer that could never contain them, because strict mode plus
   * additionalProperties:false means the only fields that exist are the ones
   * listed. Every bed came out at -18 dB, ducking, whatever anybody asked for —
   * and the code read as though the model had chosen that.
   *
   * Reading the source is the only way to see it: at run time the value is
   * `undefined` and the default is taken, which is exactly what a *legitimately
   * absent* field looks like.
   */
  {
    const source = readFileSync(path.join(repoRoot, "artifacts/api-server/src/lib/planner.ts"), "utf8");
    // Comments describe this bug at length; scanning them would find the words
    // rather than the code.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const readFields = new Set([...code.matchAll(/raw\["([a-zA-Z]+)"\]/g)].map((m) => m[1]));
    const offered = new Set(
      Object.keys(sentBody(calls).response_format.json_schema.schema.properties.operations.items.properties),
    );
    const unreachable = [...readFields].filter((f) => !offered.has(f));
    check(
      "every field the transformer reads is a field the model can send",
      unreachable.length === 0,
      `read but never present: ${unreachable.join(", ")} — always undefined, always the default`,
    );
  }

  // The two knobs the instructions promise, now actually turnable.
  {
    const loud = createPlanner({
      apiKey: "k",
      fetchImpl: answering([{ type: "addMusic", assetId: "a3", gainDb: -6, duck: false }]),
    });
    const out = await loud.plan("music, loud, and do not duck it", { assets: LIBRARY });
    const bed = out.operations.find((o) => o.type === "addMusic");
    check("a bed level the model names is the level it gets", bed?.gainDb === -6, JSON.stringify(bed));
    check("and ducking it turned off stays off", bed?.duck === false, JSON.stringify(bed));
  }
  {
    // Clamped, not refused — the same rule as every other numeric here.
    const shouting = createPlanner({
      apiKey: "k",
      fetchImpl: answering([{ type: "addMusic", assetId: "a3", gainDb: 12, duck: null }]),
    });
    const out = await shouting.plan("music way louder", { assets: LIBRARY });
    const bed = out.operations.find((o) => o.type === "addMusic");
    check("a level above the ceiling is clamped rather than refused", bed?.gainDb === 0, JSON.stringify(bed));
    check("and an unanswered duck stays on, which is what a bed is for", bed?.duck === true, JSON.stringify(bed));
  }

  // And the guard is reading something: a value nobody has is reported.
  check(
    "and a value neither of them has would be caught",
    !schema.includes('"wesAnderson"'),
    "the schema contains a look that does not exist, so this check reads nothing",
  );
}

console.log("\nEmojis are theirs or they do not happen");
{
  const planner = createPlanner({ apiKey: "" });

  const typed = await planner.plan("add the emoji 🔥 at the start", { assets: [] });
  const sticker = typed.operations.find((o) => o.type === "motionTitle");
  check("an emoji they typed is placed", sticker?.text === "🔥", JSON.stringify(typed.operations));
  check("and the reply says which one", typed.willDo.map(inEnglish).some((w) => /🔥/.test(w)), JSON.stringify(typed.willDo));

  const asked = await planner.plan("can you add some emojis", { assets: [] });
  check(
    "asking for emojis without typing any is refused",
    !asked.operations.some((o) => o.type === "motionTitle"),
    JSON.stringify(asked.operations),
  );
  check(
    "and the refusal names the fix rather than the limitation",
    asked.cannotYet.map(inEnglish).some((c) => /type the ones you want/i.test(c)),
    JSON.stringify(asked.cannotYet),
  );

  // The case that matters most, because it is the one that would embarrass
  // somebody: an emoji in a sentence is not a request for a sticker.
  const polite = await planner.plan("cut the silence please 🙏", { assets: [] });
  check(
    "an emoji used as punctuation is left alone",
    !polite.operations.some((o) => o.type === "motionTitle"),
    JSON.stringify(polite.operations),
  );
  check(
    "and the rest of that sentence still happens",
    polite.operations.some((o) => o.type === "removeSilence"),
    JSON.stringify(polite.operations),
  );

  // Three is enough. A wall of them is not a sticker, it is noise, and the cap
  // is the difference between placing what they meant and pasting what they
  // typed.
  const many = await planner.plan("emojis: 🔥😂🎉🚀💯", { assets: [] });
  const wall = many.operations.find((o) => o.type === "motionTitle");
  // Spaced, not run together: the kinetic style animates whitespace-separated
  // pieces, so this is the difference between three stickers popping on one
  // after another and one lump of three arriving at once.
  check("at most three emojis are placed, in the order typed", wall?.text === "🔥 😂 🎉", JSON.stringify(wall));
  check("and spaced, so they land one at a time", wall?.style === "word", JSON.stringify(wall));

  const arabic = await planner.plan("ضيف إيموجي 🎉", { assets: [] });
  check(
    "the Arabic ask is heard, with their emoji",
    arabic.operations.some((o) => o.type === "motionTitle" && o.text === "🎉"),
    JSON.stringify(arabic.operations),
  );
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
  check("and the reply promises both", /start with the strongest moment/.test(reply) && /fade only where the recording jumps/.test(reply), reply);

  const faded = await planner.plan("give it a hook and fade it in and out", {});
  check(
    "a fade still composes with a hook",
    faded.operations.some((o) => o.type === "coldOpen") && faded.operations.some((o) => o.type === "fade"),
    JSON.stringify(faded.operations.map((o) => o.type)),
  );
}

console.log("\nA look can be named, because most people have no reference to hand us");
{
  const planner = createPlanner({ apiKey: "" });

  // Matching a reference came first and is still the better answer: it is
  // measured against footage the person chose. But "make it cinematic" from
  // somebody with no reference used to get a flat refusal, which is a real ask
  // answered with a shrug.
  const named = {
    "make it cinematic": "cinematic",
    "make it black and white": "mono",
    "can you make it warmer": "warm",
    "cooler, more blue": "cool",
    "make it pop": "punch",
    "\u062e\u0644\u064a\u0647\u0627 \u0623\u0628\u064a\u0636 \u0648\u0623\u0633\u0648\u062f": "mono",
  };
  for (const [text, look] of Object.entries(named)) {
    const r = await planner.plan(text, {});
    const grade = r.operations.find((o) => o.type === "grade");
    check(`"${text}" is heard as ${look}`, grade?.look === look, JSON.stringify(grade));
  }

  // The specific beats the general: somebody who writes both means the half
  // that is unambiguous.
  const mixed = await planner.plan("cinematic black and white", {});
  check(
    "and a sentence naming two takes the one that is not a mood",
    mixed.operations.find((o) => o.type === "grade")?.look === "mono",
    JSON.stringify(mixed.operations),
  );

  // The refusal that survives: a look we do not have and no reference either.
  const unknown = await planner.plan("grade it like Wes Anderson", {});
  check(
    "a look we do not have is still refused",
    !unknown.operations.some((o) => o.type === "grade"),
    JSON.stringify(unknown.operations),
  );
  check(
    "and the refusal names the looks we do have, rather than just saying no",
    unknown.cannotYet.map(inEnglish).some((c) => /warm, cool, cinematic, black and white or punchy/.test(c)),
    JSON.stringify(unknown.cannotYet),
  );

  // The looks must not fire on sentences that merely contain the words in
  // another sense. "Cut the cold open" is not a request for a cool grade.
  for (const text of ["cut the silences", "open on the strongest moment", "add captions"]) {
    const r = await planner.plan(text, {});
    check(`"${text}" does not grade anything`, !r.operations.some((o) => o.type === "grade"), JSON.stringify(r.operations.map((o) => o.type)));
  }

  const reply = replyFor(await planner.plan("make it black and white", {}), { hasVideo: true });
  check("and the reply says it in words a person uses", /black and white/.test(reply), reply);
}

console.log("\nThe two most basic asks, in the other language");
{
  const planner = createPlanner({ apiKey: "" });

  // Everything else in the matcher reads Arabic — the highlight, the hook, the
  // transitions, the looks, the music. Cutting silence and going vertical, the
  // two most-asked-for edits in the product, did not: this sentence produced
  // *no operations at all*, so the reply fell through to "I'm not sure what to
  // change from that". Found by rendering sentences a person would type.
  const arabic = await planner.plan("اقصّ الصمت وخليها عمودية للتيك توك", {});
  const types = arabic.operations.map((o) => o.type);
  check("the Arabic for cutting silence is heard", types.includes("removeSilence"), JSON.stringify(types));
  check("and the Arabic for vertical reframes it", types.includes("formatForPlatform"), JSON.stringify(types));
  check(
    "to the platform it names, not a default",
    arabic.operations.find((o) => o.type === "formatForPlatform")?.platform === "tiktok",
    JSON.stringify(arabic.operations),
  );

  // The phrase this product's own reply uses. "I'll level the audio to what
  // these platforms expect" was a sentence we wrote and could not hear: only
  // "audio level" matched, which is the same two words in the order nobody
  // says them in.
  const levelled = await planner.plan("cut the silences and level the audio", {});
  check(
    "and the words our own reply uses are words we can hear",
    levelled.operations.some((o) => o.type === "normalizeLoudness"),
    JSON.stringify(levelled.operations.map((o) => o.type)),
  );
  const reply = replyFor(levelled, { hasVideo: true });
  check("so the promise it makes is one it planned", /even out the sound/.test(reply), reply);

  // The guard on the other side: "level" is a common word and must not fire on
  // its own.
  const notLevel = await planner.plan("cut it down to the next level of tight", {});
  check(
    "while 'level' on its own does not level anything",
    !notLevel.operations.some((o) => o.type === "normalizeLoudness"),
    JSON.stringify(notLevel.operations.map((o) => o.type)),
  );
}

console.log("\n\"no music\" is a refusal, not a request for music");
{
  const track = [{ id: "t1", kind: "audio", label: "song.mp3" }];
  const hasMusic = (asked) => planFromText(asked, { assets: track }).operations.some((o) => o.type === "addMusic");
  const offersMusic = (asked) => {
    const intent = planFromText(asked, { assets: track });
    return [...(intent.willDo ?? []), ...(intent.cannotYet ?? [])].some((p) => /music|موسيق/i.test(p.en ?? p.ar ?? JSON.stringify(p)));
  };

  // The request still works.
  check("'add music' still lays a bed", hasMusic("add some music") === true);
  check("'حط موسيقى' still lays a bed", hasMusic("حط موسيقى تحت الفيديو") === true);

  // The refusals no longer do — in either language, however phrased.
  for (const asked of ["no music", "remove the music", "without music", "don't add music", "take out the music"]) {
    check(`'${asked}' lays no bed`, hasMusic(asked) === false, asked);
  }
  for (const asked of ["بدون موسيقى", "لا تحط موسيقى", "شيل الموسيقى", "بلا موسيقى", "من غير موسيقى"]) {
    check(`'${asked}' lays no bed`, hasMusic(asked) === false, asked);
  }

  // And a project with no track does not offer music to someone who declined it.
  const noTrack = (asked) => {
    const intent = planFromText(asked, { assets: [] });
    // The words the sentence uses now. "bed" was one of them until the
    // confirmation stopped speaking in trade terms: a bed is a thing you know
    // from a mixing desk, and the sentence says "music under the video".
    return [...(intent.willDo ?? []), ...(intent.cannotYet ?? [])].some((p) =>
      /add music|أضيف موسيق|music under|موسيقى .* تحت/i.test(JSON.stringify(p)),
    );
  };
  check("a refusal with no track offers nothing", noTrack("no music") === false);
  // And a request with no track is answered with a bed, in words, rather than
  // with the upload instruction it used to get.
  check("but an actual request with no track is still answered", noTrack("add music") === true);
  void offersMusic;
}

console.log("\nA verb that was read and an object that was acted on are the same bug twice");
{
  /*
    Two inversions, found by reading what the product actually answers rather
    than by any suite. Both had the same shape: the object of the sentence was
    matched and the verb was not, so the plan did the opposite of the ask and
    the reply announced it as done.

    "Cut the first ten seconds" kept exactly the ten seconds the person had
    asked to lose. A talk came back ten seconds long, rendered, charged for.

    "The music is too loud" laid a second bed under the first. That is worse
    than not helping: it is the answer they were complaining about, doubled.

    Third of its kind here, after the captions one. The rule the three of them
    share is worth saying plainly -- a pattern that finds a noun has not read a
    sentence -- and that is why these sit together.
  */
  const opsFor = (asked) => planFromText(asked, { assets: [] }).operations;
  const rangeIn = (asked) => opsFor(asked).find((o) => o.type === "extractRange");
  const TO_THE_END = 86400;

  // Keeping a stretch, which is the reading that was always right.
  for (const asked of ["keep the first 30 seconds", "just the first 30 seconds", "the first 30 seconds"]) {
    const kept = rangeIn(asked);
    check(`'${asked}' keeps the opening`, kept?.startSeconds === 0 && kept?.endSeconds === 30, JSON.stringify(kept));
  }

  // Losing it, which is the reading that was inverted.
  for (const asked of [
    "cut the first 10 seconds",
    "remove the first 10 seconds",
    "drop the first 10 seconds",
    "skip the first 10 seconds",
    "get rid of the first 10 seconds",
  ]) {
    const kept = rangeIn(asked);
    check(
      `'${asked}' loses the opening and keeps the rest`,
      kept?.startSeconds === 10 && kept?.endSeconds === TO_THE_END,
      JSON.stringify(kept),
    );
  }
  for (const asked of ["اقطع اول 10 ثواني", "احذف اول 10 ثواني", "شيل اول 10 ثواني"]) {
    const kept = rangeIn(asked);
    check(
      `«${asked}» يشيل البداية ويبقي الباقي`,
      kept?.startSeconds === 10 && kept?.endSeconds === TO_THE_END,
      JSON.stringify(kept),
    );
  }

  // Minutes, which is the same sentence with a different unit.
  const droppedMinute = rangeIn("cut the first minute");
  check(
    "'cut the first minute' loses sixty seconds, not keeps them",
    droppedMinute?.startSeconds === 60 && droppedMinute?.endSeconds === TO_THE_END,
    JSON.stringify(droppedMinute),
  );

  // And the sentence that contains the dropping verb and means the opposite.
  const cutTo = rangeIn("cut to the first 30 seconds");
  check(
    "'cut to the first 30 seconds' still keeps them",
    cutTo?.startSeconds === 0 && cutTo?.endSeconds === 30,
    JSON.stringify(cutTo),
  );

  /*
    And the reply, because a plan that drops the opening under a sentence
    saying "the part you asked for" is how this stayed invisible.
  */
  const saidFor = (asked) =>
    JSON.stringify(planFromText(asked, { assets: [] }).willDo ?? []);
  check("dropping says it drops", /drop the first/.test(saidFor("cut the first 10 seconds")), saidFor("cut the first 10 seconds"));
  check("and in Arabic too", /أشيل أول/.test(saidFor("اقطع اول 10 ثواني")), saidFor("اقطع اول 10 ثواني"));
  check("keeping still says it keeps", /keep only what is between/.test(saidFor("keep the first 30 seconds")));

  // ── The bed nobody asked for ────────────────────────────────────────────────
  const laysABed = (asked) => opsFor(asked).some((o) => o.type === "addMusic");
  for (const asked of [
    "the music is too loud",
    "the music is drowning me out",
    "turn the music down",
    "lower the music",
    "the soundtrack is too loud",
  ]) {
    check(`'${asked}' lays no bed`, laysABed(asked) === false, JSON.stringify(opsFor(asked)));
  }
  for (const asked of ["الموسيقى عالية كتير", "الموسيقى بتغطي صوتي", "نزل صوت الموسيقى", "خفف الموسيقى"]) {
    check(`«${asked}» ما بتحط موسيقى`, laysABed(asked) === false, JSON.stringify(opsFor(asked)));
  }
  // The request itself is untouched.
  check("'add some music' still lays one", laysABed("add some music") === true);

  /*
    And it is answered rather than ignored. Music already inside a recording
    shares one track with the voice, so there is nothing separate to turn down
    -- which is a real limit and says so, while levelling for the voice is
    offered as what we can do instead.
  */
  const complaint = planFromText("the music is too loud", { assets: [] });
  check(
    "the limit is named rather than swallowed",
    (complaint.cannotYet ?? []).some((p) => /already in the recording/.test(p.en)),
    JSON.stringify(complaint.cannotYet),
  );
  check(
    "and the sound is levelled, which is the part we can do",
    complaint.operations.some((o) => o.type === "normalizeLoudness"),
    JSON.stringify(complaint.operations),
  );
  check(
    "the complaint counts as having spoken about music",
    complaint.spoke?.music === true,
    "otherwise a later layer lays the bed the sentence just refused",
  );
}

console.log("\nThe words people use for the things we named ourselves");
{
  /*
    Nobody calls them captions when they want them bigger, nobody says
    widescreen, and «بس» at the end of a sentence is how this dialect says
    "only". Every one of these reached nothing at all, and the person was told
    we did not catch it, having asked for something the product does.

    Arabic was much the worse half: of the sentences that came back unheard in
    a sweep of both languages, twelve of twelve Arabic ones failed against six
    of sixteen English. That is the language most of the people using this
    write in.
  */
  const opsFor = (asked) => planFromText(asked, { assets: [] }).operations;
  const has = (asked, type) => opsFor(asked).some((o) => o.type === type);

  check("'make the text bigger' asks for captions", has("make the text bigger", "autoCaptions"));
  check("«كبر الخط» كمان", has("كبر الخط", "autoCaptions"));
  check("«الخط صغير» كمان", has("الخط صغير", "autoCaptions"));
  check(
    "and the captions it asks for are the big ones",
    opsFor("make the text bigger").find((o) => o.type === "autoCaptions")?.size === "l",
    JSON.stringify(opsFor("make the text bigger")),
  );
  /*
    And the near neighbour that must not move: «كبّر الصورة» is a zoom, not a
    caption, and a looser pattern would have put words on screen for it.
  */
  check("«كبر الصورة» ما بتطلب ترجمة", has("كبر الصورة", "autoCaptions") === false);

  check("«خليه عرضي» is widescreen", opsFor("خليه عرضي").find((o) => o.type === "formatForPlatform")?.platform === "youtube");
  check("«شيل الضجة» reaches the noise", has("شيل الضجة", "normalizeLoudness"));
  check("«ظبطلي الصوت» reaches the levelling", has("ظبطلي الصوت", "normalizeLoudness"));
  check("'just fix the audio' does too", has("just fix the audio please", "normalizeLoudness"));

  /*
    «بس» at the end means only this. It was the one spelling missing, and the
    sentence it broke -- "fix the audio, only that" -- came back with a
    ten-operation edit.
  */
  check("«ظبطلي الصوت بس» is the whole plan", saysOnlyThis("ظبطلي الصوت بس") === true);
  check("and so is 'just fix the audio please'", saysOnlyThis("just fix the audio please") === true);
  check("«بس» at the start is still 'but'", saysOnlyThis("بس انا بدي اشوف") === false);
}

console.log("\nA sentence the product does something about is never answered with 'I did not catch that'");
{
  /*
    Twenty-eight sentences of the kind somebody actually types, run through the
    real matcher and the real director. Eighteen came back unheard, and the
    split had a direction: six of sixteen English, twelve of twelve Arabic --
    in the language most of the people using this write in.

    Every one below is either something the product does, or something it can
    say a true sentence about. The bar this section holds is not that each is
    planned perfectly; it is that none of them is answered with "I did not
    catch what you want changed", which is what the product said to all of
    them.
  */
  const opsFor = (asked) => planFromText(asked, { assets: [] }).operations;
  const heard = (asked) => {
    const intent = planFromText(asked, { assets: [] });
    return (
      intent.operations.length > 0 ||
      intent.cannotYet.length > 0 ||
      intent.declined.length > 0 ||
      asksForAnEdit(asked)
    );
  };

  const TYPED = [
    "make it look professional",
    "make it look like mrbeast",
    "clean it up",
    "just fix the audio please",
    "make the text bigger",
    "the music is too loud",
    "make it 60 seconds",
    "speed it up",
    "no captions please",
    "cut the first 10 seconds",
    "خليه يطلع حلو",
    "اعمله زي فيديوهات اليوتيوب",
    "بدي اياه اقصر",
    "ظبطلي الصوت بس",
    "شيل الملل",
    "كبر الخط",
    "شيل الضجة",
    "حط اللوغو",
    "خليه دقيقة",
    "سرعه شوي",
    "بلا ترجمة",
    "خليه عرضي",
  ];
  for (const asked of TYPED) {
    check(`'${asked}' is heard`, heard(asked), "answered with the sentence that says we did not catch it");
  }

  /*
    A target length is the highlight request said the other way round, and it
    was the way that reached nothing. Somebody cutting to a platform's limit
    thinks in the limit.
  */
  const lengthOf = (asked) => opsFor(asked).find((o) => o.type === "extractHighlight")?.targetSeconds;
  check("'make it 60 seconds' asks for sixty", lengthOf("make it 60 seconds") === 60);
  check("'keep it under 30 seconds' asks for thirty", lengthOf("keep it under 30 seconds") === 30);
  check("«خليه 45 ثانية» تطلب 45", lengthOf("خليه 45 ثانية") === 45);
  check("«خليه دقيقة» تطلب دقيقة", lengthOf("خليه دقيقة") === 60);
  check("'make it 2 minutes' asks for two", lengthOf("make it 2 minutes") === 120);
  /*
    And the neighbours that must not become one. A named stretch already said
    which seconds it wanted, and a bare number is a moment, a count of clips or
    a year -- this file reads one four different ways.
  */
  check("a named range is still a range", lengthOf("keep from 1:20 to 2:10") === undefined);
  check("'make it 3' is not a length", lengthOf("make it 3") === undefined);
  check("'give me 3 clips' is not a length", lengthOf("give me 3 clips") === undefined);

  /*
    Playing it faster is a real edit this product does not do. Silence was the
    worst of the three answers: the person asked for something ordinary in
    ordinary words and was told they had not made sense.
  */
  const refusalFor = (asked) => JSON.stringify(planFromText(asked, { assets: [] }).cannotYet ?? []);
  check("'2x speed' is refused, not ignored", /faster or slower/.test(refusalFor("2x speed")));
  check("'slow motion' too", /faster or slower/.test(refusalFor("slow motion")));
  check("«بطئه شوي» كمان", /أسرع أو أبطأ/.test(refusalFor("بطئه شوي")));
  check(
    "and the refusal names the thing we do instead",
    /take out the pauses/.test(refusalFor("2x speed")),
    "a refusal that names no alternative is a dead end",
  );
  /*
    "Speed it up" is a tighten in both languages, and that is the decision
    rather than an omission. «سرّع» has meant tighten since the beginning; a
    talk that drags is fixed by cutting the pauses, not by 1.2x; and the reply
    names which of the two it did. The two halves had drifted apart before
    this: English was refused while Arabic was tightened, so one request got
    opposite answers depending on which language it was typed in.
  */
  check("'speed it up' tightens", opsFor("speed it up").some((o) => o.type === "removeSilence"));
  check("«سرعه شوي» تختصر كمان", opsFor("سرعه شوي").some((o) => o.type === "removeSilence"));
  check("and the two languages agree", heard("speed it up") === heard("سرعه شوي"));
  /*
    The near neighbour, and it is close: «حركة بطيئة على الصورة» is a slow push
    on the picture, which this product does. An earlier spelling of the pattern
    above swallowed it, and bilingual-test caught that -- which is what these
    two lines are here to keep true.
  */
  check("«حركة بطيئة على الصورة» is still a push", opsFor("حركة بطيئة على الصورة").some((o) => o.type === "kenBurns"));
  check("'make it faster' is still a tighten, not a refusal", opsFor("make it faster").some((o) => o.type === "removeSilence"));

  /*
    A sentence that is nothing but a no is answered with the no. It was
    answered with "I did not catch that", while the refusal was being honoured
    the whole time -- a reply wrong about a product that was right.
  */
  const replyTo = (asked) => replyFor(planFromText(asked, { assets: [] }), { hasVideo: true });
  check("'no captions please' is answered with the no", /Right, no captions/.test(replyTo("no captions please")), replyTo("no captions please"));
  check("«بلا ترجمة» كمان", /تمام، بلا ترجمة/.test(replyTo("بلا ترجمة")), replyTo("بلا ترجمة"));
  check(
    "the no goes on each one, not once at the front",
    /no captions and no music/.test(replyTo("no music and no captions")),
    replyTo("no music and no captions"),
  );
  check(
    "and a sentence that also asked for something keeps its plan",
    !/Right, no/.test(replyTo("captions but no music")),
    replyTo("captions but no music"),
  );
}

console.log("\nArabic as people type it, not as a dictionary spells it");
{
  /*
    Nobody reaches for the hamza key on a phone. «أقوى» is typed «اقوى»,
    «أفضل» is «افضل», «إيقاع» is «ايقاع» -- and a third of the Arabic patterns
    in the matcher were written with the hamza, so a third of what this product
    can do was unreachable for anybody typing at normal speed.

    The one that makes it plain: «أعطني أقوى 30 ثانية مع ترجمة، عمودية لتيك
    توك» is the sentence the product *offers* as an example when it cannot read
    something, and «اعطيني اقوى 30 ثانية» -- the same request, typed the way a
    person types -- reached nothing at all. It was recommending a sentence it
    could only understand in one spelling.

    Both sides are folded now: hamza carriers to bare alef, alef maqsura to
    yaa, taa marbuta to haa, tatweel and the short vowels dropped.
  */
  const opsFor = (asked) => planFromText(asked, { assets: [] }).operations;
  const has = (asked, type) => opsFor(asked).some((o) => o.type === type);

  const SAME_REQUEST = [
    ["أعطني أقوى 30 ثانية", "اعطيني اقوى 30 ثانيه", "extractHighlight"],
    ["خلّيه أبيض وأسود", "خليه ابيض واسود", "grade"],
    ["اقصّ الصمت", "اقص الصمت", "removeSilence"],
    ["أضف ترجمة", "اضف ترجمه", "autoCaptions"],
    ["خلّيه عمودي", "خليه عمودي", "formatForPlatform"],
    ["حطّ موسيقى هادئة", "حط موسيقي هادئه", "addMusic"],
  ];
  for (const [proper, typed, type] of SAME_REQUEST) {
    check(`«${proper}» works`, has(proper, type), JSON.stringify(opsFor(proper)));
    check(`and «${typed}» is the same request`, has(typed, type), JSON.stringify(opsFor(typed)));
  }

  /*
    And the example the product recommends, which has to parse. A suggestion
    that does not work is worse than no suggestion: the person follows it
    exactly and is told again that we did not understand.
  */
  const SUGGESTED = "أعطني أقوى 30 ثانية مع ترجمة، عمودية لتيك توك";
  check("the sentence the product suggests in Arabic actually parses", has(SUGGESTED, "extractHighlight"));
  check("and its captions half too", has(SUGGESTED, "autoCaptions"));
  check("and its shape half", opsFor(SUGGESTED).find((o) => o.type === "formatForPlatform")?.platform === "tiktok");
  const SUGGESTED_EN = "give me the strongest 30 seconds, captioned, vertical for TikTok";
  check("and the English one", has(SUGGESTED_EN, "extractHighlight") && has(SUGGESTED_EN, "autoCaptions"));

  /*
    The cost of folding, which is what this half is for.

    Dropping the shadda takes away a distinction somebody was relying on:
    «قرّب» is "zoom in" and «بالقرب من» is "near", and the shadda was the only
    thing between them. It is `arWord` now -- an Arabic letter in front of the
    word refuses the match -- and these sentences are the proof, because the
    first version of the fold punched in on every one of them that says
    something is near something.

    Ordinary Arabic that is not a request for an edit. Any of these producing
    an operation is somebody being charged for a render because they said
    hello.
  */
  const NOT_REQUESTS = [
    "شكرا كتير",
    "مرحبا كيفك",
    "الحديقة بالقرب من البيت",
    "هاي قصة طويلة",
    "الفيديو قصير",
    "وصلت عالمنزل",
    "في حادث بالشارع",
    "على حافة الطاولة",
    "خطة الشغل جاهزة",
    "بدي اعرف شو صار",
    "ما فهمت عليك",
    "الجو حلو اليوم",
    "شو رأيك",
    "متى بتخلص",
    "كم سعر الاشتراك",
    "في مشكلة بالحساب",
    "بدي احكي مع حدا",
    "الصورة مو واضحة",
    "ما اشتغل معي",
  ];
  for (const asked of NOT_REQUESTS) {
    check(
      `«${asked}» is not an edit`,
      opsFor(asked).length === 0 && !asksForAnEdit(asked),
      JSON.stringify(opsFor(asked).map((o) => o.type)),
    );
  }
  // And the one that must still be: «خليه حلو» is a request, «الجو حلو» is not.
  check("«خليه حلو» is still an edit", asksForAnEdit("خليه حلو"));
}

console.log("\nSixty-nine more sentences, typed the way people type them");
{
  /*
    A second corpus, written after the first round of fixes and deliberately
    not overlapping it: the things somebody says on their fourth message rather
    than their first. Twenty-two of these came back unheard.

    The bar is the same and it is not "planned perfectly". It is that the
    product says something true about every one -- it does the thing, or it
    names the one fact it needs, or it says plainly that it cannot and points
    at the nearest thing it can.

    The two it still cannot hear are listed at the bottom as exactly that,
    rather than quietly dropped from the corpus.
  */
  const opsFor = (asked) => planFromText(asked, { assets: LIBRARY }).operations;
  const heard = (asked) => {
    const intent = planFromText(asked, { assets: LIBRARY });
    return (
      intent.operations.length > 0 ||
      intent.cannotYet.length > 0 ||
      intent.declined.length > 0 ||
      asksForAnEdit(asked)
    );
  };

  const TYPED = [
    "add a hook at the start", "put the best bit first", "make the intro shorter",
    "cut the intro", "remove the outro", "trim the end", "i want it punchier",
    "add some energy", "make it feel faster", "give it a cinematic look",
    "warm it up a bit", "make the colours pop", "crop it to square",
    "add chapter titles", "put a title card at the start", 'name it "Episode 4"',
    "add my name at the bottom", "subtitle it in white", "yellow captions",
    "karaoke style captions", "captions one word at a time", "put captions at the bottom",
    "smaller captions", "add a whoosh between cuts", "quieter sound effects",
    "no sound effects", "louder voice", "duck the music under my voice",
    "fade the music out at the end", "cut on the beat", "add b roll from my clips",
    "show the screenshot at 10 seconds", "zoom in when i make the point",
    "center me in frame", "follow my face", "add a progress bar",
    "ضيف هوك بالبداية", "حط الاحلى بالاول", "قصر المقدمة", "احذف المقدمة",
    "شيل النهاية", "بدي اياه احلى", "ضيف طاقة", "خليه سينمائي", "دفي الالوان",
    "خليه مربع", "حط عنوان بالبداية", 'سمّيه "الحلقة 4"', "حط اسمي تحت",
    "ترجمة بيضا", "ترجمة صفرا", "كابشن كاريوكي", "ترجمة كلمة كلمة",
    "حط الترجمة تحت", "ترجمة اصغر", "ضيف صوت انتقال", "مؤثرات اهدى",
    "بلا مؤثرات", "صوتي اعلى", "نزل الموسيقى تحت صوتي", "الموسيقى تخفت بالاخر",
    "قص على الايقاع", "حط مقاطع من ملفاتي", "ورجيني الصورة عند الثانية 10",
    "قرب لما احكي النقطة المهمة",
  ];
  for (const asked of TYPED) {
    check(`'${asked}' is heard`, heard(asked), "answered with the sentence that says we did not catch it");
  }

  /*
    And the shape of each answer, spot-checked where getting it wrong would be
    invisible: a refusal that reads like a plan, or a plan that quietly does
    something else.
  */
  const refusalFor = (asked) => JSON.stringify(planFromText(asked, { assets: LIBRARY }).cannotYet ?? []);
  check("'cut the intro' asks how long it runs", /how long/i.test(refusalFor("cut the intro")));
  check("«احذف المقدمة» كمان", /قدّيش طولها/.test(refusalFor("احذف المقدمة")));
  check("'follow my face' points at the two-camera cut", /wide shot and a close one/i.test(refusalFor("follow my face")));
  check("'add a progress bar' says plainly that it cannot", /bar showing how much is left/i.test(refusalFor("add a progress bar")));
  check(
    "'add my name at the bottom' asks for the words",
    /do not know the words/i.test(refusalFor("add my name at the bottom")),
  );
  check("«حط اسمي تحت» كمان", /ما بعرف كلماته/.test(refusalFor("حط اسمي تحت")));
  check(
    "and only once, not three times over",
    JSON.parse(refusalFor("put a title card at the start")).filter((p) => /title|عنوان/i.test(p.en + p.ar)).length <= 1,
    refusalFor("put a title card at the start"),
  );

  /*
    Asking for the cuts to follow the music is asking for the music too, so the
    answer is a bed and zooms that land on its beats. Checked as that rather
    than as an operation with "beat" in its name, which is not how the plan
    spells it.
  */
  const beat = opsFor("cut on the beat").map((o) => o.type);
  check("'cut on the beat' lays the track and lands the zooms on it", beat.includes("addMusic") && beat.includes("zoomPunch"), JSON.stringify(beat));
  check("«قص على الايقاع» كمان", (() => { const a = opsFor("قص على الايقاع").map((o) => o.type); return a.includes("addMusic") && a.includes("zoomPunch"); })());
  check("'add b roll from my clips' reaches the clips", opsFor("add b roll from my clips").some((o) => o.type === "insertBRoll"));
  check("«حط مقاطع من ملفاتي» كمان", opsFor("حط مقاطع من ملفاتي").some((o) => o.type === "insertBRoll"));
  check("'make the colours pop' is the punchy look", opsFor("make the colours pop").find((o) => o.type === "grade")?.look === "punch");
  check("«دفي الالوان» دافي", opsFor("دفي الالوان").find((o) => o.type === "grade")?.look === "warm");
  check("«صوتي اعلى» reaches the levelling", opsFor("صوتي اعلى").some((o) => o.type === "normalizeLoudness"));
  check("«مؤثرات اهدى» reaches the effects", opsFor("مؤثرات اهدى").some((o) => o.type === "soundEffects"));
  check("«حط الاحلى بالاول» is a cold open", opsFor("حط الاحلى بالاول").some((o) => o.type === "coldOpen"));
}

await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("A model can choose the edit; it cannot make the product lie.");
