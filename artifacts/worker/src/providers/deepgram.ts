/**
 * Hearing the words, with the timing.
 *
 * Deepgram Nova-3 for the reason in the cost model: it is the most accurate
 * option we priced (5.26% WER) and transcription is 58% of what a minute costs
 * us, so accuracy here is not a detail — a mistimed word boundary is a cut in
 * the middle of a syllable, and every viewer hears that.
 *
 * Two decisions worth stating.
 *
 * We upload audio, not video. ffmpeg pulls a 16 kHz mono FLAC first, which is
 * what speech recognition actually consumes and is roughly two orders of
 * magnitude smaller than the source. On a two-hour podcast that is the
 * difference between a 7 GB upload and 70 MB, and it costs us one cheap local
 * pass. FLAC rather than Opus because it is lossless: we are about to make cut
 * decisions from these timings.
 *
 * We ask for filler words explicitly. Most transcripts drop "um" silently,
 * which is convenient for reading and useless to us — removing them is a
 * feature we want, and we cannot remove what we were never told about.
 */
import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Transcriber, Transcript, TranscribeOptions, TranscriptSegment, TranscriptWord } from "./types";
import { withDeadline } from "./deadline";
import { isFiller } from "./fillers";

const ENDPOINT = "https://api.deepgram.com/v1/listen";
const DEFAULT_MODEL = "nova-3";

/**
 * The languages Deepgram's detector can actually name.
 *
 * Thirty-five entries on the language-detection page, checked 29 Aug 2026 —
 * thirty-three here because two of them are regional variants of a base that
 * is already listed, and the comparison is on the base. **Arabic is not among
 * them.** This list is not decoration: it is the
 * difference between asking the detector a question it can answer and asking
 * it one it cannot, and the answer to the second kind is not an error. It is a
 * confident wrong language.
 *
 * Nova-3 transcribes Arabic well when it is *told* the language — `ar` and
 * sixteen regional variants are in its supported set. Detection and support
 * are two different lists, and reading only the second is how the previous
 * round left Arabic exactly as unheard as it found it while believing it
 * fixed.
 */
const DETECTABLE = new Set([
  "bg", "ca", "cs", "da", "de", "el", "en", "es", "et", "fi", "fr", "hi", "hu",
  "id", "it", "ja", "ko", "lt", "lv", "ms", "nl", "no", "pl", "pt", "ro", "ru",
  "sk", "sv", "th", "tr", "uk", "vi", "zh",
]);

/** `ar-EG` and `ar` are the same question here. */
const baseOf = (tag: string): string => tag.toLowerCase().split(/[-_]/)[0];

export interface DeepgramOptions {
  apiKey: string;
  model?: string;
  /** Injected in tests so the parsing can be checked without a key or a network. */
  fetchImpl?: typeof fetch;
}

export function createDeepgramTranscriber(options: DeepgramOptions): Transcriber {
  const model = options.model ?? DEFAULT_MODEL;
  const doFetch = withDeadline(options.fetchImpl ?? fetch);

  return {
    name: `deepgram/${model}`,

    async transcribe(mediaPath: string, opts: TranscribeOptions = {}): Promise<Transcript> {
      const audio = await extractSpeechAudio(mediaPath);
      try {
        // What language to transcribe as, in three steps.
        //
        // A stated language wins outright. Otherwise, if we have reason to
        // believe a language the detector cannot name — Arabic being the one
        // that matters here — believing it is strictly better than asking a
        // question with no right answer available. Only when detection can
        // actually reach the language do we let it decide, because a detector
        // that works beats an assumption every time.
        const stated = opts.language;
        const believed = opts.expected;
        const named = stated ?? (believed && !DETECTABLE.has(baseOf(believed)) ? believed : undefined);

        const query = new URLSearchParams({
          model,
          smart_format: "true",
          punctuate: "true",
          paragraphs: "true",
        });
        // Filler words are documented as an English-only feature. Asking a
        // provider for something it has said it does not do on this language
        // is at best noise in the request and at worst a rejected one — and
        // this path had never run against the live API when it was written.
        // When we are detecting, English is still on the table, so the ask
        // stands.
        if (!named || baseOf(named) === "en") query.set("filler_words", "true");
        // Deepgram's `language` **defaults to `en`** — it does not detect.
        // Nothing here ever set it, so every render was transcribed as
        // English, and an Arabic video came back as confident English-shaped
        // nonsense: not an error, not empty, just wrong. And the transcript is
        // not only the captions — it places the punches, picks the highlight
        // window, chooses the clips and titles them — so the whole edit was
        // being decided from a misreading.
        //
        // `language=multi` is not the fix: its ten languages do not include
        // Arabic. Detection was the fix for every language it can name, and
        // this file already read `detected_language` off the response — a
        // field that is only populated when detection is asked for, which it
        // never was.
        //
        // But detection has a list too, and **Arabic is not on it**. Turning
        // it on moved Arabic from "always heard as English" to "always heard
        // as one of thirty-five other languages", which is the same failure
        // wearing a better hat. Deepgram transcribes Arabic; it just cannot
        // guess it. So it has to be told — see DETECTABLE above.
        //
        // A named language still wins: someone who says which language it is
        // knows better than a detector, and that is the whole reason the plan
        // can carry one.
        if (named) query.set("language", named);
        else query.set("detect_language", "true");
        if (opts.diarize) query.set("diarize", "true");

        const response = await doFetch(`${ENDPOINT}?${query.toString()}`, {
          method: "POST",
          headers: {
            // Deepgram's scheme is "Token", not "Bearer".
            Authorization: `Token ${options.apiKey}`,
            "Content-Type": "audio/flac",
          },
          body: await readFile(audio),
          signal: opts.signal,
        });

        if (!response.ok) {
          throw new Error(`deepgram ${response.status}: ${await safeBody(response)}`);
        }
        return parseDeepgram(await response.json(), `deepgram/${model}`);
      } finally {
        await rm(path.dirname(audio), { recursive: true, force: true });
      }
    },
  };
}

