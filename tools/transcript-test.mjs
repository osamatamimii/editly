/**
 * Two recognisers, checked against each other.
 *
 * The cross-check exists to stop a wrong word being burned onto someone's
 * video, so the thing that has to be tested is not "does it merge" but "does
 * it merge the way that makes the caption better": the accurate reader's word,
 * the timing authority's clock, and a confidence that reflects whether they
 * actually agreed.
 *
 * Nothing here touches a network or a key. The providers take an injected
 * `fetch`, the cross-check takes an injected audio step, and the merge is pure
 * — which is most of why it was written as its own module.
 *
 * Usage: node tools/transcript-test.mjs
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-transcript-build-"));

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

const { mergeTranscripts, normalise } = await import(
  bundle("artifacts/worker/src/transcript-merge.ts", "merge.mjs")
);
const { parseElevenLabs, createElevenLabsTranscriber } = await import(
  bundle("artifacts/worker/src/providers/elevenlabs.ts", "elevenlabs.mjs")
);
const { createCrossCheckedTranscriber } = await import(
  bundle("artifacts/worker/src/providers/cross-check.ts", "cross-check.mjs")
);
const { createDeepgramTranscriber } = await import(
  bundle("artifacts/worker/src/providers/deepgram.ts", "deepgram-provider.mjs")
);
const { resolveProviders, missingCapabilityNotes } = await import(
  bundle("artifacts/worker/src/providers/index.ts", "providers.mjs")
);
const { buildCaptionCues } = await import(bundle("artifacts/worker/src/captions.ts", "captions.mjs"));

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
const near = (a, b, tolerance = 0.001) => Math.abs(a - b) <= tolerance;
const section = (title) => console.log(`\n${title}`);

/** One segment of words at 500ms each, starting where you say. */
function speech(words, { from = 0, each = 500, confidence = 0.95, gapAfter = 0 } = {}) {
  let cursor = from;
  return words.map((text) => {
    const word = {
      text,
      startMs: cursor,
      endMs: cursor + each,
      confidence,
      filler: false,
    };
    cursor += each + gapAfter;
    return word;
  });
}

const asTranscript = (segments, source) => ({
  segments: segments.map((words) => ({
    startMs: words[0].startMs,
    endMs: words[words.length - 1].endMs,
    text: words.map((w) => w.text).join(" "),
    words,
  })),
  language: "en",
  source,
});

const flat = (transcript) => transcript.segments.flatMap((s) => s.words);
const textOf = (transcript) => flat(transcript).map((w) => w.text).join(" ");

// ─── Reading Scribe's answer ─────────────────────────────────────────────────

section("The second model's response is read for what it is");
{
  const parsed = parseElevenLabs(
    {
      language_code: "en",
      words: [
        { text: "Right", start: 0, end: 0.4, type: "word", logprob: -0.02, speaker_id: "speaker_0" },
        { text: " ", start: 0.4, end: 0.42, type: "spacing" },
        { text: "so", start: 0.42, end: 0.7, type: "word", logprob: -0.7 },
        { text: "(laughter)", start: 0.7, end: 1.4, type: "audio_event" },
        { text: "um", start: 1.4, end: 1.6, type: "word" },
      ],
    },
    "elevenlabs/scribe_v1",
  );
  const words = flat(parsed);
  check("spacing entries are not words", !words.some((w) => w.text.trim() === ""));
  check("audio events are not words", !words.some((w) => w.text.includes("laughter")));
  check("the real words survive", words.map((w) => w.text).join(" ") === "Right so um", textOf(parsed));
  check("times are milliseconds", words[0].endMs === 400);
  check(
    "a log probability becomes a probability",
    near(words[0].confidence, Math.exp(-0.02), 0.0001),
    `got ${words[0].confidence}`,
  );
  check("a less certain word scores lower", words[1].confidence < words[0].confidence);
  check("confidence never exceeds 1", words.every((w) => w.confidence <= 1));
  check("a missing log probability is not read as zero", words[2].confidence === 1);
  check("fillers are flagged, since Scribe does not flag them", words[2].filler === true);
  check("the language is carried", parsed.language === "en");
}

