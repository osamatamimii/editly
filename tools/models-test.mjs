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
    typeof none.status.transcription?.en === "string" &&
      none.status.transcription.en.length > 20 &&
      typeof none.status.transcription.ar === "string" &&
      none.status.transcription.ar.length > 20,
    JSON.stringify(none.status.transcription),
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

  /**
   * What the plan actually needs ears for.
   *
   * An empty punch list means two different things and they look identical
   * from here. An *emphasis* punch has none because the renderer is meant to
   * place them on the words, which is a transcript. A *beat* punch has none
   * because the renderer is meant to place them on the track's beat grid,
   * which is decoded from the audio and owes nothing to what was said.
   *
   * Transcribing for the second is a provider call paid for, waited on and
   * discarded — and when that provider is down it answers "we could not hear
   * the words in this clip, so this render has no captions" on a render that
   * never wanted any. Nothing fails; the edit is right and the bill and the
   * notes are wrong.
   */
  {
    let heard = 0;
    const counting = {
      ...withTranscriber,
      transcriber: { name: "stub", transcribe: async () => { heard += 1; return transcript; } },
    };

    heard = 0;
    await enrich.enrichPlan(
      "unused.mp4",
      { version: 1, operations: [{ type: "zoomPunch", on: "emphasis", at: [], amount: 0.13, holdMs: 900 }] },
      { providers: counting },
    );
    check("a punch on the speaker's emphasis is worth listening for", heard === 1, `transcribed ${heard} times`);

    heard = 0;
    await enrich.enrichPlan(
      "unused.mp4",
      { version: 1, operations: [{ type: "zoomPunch", on: "beat", at: [], amount: 0.16, holdMs: 420 }] },
      { providers: counting },
    );
    check("a punch on the beat is not", heard === 0, `transcribed ${heard} times for an edit that reads the music`);

    // The symptom, rather than the call count: with the provider down, a plan
    // that never wanted words was being told it had lost its captions.
    const down = {
      ...withTranscriber,
      transcriber: { name: "stub", transcribe: async () => { throw new Error("provider is down"); } },
    };
    const beat = await enrich.enrichPlan(
      "unused.mp4",
      { version: 1, operations: [{ type: "zoomPunch", on: "beat", at: [], amount: 0.16, holdMs: 420 }] },
      { providers: down },
    );
    check(
      "and a transcriber that is down says nothing to a render that wanted no words",
      !beat.notes.some((n) => /could not hear the words/.test(n)),
      JSON.stringify(beat.notes),
    );

    // And the moment anything else in the plan wants words, they are fetched —
    // so this is a narrowing, not a new way to lose captions.
    heard = 0;
    await enrich.enrichPlan(
      "unused.mp4",
      {
        version: 1,
        operations: [
          { type: "zoomPunch", on: "beat", at: [], amount: 0.16, holdMs: 420 },
          captionPlan.operations[0],
        ],
      },
      { providers: counting },
    );
    check("unless the same plan also wants captions", heard === 1, `transcribed ${heard} times`);
  }

  /**
   * The language the audio was heard as, said only when it is not the one
   * they wrote in.
   *
   * Captions in the wrong language are the one failure that looks completely
   * normal from the outside: the render succeeds, the words are confident, the
   * timings are right, and the file is wrong. A line in the notes is how
   * somebody catches it in two seconds instead of by watching the whole thing.
   *
   * And *only* when it differs. Telling an English speaker we heard English
   * is noise — and a pipeline that writes a note when nothing deviated has
   * lost the ability to say when something did, which is the check directly
   * above this one.
   */
  {
    const arabicHeard = { ...transcript, language: "ar-EG" };
    const arabicProviders = {
      ...withTranscriber,
      transcriber: { name: "stub", transcribe: async () => arabicHeard },
    };

    const mismatch = await enrich.enrichPlan("unused.mp4", captionPlan, {
      providers: arabicProviders,
      language: "en",
    });
    check(
      "a clip heard in another language than the one they wrote in says so",
      mismatch.notes.some((n) => /heard the speech as ar/.test(n)),
      JSON.stringify(mismatch.notes),
    );

    const agrees = await enrich.enrichPlan("unused.mp4", captionPlan, {
      providers: arabicProviders,
      language: "ar",
    });
    check(
      "and says nothing when it is the language they wrote in — a dialect tag included",
      agrees.notes.length === 0,
      JSON.stringify(agrees.notes),
    );

    const asked = await enrich.enrichPlan(
      "unused.mp4",
      { version: 1, operations: [{ ...captionPlan.operations[0], language: "ar" }] },
      { providers: arabicProviders, language: "en" },
    );
    check(
      "and says nothing when they named the language themselves",
      !asked.notes.some((n) => /heard the speech as/.test(n)),
      JSON.stringify(asked.notes),
    );

    // ── What the recogniser is actually asked ───────────────────────────
    //
    // The provider knows which languages its detector can name; only this
    // layer knows which language the person wrote in. Neither is any use
    // without the other, and the wiring between them is exactly the kind of
    // thing that gets written once, believed, and never called — so it is
    // asserted here rather than assumed. A belief, not an instruction: it is
    // sent as `expected`, and a provider that can detect the language is free
    // to ignore it.
    const seen = [];
    const spy = {
      ...arabicProviders,
      transcriber: {
        name: "stub",
        transcribe: async (_path, opts) => {
          seen.push(opts ?? {});
          return arabicHeard;
        },
      },
    };
    await enrich.enrichPlan("unused.mp4", captionPlan, { providers: spy, language: "ar" });
    check(
      "the language they wrote in reaches the recogniser as a belief",
      seen[0]?.expected === "ar" && seen[0]?.language === undefined,
      JSON.stringify(seen[0] ?? null),
    );

    await enrich.enrichPlan(
      "unused.mp4",
      { version: 1, operations: [{ ...captionPlan.operations[0], language: "en" }] },
      { providers: spy, language: "ar" },
    );
    check(
      "and a language named on the plan travels as an instruction, alongside it",
      seen[1]?.language === "en" && seen[1]?.expected === "ar",
      JSON.stringify(seen[1] ?? null),
    );
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

console.log("\nA provider's own words do not become the customer's explanation");
{
  const enrich = await import(bundle("artifacts/worker/src/enrich.ts", "enrich-redaction.mjs"));

  // These notes are persisted on the job row and returned verbatim to the
  // browser, and `index.ts` promotes notes[0] into the render's entire failure
  // message when a plan ends up empty. The providers throw
  // "<provider> <status>: <their response body>", so what a customer read about
  // their own video was:
  //
  //   speech recognition failed (deepgram 401: {"err_code":"INVALID_AUTH",
  //   "err_msg":"Project does not have access to this feature"}), so this
  //   render has no captions
  //
  // `providers/index.ts` says plainly that provider detail never reaches a job
  // record. Who failed and how are what make the note honest; their JSON is
  // ours to read in a log.
  const raw = 'deepgram 401: {"err_code":"INVALID_AUTH","err_msg":"Project does not have access to this feature","request_id":"abc-123"}';
  const failing = {
    transcriber: { name: "stub", transcribe: async () => { throw new Error(raw); } },
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
  const note = out.notes.join(" ");

  check("the note still says who failed", /deepgram/.test(note), note);
  check("and with what", /401/.test(note), note);
  check("and what it cost the render", /no captions/.test(note), note);
  check("but not their error code", !/INVALID_AUTH/.test(note), note);
  check("nor their prose", !/does not have access/.test(note), note);
  check("nor a request id that identifies our account to whoever reads it", !/abc-123/.test(note), note);
  check("nor any of their JSON at all", !/[{}]/.test(note), note);

  // A message that is not shaped like a provider status used to be pasted in
  // verbatim, on the reasoning that truncating everything to nothing would be
  // its own kind of unhelpful. That reasoning was right and the implementation
  // was not: "no response within 300s" is worth saying, and
  // `[in#0 @ 0x55bd6a269f00] Error opening input: No such file or directory`
  // is a log line that a paying customer was being shown, memory address
  // included. A deadline is now recognised and *said*, in both languages,
  // rather than passed through; everything else unshaped stays out.
  const plain = {
    transcriber: { name: "stub", transcribe: async () => { throw new Error("no response within 300s"); } },
    sceneReader: null,
    status: { transcription: null, vision: null },
  };
  const timedOut = await enrich.enrichPlan("unused.mp4", plan, { providers: plain });
  check(
    "a timeout is still said, because it says something",
    /did not answer in time/.test(timedOut.notes.join(" ")),
    JSON.stringify(timedOut.notes),
  );
  check(
    "in the product's own words rather than the library's",
    !/within 300s|ETIMEDOUT|AbortError/.test(timedOut.notes.join(" ")),
    JSON.stringify(timedOut.notes),
  );
  const timedOutAr = await enrich.enrichPlan("unused.mp4", plan, { providers: plain, language: "ar" });
  check(
    "and in Arabic when the render was asked for in Arabic",
    /لم يُجب في الوقت المتاح/.test(timedOutAr.notes.join(" ")),
    JSON.stringify(timedOutAr.notes),
  );
}

console.log("\nEvery request to somebody else's server has a deadline");
{
  const deadline = await import(bundle("artifacts/worker/src/providers/deadline.ts", "deadline.mjs"));

  check("there is a limit at all", Number.isFinite(deadline.PROVIDER_TIMEOUT_MS) && deadline.PROVIDER_TIMEOUT_MS > 0, String(deadline.PROVIDER_TIMEOUT_MS));
  check(
    "long enough for a real upload on a bad link",
    deadline.PROVIDER_TIMEOUT_MS >= 60_000,
    String(deadline.PROVIDER_TIMEOUT_MS),
  );

  // Node's fetch has no default timeout, so a socket that is accepted and never
  // answered waits forever — inside processJob. The job stays running, the
  // worker never returns to its loop, and one silent socket takes a whole
  // render machine out of service until the stale-lock sweeper requeues the job
  // and it all happens again.
  const hangs = () => new Promise(() => {});
  const wrapped = deadline.withDeadline(hangs, 150);
  const started = Date.now();
  let message = null;
  try {
    await wrapped("https://example.invalid/x");
  } catch (error) {
    message = error.message;
  }
  check("a request nobody answers is abandoned rather than awaited forever", message !== null, "it resolved");
  check("promptly", Date.now() - started < 3000, `${Date.now() - started}ms`);
  check(
    "and says what timed out rather than raising a bare TimeoutError",
    /no response within/.test(message ?? ""),
    message,
  );

  // The caller's own signal still wins, so cancelling a job stays instant
  // rather than waiting out the deadline.
  const controller = new AbortController();
  const slow = (_input, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted by caller")));
    });
  const cancellable = deadline.withDeadline(slow, 60_000);
  const inFlight = cancellable("https://example.invalid/x", { signal: controller.signal });
  controller.abort();
  let cancelled = null;
  try {
    await inFlight;
  } catch (error) {
    cancelled = error.message;
  }
  check("a caller that cancels does not wait out the deadline", cancelled !== null, "it did not reject");

  // And it is applied where it has to be: at the one place each provider's
  // traffic goes through, so a new call site cannot forget it.
  const { readFileSync } = await import("node:fs");
  for (const name of ["deepgram", "elevenlabs", "gemini"]) {
    const src = readFileSync(`artifacts/worker/src/providers/${name}.ts`, "utf8");
    check(
      `${name} sends every request through it`,
      /const doFetch = withDeadline\(options\.fetchImpl \?\? fetch\)/.test(src),
      "doFetch is not wrapped",
    );
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