/**
 * The response shape, spelled out so a change at their end fails loudly here
 * rather than producing an empty transcript that reads as "this video has no
 * speech in it".
 */
export function parseDeepgram(payload: unknown, source: string): Transcript {
  const root = payload as {
    results?: {
      channels?: Array<{
        detected_language?: string;
        alternatives?: Array<{
          words?: Array<{
            word?: string;
            punctuated_word?: string;
            start?: number;
            end?: number;
            confidence?: number;
            speaker?: number;
          }>;
          paragraphs?: {
            paragraphs?: Array<{ sentences?: Array<{ start?: number; end?: number }> }>;
          };
        }>;
      }>;
    };
  };

  const channel = root.results?.channels?.[0];
  const alternative = channel?.alternatives?.[0];
  if (!alternative) {
    throw new Error("deepgram returned no alternatives. The request shape is wrong, not the audio");
  }

  const words: TranscriptWord[] = (alternative.words ?? []).map((w) => {
    const text = w.punctuated_word ?? w.word ?? "";
    return {
      text,
      startMs: Math.round((w.start ?? 0) * 1000),
      endMs: Math.round((w.end ?? 0) * 1000),
      confidence: typeof w.confidence === "number" ? w.confidence : 1,
      filler: isFiller(text),
    };
  });

  const speakerOf = new Map<number, number>();
  (alternative.words ?? []).forEach((w, i) => {
    if (typeof w.speaker === "number") speakerOf.set(i, w.speaker);
  });

  // Sentence boundaries come from Deepgram's own paragraph model, which knows
  // about punctuation and pauses together. Falling back to one segment per
  // long gap is worse but never wrong.
  const boundaries = (alternative.paragraphs?.paragraphs ?? [])
    .flatMap((p) => p.sentences ?? [])
    .map((s) => ({ startMs: Math.round((s.start ?? 0) * 1000), endMs: Math.round((s.end ?? 0) * 1000) }))
    .filter((s) => s.endMs > s.startMs);

  const segments =
    boundaries.length > 0 ? groupByBoundaries(words, boundaries, speakerOf) : groupByGaps(words, speakerOf);

  return {
    segments,
    language: channel?.detected_language ?? null,
    source,
  };
}

function groupByBoundaries(
  words: TranscriptWord[],
  boundaries: Array<{ startMs: number; endMs: number }>,
  speakerOf: Map<number, number>,
): TranscriptSegment[] {
  return boundaries
    .map((b) => {
      const indices: number[] = [];
      words.forEach((w, i) => {
        // Midpoint membership, so a word straddling a boundary lands in exactly
        // one sentence instead of both or neither.
        const mid = (w.startMs + w.endMs) / 2;
        if (mid >= b.startMs && mid <= b.endMs) indices.push(i);
      });
      const inside = indices.map((i) => words[i]);
      return {
        startMs: inside[0]?.startMs ?? b.startMs,
        endMs: inside[inside.length - 1]?.endMs ?? b.endMs,
        text: inside.map((w) => w.text).join(" ").trim(),
        words: inside,
        speaker: speakerOf.get(indices[0] ?? -1),
      };
    })
    .filter((s) => s.words.length > 0);
}

/** A pause this long between words is a sentence break by any reasonable ear. */
const SEGMENT_GAP_MS = 700;

function groupByGaps(words: TranscriptWord[], speakerOf: Map<number, number>): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  let current: TranscriptWord[] = [];
  let firstIndex = 0;

  const flush = () => {
    if (current.length === 0) return;
    segments.push({
      startMs: current[0].startMs,
      endMs: current[current.length - 1].endMs,
      text: current.map((w) => w.text).join(" ").trim(),
      words: current,
      speaker: speakerOf.get(firstIndex),
    });
    current = [];
  };

  words.forEach((word, i) => {
    const previous = current[current.length - 1];
    const speakerChanged =
      previous !== undefined && speakerOf.get(i) !== undefined && speakerOf.get(i) !== speakerOf.get(firstIndex);
    if (previous && (word.startMs - previous.endMs > SEGMENT_GAP_MS || speakerChanged)) flush();
    if (current.length === 0) firstIndex = i;
    current.push(word);
  });
  flush();

  return segments;
}

async function safeBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 300);
  } catch {
    return "<no body>";
  }
}

/**
 * 16 kHz mono FLAC — the format speech models are trained on, and small enough
 * that a long podcast is a normal upload rather than an event.
 */
export async function extractSpeechAudio(mediaPath: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "editly-asr-"));
  const out = path.join(dir, "speech.flac");

  await new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", [
      "-hide_banner", "-nostdin", "-loglevel", "error",
      "-i", mediaPath,
      "-vn",
      "-ac", "1",
      "-ar", "16000",
      "-c:a", "flac",
      "-y", out,
    ]);
    let err = "";
    child.stderr.on("data", (d) => {
      err += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`could not extract audio for transcription: ${err.slice(0, 300)}`));
    });
  });

  return out;
}