section("A response that cannot be used fails loudly instead of reading as silence");
{
  let saidWhat = "";
  try {
    parseElevenLabs({ text: "the whole thing as one string" }, "x");
  } catch (error) {
    saidWhat = error.message;
  }
  check("text without word timings is an error", saidWhat.length > 0);
  check("and the message names the actual cause", /timestamps_granularity/.test(saidWhat), saidWhat);

  let other = "";
  try {
    parseElevenLabs({}, "x");
  } catch (error) {
    other = error.message;
  }
  check("an unrecognisable shape is an error too", /request shape is wrong/.test(other), other);
}

section("Word timings are asked for — without them there is nothing to align on");
{
  let sentForm = null;
  const transcriber = createElevenLabsTranscriber({
    apiKey: "not-a-real-key",
    fetchImpl: async (_url, init) => {
      sentForm = init.body;
      return { ok: true, json: async () => ({ words: [] }) };
    },
  });
  check("the transcriber names itself by model", transcriber.name === "elevenlabs/scribe_v1");
  // The request itself needs ffmpeg and a media file; the point here is only
  // that the option is set on the form the provider builds.
  const source = createElevenLabsTranscriber.toString();
  check("word granularity is requested", /timestamps_granularity/.test(source));
  check("audio events are turned off at the source", /tag_audio_events/.test(source));
  check("the key travels in the header ElevenLabs expects", /xi-api-key/.test(source));
  check("and never in the query string", !/api_key=/.test(source));
  void sentForm;
}

// ─── The merge ───────────────────────────────────────────────────────────────

section("Where the two agree, the word is worth more than either said alone");
{
  const words = ["We", "shipped", "it", "on", "Friday"];
  const primary = asTranscript([speech(words, { confidence: 0.9 })], "deepgram/nova-3");
  const secondary = asTranscript([speech(words, { confidence: 0.9 })], "elevenlabs/scribe_v1");

  const { transcript, stats, notes } = mergeTranscripts(primary, secondary);
  const merged = flat(transcript);

  check("every word agreed", stats.agreed === 5 && stats.contested === 0, JSON.stringify(stats));
  check("the text is unchanged", textOf(transcript) === words.join(" "));
  check(
    "two readers at 0.9 are worth 0.99, not 0.9",
    near(merged[0].confidence, 0.99),
    `got ${merged[0].confidence}`,
  );
  check("nothing is reported when nothing was wrong", notes.length === 0, notes.join(" | "));
  check("the source names both", transcript.source === "deepgram/nova-3+elevenlabs/scribe_v1");
}

section("Where they differ, the accurate reader's word rides the timing authority's clock");
{
  const primary = asTranscript(
    [speech(["We", "shipped", "it", "on", "Friday"], { confidence: 0.9 })],
    "deepgram/nova-3",
  );
  const secondary = asTranscript(
    [speech(["We", "ship", "it", "on", "Friday"], { confidence: 0.88, each: 400 })],
    "elevenlabs/scribe_v1",
  );

  const { transcript, stats, notes } = mergeTranscripts(primary, secondary);
  const merged = flat(transcript);

  check("exactly one word was contested", stats.contested === 1, JSON.stringify(stats));
  check("the more accurate reading won", merged[1].text === "ship", merged[1].text);
  check("but the timing did not move", merged[1].startMs === 500 && merged[1].endMs === 1000);
  check("every other timing is the primary's", merged[4].startMs === 2000);
  check(
    "a contested word is trusted less than an agreed one",
    merged[1].confidence < merged[0].confidence,
    `${merged[1].confidence} vs ${merged[0].confidence}`,
  );
  check("but two confident readers disagreeing still shows a word", merged[1].confidence >= 0.4);
  check("and the disagreement is reported", notes.some((n) => /disagreed/.test(n)), notes.join(" | "));
}

