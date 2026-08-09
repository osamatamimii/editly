/**
 * Checks the model layer without owning a single API key.
 *
 * Everything that talks to a provider takes an injectable `fetch`, so the parts
 * that actually break in production — the request we send, the shape we expect
 * back, and what happens when a key is missing — can all be checked here. The
 * parts that need real ffmpeg (the audio we upload for transcription, the proxy
 * we upload for scene reading) run for real, because their whole purpose is
 * being small and correctly formatted, and a mock would prove neither.
 *
 * Usage: node tools/models-test.mjs
 * Requires: ffmpeg and ffprobe on PATH. No keys, no network.
 */
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-models-build-"));

function bundle(entry, name) {
  const outfile = path.join(buildDir, name);
  const result = spawnSync(
    require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/worker"] }),
    [
      path.join(repoRoot, entry),
      "--bundle", "--platform=node", "--format=esm", "--target=node22",
      `--outfile=${outfile}`, "--log-level=error",
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0) {
    console.error(`could not bundle ${entry}`);
    process.exit(1);
  }
  return pathToFileURL(outfile).href;
}

const providers = await import(bundle("artifacts/worker/src/providers/index.ts", "providers.mjs"));
const deepgram = await import(bundle("artifacts/worker/src/providers/deepgram.ts", "deepgram.mjs"));
const gemini = await import(bundle("artifacts/worker/src/providers/gemini.ts", "gemini.mjs"));
const captions = await import(bundle("artifacts/worker/src/captions.ts", "captions.mjs"));

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

const workDir = await mkdtemp(path.join(tmpdir(), "editly-models-"));
const at = (name) => path.join(workDir, name);

/** A Deepgram response in the shape their API really returns. */
const word = (w, start, end, confidence = 0.99, speaker) => ({
  word: w.toLowerCase(),
  punctuated_word: w,
  start,
  end,
  confidence,
  ...(speaker === undefined ? {} : { speaker }),
});

const DEEPGRAM_REPLY = {
  results: {
    channels: [
      {
        detected_language: "en",
        alternatives: [
          {
            words: [
              word("So", 0.10, 0.32),
              word("um", 0.36, 0.62),
              word("this", 0.90, 1.10),
              word("is", 1.10, 1.22),
              word("the", 1.22, 1.34),
              word("part", 1.34, 1.98),
              word("nobody", 2.40, 2.86),
              word("tells", 2.86, 3.10),
              word("you.", 3.10, 3.40),
              word("Ready?", 4.60, 5.20, 0.21),
            ],
            paragraphs: {
              paragraphs: [
                { sentences: [{ start: 0.10, end: 3.40 }, { start: 4.60, end: 5.20 }] },
              ],
            },
          },
        ],
      },
    ],
  },
};

console.log("\nReading what the recogniser said");
{
  const transcript = deepgram.parseDeepgram(DEEPGRAM_REPLY, "deepgram/nova-3");
  const words = transcript.segments.flatMap((s) => s.words);

  check("it finds every word", words.length === 10, `${words.length}`);
  check("timings are milliseconds, not seconds", words[0].startMs === 100 && words[0].endMs === 320, JSON.stringify(words[0]));
  check("it keeps the punctuated form, which is what goes on screen", words[8].text === "you.", words[8].text);
  check("fillers are flagged rather than dropped for us", words[1].filler === true && words[0].filler === false, "");
  check("the detected language comes through", transcript.language === "en", `${transcript.language}`);
  check(
    "sentences follow the provider's own boundaries",
    transcript.segments.length === 2 && transcript.segments[1].text === "Ready?",
    JSON.stringify(transcript.segments.map((s) => s.text)),
  );

  let threw = false;
  try {
    deepgram.parseDeepgram({ results: { channels: [] } }, "x");
  } catch {
    threw = true;
  }
  check("a response we do not understand fails loudly, not as an empty transcript", threw, "");
}

console.log("\nRequesting it correctly");
{
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(DEEPGRAM_REPLY), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  const clip = at("speech.mp4");
  spawnSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "sine=frequency=300:duration=3",
    "-f", "lavfi", "-i", "color=c=gray:size=320x240:rate=25:duration=3",
    "-map", "0:a", "-map", "1:v", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip,
  ]);

  const transcriber = deepgram.createDeepgramTranscriber({ apiKey: "test-key-not-real", fetchImpl });
  const transcript = await transcriber.transcribe(clip);

  const call = calls[0];
  check("it asks the model we chose", call.url.includes("model=nova-3"), call.url);
  check("it asks for filler words, which most transcripts hide", call.url.includes("filler_words=true"), call.url);
  check("it uses Deepgram's Token scheme, not Bearer", call.init.headers.Authorization.startsWith("Token "), "");
  check("it uploads audio, not the video container", call.init.headers["Content-Type"] === "audio/flac", "");
  check("and it returns a parsed transcript", transcript.segments.length === 2, "");
  check("labelled with what produced it", transcript.source === "deepgram/nova-3", transcript.source);
}