section("Two unsure readers disagreeing is not a word, and is not guessed at");
{
  const primary = asTranscript([speech(["the", "Kubernetes", "thing"], { confidence: 0.45 })], "dg");
  const secondary = asTranscript([speech(["the", "coober", "thing"], { confidence: 0.4 })], "el");

  const { transcript } = mergeTranscripts(primary, secondary);
  const merged = flat(transcript);
  check("the contested word falls under the caption threshold", merged[1].confidence < 0.4, `${merged[1].confidence}`);

  const cues = buildCaptionCues(transcript);
  check("so the caption layer draws an ellipsis, not a guess", cues[0].text.includes("…"), cues[0].text);
  check("and the words either side are still there", /the/.test(cues[0].text) && /thing/.test(cues[0].text));
  check("the rhythm survives — the word still has its slot", cues[0].words.length === 3);
}

section("Formatting is not disagreement");
{
  const primary = asTranscript([speech(["Right,", "so", "don't"], { confidence: 0.9 })], "dg");
  const secondary = asTranscript([speech(["right", "So", "dont"], { confidence: 0.9 })], "el");

  const { transcript, stats } = mergeTranscripts(primary, secondary);
  check("case and punctuation do not count as a dispute", stats.contested === 0, JSON.stringify(stats));
  check("and the formatted spelling is the one kept", textOf(transcript) === "Right, so don't", textOf(transcript));
  check("normalise agrees", normalise("Don't,") === normalise("dont"));
}

section("A real disagreement keeps the punctuation around it");
{
  const primary = asTranscript([speech(["We", "shipped."], { confidence: 0.9 })], "dg");
  const secondary = asTranscript([speech(["We", "ship"], { confidence: 0.9 })], "el");
  const merged = flat(mergeTranscripts(primary, secondary).transcript);
  check("the new word, the old full stop", merged[1].text === "ship.", merged[1].text);
}

section("A word only one of them heard");
{
  const primary = asTranscript([speech(["we", "really", "shipped"], { confidence: 0.9 })], "dg");
  const secondary = asTranscript([speech(["we", "shipped"], { confidence: 0.9 })], "el");

  const { transcript, stats } = mergeTranscripts(primary, secondary);
  const merged = flat(transcript);
  check("it is kept, not deleted", merged.map((w) => w.text).join(" ") === "we really shipped", textOf(transcript));
  check("it is counted as uncorroborated", stats.primaryOnly === 1, JSON.stringify(stats));
  check(
    "and trusted a little less than the words both heard",
    merged[1].confidence < merged[0].confidence,
    `${merged[1].confidence} vs ${merged[0].confidence}`,
  );
}

section("A word only the second one heard is fitted into the gap, never over its neighbours");
{
  // The primary hears "we ... shipped" with a full second of silence between.
  const primary = asTranscript(
    [[
      { text: "we", startMs: 0, endMs: 400, confidence: 0.9, filler: false },
      { text: "shipped", startMs: 1400, endMs: 1800, confidence: 0.9, filler: false },
    ]],
    "dg",
  );
  const secondary = asTranscript(
    [[
      { text: "we", startMs: 0, endMs: 400, confidence: 0.9, filler: false },
      { text: "really", startMs: 500, endMs: 900, confidence: 0.8, filler: false },
      { text: "shipped", startMs: 1400, endMs: 1800, confidence: 0.9, filler: false },
    ]],
    "el",
  );

  const { transcript, stats } = mergeTranscripts(primary, secondary);
  const merged = flat(transcript);
  check("the extra word is picked up", merged.length === 3, textOf(transcript));
  check("in the right order", textOf(transcript) === "we really shipped");
  check("counted as heard by one", stats.secondaryOnly === 1 && stats.inserted === 1, JSON.stringify(stats));
  check("it starts after the word before it", merged[1].startMs >= merged[0].endMs, `${merged[1].startMs}`);
  check("and ends before the word after it", merged[1].endMs <= merged[2].startMs, `${merged[1].endMs}`);
  check("no two words overlap", merged.every((w, i) => i === 0 || w.startMs >= merged[i - 1].endMs));
}

section("A word with nowhere to go is dropped rather than drawn over another");
{
  const primary = asTranscript(
    [[
      { text: "we", startMs: 0, endMs: 400, confidence: 0.9, filler: false },
      { text: "shipped", startMs: 410, endMs: 800, confidence: 0.9, filler: false },
    ]],
    "dg",
  );
  const secondary = asTranscript(
    [[
      { text: "we", startMs: 0, endMs: 400, confidence: 0.9, filler: false },
      { text: "really", startMs: 400, endMs: 405, confidence: 0.8, filler: false },
      { text: "shipped", startMs: 410, endMs: 800, confidence: 0.9, filler: false },
    ]],
    "el",
  );
  const { transcript, stats } = mergeTranscripts(primary, secondary);
  const merged = flat(transcript);
  check("the word is not forced in", merged.length === 2, textOf(transcript));
  check("it was seen and rejected, not missed", stats.secondaryOnly === 1 && stats.inserted === 0, JSON.stringify(stats));
  check("the words that remain do not overlap", merged[1].startMs >= merged[0].endMs);
}

section("The primary's sentence boundaries survive the merge");
{
  const first = speech(["we", "shipped", "it"], { confidence: 0.9 });
  const second = speech(["on", "Friday"], { from: 3000, confidence: 0.9 });
  const primary = asTranscript([first, second], "dg");
  const secondary = asTranscript(
    [[...speech(["we", "ship", "it"], { confidence: 0.9 }), ...speech(["on", "Friday"], { from: 3000, confidence: 0.9 })]],
    "el",
  );

  const { transcript } = mergeTranscripts(primary, secondary);
  check("two segments in, two segments out", transcript.segments.length === 2, `${transcript.segments.length}`);
  check("the split is where the primary put it", transcript.segments[1].words[0].text === "on");
  check("segment text is rebuilt from the merged words", transcript.segments[0].text === "we ship it", transcript.segments[0].text);
  check(
    "segment bounds follow their words",
    transcript.segments[1].startMs === 3000 && transcript.segments[1].endMs === 4000,
  );
  check(
    "and the words carry no bookkeeping out with them",
    transcript.segments[0].words.every((w) => !("segment" in w)),
  );
}

section("An empty or unusable second opinion changes nothing");
{
  const primary = asTranscript([speech(["we", "shipped"], { confidence: 0.9 })], "dg");
  const { transcript, notes } = mergeTranscripts(primary, { segments: [], language: null, source: "el" });
  check("the primary comes back untouched", textOf(transcript) === "we shipped");
  check("confidence is not inflated by an absent second reader", flat(transcript)[0].confidence === 0.9);
  check("and it says the check did not happen", notes.some((n) => /not cross-checked/.test(n)), notes.join(" | "));
}

section("Alignment is only broken where both models heard silence");
{
  // 40 words, one long pause in the middle that both hear.
  const before = speech(Array.from({ length: 20 }, (_, i) => `a${i}`), { confidence: 0.9 });
  const after = speech(Array.from({ length: 20 }, (_, i) => `b${i}`), { from: 12000, confidence: 0.9 });
  const primary = asTranscript([[...before, ...after]], "dg");
  const secondary = asTranscript([[...before, ...after]], "el");
  const { stats } = mergeTranscripts(primary, secondary);
  check("splitting does not lose or duplicate words", stats.agreed === 40, JSON.stringify(stats));

  // A pause only the primary hears must not become a split, or the same word
  // lands on opposite sides in the two streams and reads as a disagreement.
  const straddle = asTranscript(
    [[
      { text: "one", startMs: 0, endMs: 400, confidence: 0.9, filler: false },
      { text: "two", startMs: 1400, endMs: 1800, confidence: 0.9, filler: false },
    ]],
    "dg",
  );
  const continuous = asTranscript(
    [[
      { text: "one", startMs: 0, endMs: 900, confidence: 0.9, filler: false },
      { text: "two", startMs: 901, endMs: 1800, confidence: 0.9, filler: false },
    ]],
    "el",
  );
  const { stats: s2 } = mergeTranscripts(straddle, continuous);
  check("a word straddling the would-be split is still matched", s2.agreed === 2, JSON.stringify(s2));
}