console.log("\nThe audio we send");
{
  const clip = at("speech.mp4");
  const audio = await deepgram.extractSpeechAudio(clip);
  const probe = spawnSync("ffprobe", [
    "-v", "error", "-select_streams", "a:0",
    "-show_entries", "stream=codec_name,channels,sample_rate",
    "-of", "default=nw=1", audio,
  ], { encoding: "utf8" }).stdout;

  check("it is lossless, because cut decisions come from these timings", /codec_name=flac/.test(probe), probe.trim());
  check("mono at 16 kHz, which is what speech models consume", /channels=1/.test(probe) && /sample_rate=16000/.test(probe), probe.trim());

  // A pure sine is the worst case FLAC can be handed — real speech compresses
  // to roughly a third of this. What matters is the ceiling: never worse than
  // raw 16-bit PCM at 16 kHz, so an upload stays proportional to the hour of
  // audio rather than to the gigabytes of video it came from.
  const audioBytes = (await stat(audio)).size;
  const bytesPerSecond = audioBytes / 3;
  check(
    "never larger than raw PCM, so hours of audio stay a sane upload",
    bytesPerSecond <= 32000,
    `${Math.round(bytesPerSecond)} bytes/s`,
  );
  await rm(path.dirname(audio), { recursive: true, force: true });
}

console.log("\nCaptions someone can read");
{
  const transcript = deepgram.parseDeepgram(DEEPGRAM_REPLY, "deepgram/nova-3");
  const cues = captions.buildCaptionCues(transcript, { maxCharsPerLine: 12, maxLines: 2 });

  check("it produces cues", cues.length > 0, `${cues.length}`);
  check(
    "no cue is wider than the frame allows",
    cues.every((c) => c.text.length <= 24),
    JSON.stringify(cues.map((c) => c.text)),
  );
  check(
    "no two cues are on screen at once",
    cues.every((c, i) => i === 0 || c.startMs >= cues[i - 1].endMs),
    JSON.stringify(cues.map((c) => [c.startMs, c.endMs])),
  );
  check(
    "the filler is not burnt in",
    cues.every((c) => !/\bum\b/i.test(c.text)),
    JSON.stringify(cues.map((c) => c.text)),
  );
  check(
    "a word the recogniser doubted is not asserted on screen",
    cues.some((c) => c.text.includes("…")) && cues.every((c) => !/Ready/.test(c.text)),
    JSON.stringify(cues.map((c) => c.text)),
  );
  check(
    "every cue carries word timings, so karaoke is possible",
    cues.every((c) => c.words.length > 0 && c.words.every((w) => w.endMs >= w.startMs)),
    "",
  );

  const brief = captions.buildCaptionCues(
    { segments: [{ startMs: 0, endMs: 200, text: "Hi", words: [{ text: "Hi", startMs: 0, endMs: 200, confidence: 1, filler: false }] }], language: null, source: "test" },
    {},
  );
  check("a cue too short to read is held longer", brief[0].endMs >= 700, `${brief[0].endMs} ms`);
}

console.log("\nWhere the emphasis fell");
{
  // "and THAT" — a pause, then a word held far longer than its neighbours.
  const words = [
    { text: "it", startMs: 0, endMs: 150, confidence: 1, filler: false },
    { text: "was", startMs: 150, endMs: 300, confidence: 1, filler: false },
    { text: "not", startMs: 300, endMs: 450, confidence: 1, filler: false },
    { text: "the", startMs: 450, endMs: 600, confidence: 1, filler: false },
    { text: "money", startMs: 1400, endMs: 2300, confidence: 1, filler: false },
    { text: "at", startMs: 2300, endMs: 2450, confidence: 1, filler: false },
    { text: "all", startMs: 2450, endMs: 2600, confidence: 1, filler: false },
  ];
  const points = captions.emphasisPoints({ segments: [{ startMs: 0, endMs: 2600, text: "", words }], language: null, source: "t" }, 4);

  check("the stressed word is found", points.includes(1.4), JSON.stringify(points));
  check("and ordinary words around it are not", points.length === 1, JSON.stringify(points));
  check("points are in order and spaced apart", points.every((p, i) => i === 0 || p - points[i - 1] >= 1.5), JSON.stringify(points));
  check(
    "flat delivery earns no punches rather than arbitrary ones",
    captions.emphasisPoints({
      segments: [{
        startMs: 0, endMs: 1200, text: "",
        words: Array.from({ length: 8 }, (_, i) => ({ text: "w", startMs: i * 150, endMs: i * 150 + 150, confidence: 1, filler: false })),
      }],
      language: null, source: "t",
    }).length === 0,
    "",
  );
  check(
    "a clip with almost no speech gets no punches invented for it",
    captions.emphasisPoints({ segments: [{ startMs: 0, endMs: 10, text: "", words: words.slice(0, 2) }], language: null, source: "t" }).length === 0,
    "",
  );
}