section("An unbroken stretch too long to compare is passed through and declared");
{
  const many = Array.from({ length: 401 }, (_, i) => `w${i}`);
  const primary = asTranscript([speech(many, { each: 100, confidence: 0.9 })], "dg");
  const secondary = asTranscript([speech(many, { each: 100, confidence: 0.9 })], "el");
  const { transcript, stats, notes } = mergeTranscripts(primary, secondary);
  check("nothing is lost", flat(transcript).length === 401, `${flat(transcript).length}`);
  check("it is counted as unchecked, not as agreement", stats.unchecked === 401 && stats.agreed === 0, JSON.stringify(stats));
  check("confidence is not inflated for words nobody compared", flat(transcript)[0].confidence === 0.9);
  check("and the render notes admit it", notes.some((n) => /too long to cross-check/.test(n)), notes.join(" | "));
}

// ─── Two providers means two chances to have a bad afternoon ─────────────────

const fakeTranscriber = (name, result) => ({
  name,
  transcribe: async () => {
    if (result instanceof Error) throw result;
    return result;
  },
});

const words5 = ["we", "shipped", "it", "on", "Friday"];
const dgResult = asTranscript([speech(words5, { confidence: 0.9 })], "deepgram/nova-3");
const elResult = asTranscript([speech(words5, { confidence: 0.9 })], "elevenlabs/scribe_v1");
const passthroughAudio = async (p) => p;

section("Both answer");
{
  const t = createCrossCheckedTranscriber({
    primary: fakeTranscriber("deepgram/nova-3", dgResult),
    secondary: fakeTranscriber("elevenlabs/scribe_v1", elResult),
    prepareAudio: passthroughAudio,
  });
  check("the pair names both", t.name === "deepgram/nova-3+elevenlabs/scribe_v1");
  const out = await t.transcribe("/tmp/whatever.mp4");
  check("the result is merged", out.source === "deepgram/nova-3+elevenlabs/scribe_v1");
  check("and corroborated", near(flat(out)[0].confidence, 0.99));
  check("with nothing to complain about", (out.notes ?? []).length === 0);
}

/**
 * Which language the audio is transcribed as.
 *
 * Deepgram's `language` parameter **defaults to `en`**. It does not detect. So
 * for as long as nothing set it, every render was transcribed as English —
 * and an Arabic video came back not as an error and not as silence but as
 * confident English-shaped nonsense. The transcript is not only the captions:
 * it places the punch-ins, picks the highlight window, chooses the clips and
 * writes their titles. The whole edit was being decided from a misreading.
 *
 * The URL is asserted rather than the transcript, because the transcript is
 * exactly what cannot show this: a wrong-language reading has words, timings
 * and confidences, and looks from every angle like a right one.
 */
section("The audio decides which language it is in");
{
  const urls = [];
  const deepgram = (opts) =>
    createDeepgramTranscriber({
      apiKey: "not-a-real-key",
      model: "nova-3",
      fetchImpl: async (url) => {
        urls.push(String(url));
        return {
          ok: true,
          json: async () => ({
            results: { channels: [{ detected_language: "ar", alternatives: [{ words: [] }] }] },
          }),
        };
      },
      prepareAudio: async (p) => p,
      ...opts,
    });

  check("the provider is built and names its model", deepgram({}).name === "deepgram/nova-3");

  // The request itself needs ffmpeg; what is under test is the query the
  // provider builds, which the source states outright.
  const source = createDeepgramTranscriber.toString();
  check(
    "detection is asked for when nobody named a language",
    /detect_language/.test(source),
    "the parameter is never sent, so Deepgram falls back to English",
  );
  check(
    "and a named language is sent instead of detection, not alongside it",
    /if \(opts\.language\)[\s\S]{0,80}else[\s\S]{0,80}detect_language/.test(source),
    source.slice(source.indexOf("opts.language"), source.indexOf("opts.language") + 200),
  );
  check(
    "language=multi is not used, because its ten languages do not include Arabic",
    !/"multi"|'multi'/.test(source),
  );
}