console.log("\nThe proxy we send to a model that watches");
{
  const source = at("motion.mp4");
  spawnSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30:duration=6",
    "-f", "lavfi", "-i", "sine=frequency=300:duration=6",
    "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source,
  ]);

  const proxy = await gemini.makeProxy(source, 0, 6000);
  const probe = spawnSync("ffprobe", [
    "-v", "error", "-show_entries", "stream=codec_type,height,avg_frame_rate", "-of", "default=nw=1", proxy,
  ], { encoding: "utf8" }).stdout;

  check("it is 360p, not the source resolution", /height=360/.test(probe), probe.trim());
  check("one frame a second, which is the rate the model samples at", /avg_frame_rate=1\/1/.test(probe), probe.trim());
  check("silent, because the transcript already covers the audio", !/codec_type=audio/.test(probe), probe.trim());

  const proxyBytes = (await stat(proxy)).size;
  const sourceBytes = (await stat(source)).size;
  check("and a fraction of what the source would cost to upload", proxyBytes < sourceBytes / 4, `${proxyBytes} vs ${sourceBytes} bytes`);
  await rm(path.dirname(proxy), { recursive: true, force: true });
}

console.log("\nReading the scenes back");
{
  const reply = {
    candidates: [
      {
        content: {
          parts: [
            {
              text: JSON.stringify({
                scenes: [
                  { startSeconds: 0, endSeconds: 4.5, description: "talking to camera", interest: 0.7, protect: false },
                  { startSeconds: 4.5, endSeconds: 12, description: "screen share of the demo", interest: 0.9, protect: true },
                  { startSeconds: 12, endSeconds: 12, description: "zero length", interest: 1, protect: false },
                ],
              }),
            },
          ],
        },
      },
    ],
  };
  const scenes = gemini.parseScenes(reply);

  check("scenes come back in milliseconds", scenes[0].endMs === 4500, JSON.stringify(scenes[0]));
  check("a stretch we must not cut through is marked", scenes[1].protect === true, "");
  check("a zero-length scene is discarded rather than passed on", scenes.length === 2, `${scenes.length}`);
  check("interest is clamped to a usable range", scenes.every((s) => s.interest >= 0 && s.interest <= 1), "");
  check("an empty answer is not an error", gemini.parseScenes({ candidates: [] }).length === 0, "");

  let threw = false;
  try {
    gemini.parseScenes({ candidates: [{ content: { parts: [{ text: "I'm sorry, I can't help with that." }] } }] });
  } catch {
    threw = true;
  }
  check("but prose where JSON was promised fails loudly", threw, "");
}

console.log("\nWhat happens with no keys at all");
{
  const none = providers.resolveProviders({});
  check("no transcriber is invented", none.transcriber === null, "");
  check("no scene reader is invented", none.sceneReader === null, "");
  check(
    "and the reason is in words a render note can carry",
    typeof none.status.transcription === "string" && none.status.transcription.length > 20,
    `${none.status.transcription}`,
  );

  const notes = providers.missingCapabilityNotes(none.status, { transcript: true, vision: false });
  check("a plan that needed captions says why it has none", notes.length === 1, JSON.stringify(notes));
  check(
    "a plan that needed nothing missing stays quiet",
    providers.missingCapabilityNotes(none.status, { transcript: false, vision: false }).length === 0,
    "",
  );

  const both = providers.resolveProviders({ DEEPGRAM_API_KEY: "k", GEMINI_API_KEY: "k" });
  check("with keys, both capabilities appear", both.transcriber !== null && both.sceneReader !== null, "");
  check("and nothing is reported as missing", both.status.transcription === null && both.status.vision === null, "");
  check("a key that is only whitespace counts as absent", providers.resolveProviders({ DEEPGRAM_API_KEY: "   " }).transcriber === null, "");
  check(
    "the resolved providers do not carry the key back out",
    !JSON.stringify(both, (k, v) => (typeof v === "function" ? undefined : v)).includes('"k"'),
    "",
  );
}