/**
 * Two models that heard different languages did not disagree about a word.
 *
 * This was reachable, and it is the second half of the same bug: Deepgram was
 * asked for English whatever the audio while ElevenLabs detects, so an Arabic
 * clip produced two transcripts in two languages — and the merge reconciled
 * them word by word and reported "the two speech models disagreed on N words",
 * which is a true sentence about a meaningless comparison.
 */
section("Two models that heard different languages are not two opinions");
{
  const arabic = { ...asTranscript([speech(words5, { confidence: 0.9 })], "elevenlabs/scribe_v1"), language: "ar" };
  const english = { ...asTranscript([speech(words5, { confidence: 0.9 })], "deepgram/nova-3"), language: "en" };

  const t = createCrossCheckedTranscriber({
    primary: fakeTranscriber("deepgram/nova-3", english),
    secondary: fakeTranscriber("elevenlabs/scribe_v1", arabic),
    prepareAudio: passthroughAudio,
  });
  const out = await t.transcribe("/tmp/whatever.mp4");

  check("the merge is refused", out.source === "deepgram/nova-3", out.source);
  check(
    "and the reason names both languages",
    (out.notes ?? []).some((n) => /different languages/.test(n) && /en/.test(n) && /ar/.test(n)),
    JSON.stringify(out.notes),
  );
  check(
    "the words are the primary's, not a mixture",
    flat(out).length === flat(english).length,
    `${flat(out).length} vs ${flat(english).length}`,
  );

  // A dialect tag is the same language. Refusing to merge "ar-EG" against
  // "ar" would turn a guard against a real failure into a guard against
  // working normally.
  const dialect = { ...arabic, language: "ar-EG" };
  const same = createCrossCheckedTranscriber({
    primary: fakeTranscriber("deepgram/nova-3", { ...english, language: "ar" }),
    secondary: fakeTranscriber("elevenlabs/scribe_v1", dialect),
    prepareAudio: passthroughAudio,
  });
  const merged = await same.transcribe("/tmp/whatever.mp4");
  check(
    "but ar-EG and ar still merge",
    merged.source === "deepgram/nova-3+elevenlabs/scribe_v1",
    merged.source,
  );

  // And an unknown language on either side is not evidence of a mismatch.
  const unknown = createCrossCheckedTranscriber({
    primary: fakeTranscriber("deepgram/nova-3", { ...english, language: null }),
    secondary: fakeTranscriber("elevenlabs/scribe_v1", arabic),
    prepareAudio: passthroughAudio,
  });
  const stillMerged = await unknown.transcribe("/tmp/whatever.mp4");
  check(
    "and a transcript that names no language is not treated as a clash",
    stillMerged.source === "deepgram/nova-3+elevenlabs/scribe_v1",
    stillMerged.source,
  );
}

section("The second model is down");
{
  const t = createCrossCheckedTranscriber({
    primary: fakeTranscriber("deepgram/nova-3", dgResult),
    secondary: fakeTranscriber("elevenlabs/scribe_v1", new Error("503 upstream")),
    prepareAudio: passthroughAudio,
  });
  const out = await t.transcribe("/tmp/whatever.mp4");
  check("the render still gets words", flat(out).length === 5);
  check("they are the primary's", out.source === "deepgram/nova-3");
  check("confidence is not inflated", flat(out)[0].confidence === 0.9);
  check("and the user is told the check did not happen", (out.notes ?? []).some((n) => /not cross-checked/.test(n)), JSON.stringify(out.notes));
  check("the error is quoted, not swallowed", (out.notes ?? []).some((n) => /503 upstream/.test(n)));
}

section("The main model is down");
{
  const t = createCrossCheckedTranscriber({
    primary: fakeTranscriber("deepgram/nova-3", new Error("402 out of credit")),
    secondary: fakeTranscriber("elevenlabs/scribe_v1", elResult),
    prepareAudio: passthroughAudio,
  });
  const out = await t.transcribe("/tmp/whatever.mp4");
  check("the second model carries the render", flat(out).length === 5);
  check("and the note says the timings are its own", (out.notes ?? []).some((n) => /timings come from/.test(n)), JSON.stringify(out.notes));
}

section("Both are down");
{
  const t = createCrossCheckedTranscriber({
    primary: fakeTranscriber("deepgram/nova-3", new Error("402 out of credit")),
    secondary: fakeTranscriber("elevenlabs/scribe_v1", new Error("503 upstream")),
    prepareAudio: passthroughAudio,
  });
  let thrown = null;
  try {
    await t.transcribe("/tmp/whatever.mp4");
  } catch (error) {
    thrown = error;
  }
  check("it fails", thrown !== null);
  check("with the primary's reason, which is the pipeline people paid for", /402/.test(thrown?.message ?? ""));
}

// ─── What the keys actually switch on ────────────────────────────────────────

section("Which models are configured decides which pipeline runs");
{
  const both = resolveProviders({ DEEPGRAM_API_KEY: "a", ELEVENLABS_API_KEY: "b" });
  check("two keys give a cross-checked reader", both.transcriber?.name === "deepgram/nova-3+elevenlabs/scribe_v1", both.transcriber?.name);
  check("and nothing is reported missing", both.status.transcription === null && both.status.crossCheck === null);

  const dgOnly = resolveProviders({ DEEPGRAM_API_KEY: "a" });
  check("one key still transcribes", dgOnly.transcriber?.name === "deepgram/nova-3");
  // The statuses carry both languages now — they are built once at start-up,
  // before any job knows which one it was asked in — so the English half is
  // what these read. bilingual-test guards the other one.
  check(
    "but says the words rest on a single reading",
    /single reading/.test(dgOnly.status.crossCheck?.en ?? ""),
    JSON.stringify(dgOnly.status.crossCheck ?? ""),
  );
  check(
    "and that reaches the render notes",
    missingCapabilityNotes(dgOnly.status, { transcript: true, vision: false }).some((n) => /single reading/.test(n)),
  );
  check(
    "only when the render needed words at all",
    missingCapabilityNotes(dgOnly.status, { transcript: false, vision: false }).length === 0,
  );

  const elOnly = resolveProviders({ ELEVENLABS_API_KEY: "b" });
  check("the accurate reader alone is better than nothing", elOnly.transcriber?.name === "elevenlabs/scribe_v1");
  check("and it too is declared as a single reading", /single reading/.test(elOnly.status.crossCheck?.en ?? ""));

  const none = resolveProviders({});
  check("no keys, no transcriber", none.transcriber === null);
  check("and the reason is the missing recogniser, not the missing check", none.status.crossCheck === null && none.status.transcription !== null);

  // Distinctive values, so "did the key leak" is a question the test can
  // actually answer rather than a string that happens to appear in prose.
  const SECRETS = ["dg-secret-4f1c", "el-secret-9a2b"];
  const resolved = resolveProviders({ DEEPGRAM_API_KEY: SECRETS[0], ELEVENLABS_API_KEY: SECRETS[1] });
  const exposed = JSON.stringify({
    transcriber: { name: resolved.transcriber?.name, own: Object.keys(resolved.transcriber ?? {}) },
    status: resolved.status,
  });
  check("no key is carried back out of the resolver", SECRETS.every((s) => !exposed.includes(s)), exposed);
  check("nor is one reachable as a property", SECRETS.every((s) => !Object.values(resolved.transcriber ?? {}).includes(s)));
}

await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