console.log("\nFilling in what only the video knows");
{
  const enrich = await import(bundle("artifacts/worker/src/enrich.ts", "enrich.mjs"));
  const transcript = deepgram.parseDeepgram(DEEPGRAM_REPLY, "deepgram/nova-3");

  const withTranscriber = {
    transcriber: { name: "stub", transcribe: async () => transcript },
    sceneReader: null,
    status: { transcription: null, vision: "no vision" },
  };
  const withNothing = providers.resolveProviders({});

  const captionPlan = { version: 1, operations: [{ type: "autoCaptions", style: "bold-white", animation: "pop", dropFillers: true }] };

  {
    const out = await enrich.enrichPlan("unused.mp4", captionPlan, { providers: withTranscriber });
    check("autoCaptions becomes real cues once we have heard the video", out.plan.operations[0].type === "burnCaptions", out.plan.operations[0]?.type);
    check("with the words in them", out.plan.operations[0].cues.length > 0, "");
    check("and the requested look is carried over", out.plan.operations[0].style === "bold-white", "");
    check("nothing is reported as degraded", out.notes.length === 0, JSON.stringify(out.notes));
    check("the transcript is handed back so nobody pays for it twice", out.transcript !== null, "");
  }

  {
    const out = await enrich.enrichPlan("unused.mp4", captionPlan, { providers: withNothing });
    check("with no recogniser the captions are dropped, not faked", out.plan.operations.length === 0, "");
    check("and the reason travels with the job", /speech recognition is configured/.test(out.notes.join(" ")), JSON.stringify(out.notes));
  }

  {
    const failing = {
      transcriber: { name: "stub", transcribe: async () => { throw new Error("provider is down"); } },
      sceneReader: null,
      status: { transcription: null, vision: null },
    };
    const plan = {
      version: 1,
      operations: [
        { type: "removeSilence", thresholdDb: -32, minSilenceMs: 500, paddingMs: 80 },
        { type: "autoCaptions", style: "bold-white", animation: "pop", dropFillers: true },
      ],
    };
    const out = await enrich.enrichPlan("unused.mp4", plan, { providers: failing });
    check("a provider outage does not fail the whole render", out.plan.operations.length === 1 && out.plan.operations[0].type === "removeSilence", "");
    check("it says what was lost", /no captions/.test(out.notes.join(" ")), JSON.stringify(out.notes));
  }

  {
    const plan = { version: 1, operations: [{ type: "zoomPunch", at: [], amount: 0.13, holdMs: 1000 }] };
    const out = await enrich.enrichPlan("unused.mp4", plan, { providers: withTranscriber });
    // The sample has one clear stress: "part", held after a pause.
    check("punches land on the emphasis instead of on a metronome", out.plan.operations[0]?.at.length > 0, JSON.stringify(out.plan.operations[0]));
  }

  {
    const flat = {
      segments: [{ startMs: 0, endMs: 1200, text: "", words: Array.from({ length: 8 }, (_, i) => ({ text: "w", startMs: i * 150, endMs: i * 150 + 150, confidence: 1, filler: false })) }],
      language: null,
      source: "t",
    };
    const evenProviders = { transcriber: { name: "stub", transcribe: async () => flat }, sceneReader: null, status: { transcription: null, vision: null } };
    const plan = { version: 1, operations: [{ type: "zoomPunch", at: [], amount: 0.13, holdMs: 1000 }] };
    const out = await enrich.enrichPlan("unused.mp4", plan, { providers: evenProviders });
    check("even delivery gets no punches rather than arbitrary ones", out.plan.operations.length === 0, "");
    check("and says so", /arbitrarily/.test(out.notes.join(" ")), JSON.stringify(out.notes));
  }

  {
    const plan = {
      version: 1,
      operations: [
        { type: "removeSilence", thresholdDb: -32, minSilenceMs: 500, paddingMs: 80 },
        { type: "formatForPlatform", platform: "tiktok" },
        { type: "normalizeLoudness", targetLufs: -14 },
      ],
    };
    const out = await enrich.enrichPlan("unused.mp4", plan, { providers: withNothing });
    check(
      "a plan needing no model passes through untouched, in order",
      JSON.stringify(out.plan.operations) === JSON.stringify(plan.operations),
      JSON.stringify(out.plan.operations),
    );
    check("and asks for no transcription it does not need", out.transcript === null, "");
  }
}

await rm(workDir, { recursive: true, force: true });
await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("The model layer is wired, and honest about what it is missing.");
