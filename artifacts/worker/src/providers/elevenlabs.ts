/**
 * The second pair of ears.
 *
 * ElevenLabs Scribe is here for one number: 3.3% word error against Deepgram's
 * 5.26%. It is not a replacement — Deepgram stays the clock, because its word
 * boundaries are what every cut, punch and karaoke sweep is measured against —
 * it is a check. Two models that fail differently, compared word by word, turn
 * "the recogniser said so" into "both recognisers said so", which is a much
 * stronger claim and the only one worth burning onto someone's video.
 *
 * Like Deepgram, it is fed a 16 kHz mono FLAC rather than the source file: the
 * same cheap local pass serves both, and a two-hour podcast becomes a 70 MB
 * upload instead of a 7 GB one.
 *
 * Two shape details of their API worth naming, because both are easy to get
 * silently wrong. The word list interleaves real words with `spacing` entries
 * and `audio_event` entries — laughter, applause — and treating those as words
 * would burn "(laughter)" into a caption and shift every karaoke sweep after
 * it. And per-word certainty arrives as a log probability, not a probability;
 * reading it raw gives every word a confidence of about -0.1 and masks the
 * entire transcript as uncertain.
 */
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { extractSpeechAudio } from "./deepgram";
import type { Transcriber, Transcript, TranscribeOptions, TranscriptSegment, TranscriptWord } from "./types";
import { withDeadline } from "./deadline";
import { isFiller } from "./fillers";

const ENDPOINT = "https://api.elevenlabs.io/v1/speech-to-text";
const DEFAULT_MODEL = "scribe_v1";

/** Scribe does not flag these, so we do. */
/** A pause this long between words is a sentence break by any reasonable ear. */
const SEGMENT_GAP_MS = 700;

export interface ElevenLabsOptions {
  apiKey: string;
  model?: string;
  /** Injected in tests so the parsing can be checked without a key or a network. */
  fetchImpl?: typeof fetch;
}

export function createElevenLabsTranscriber(options: ElevenLabsOptions): Transcriber {
  const model = options.model ?? DEFAULT_MODEL;
  const doFetch = withDeadline(options.fetchImpl ?? fetch);

  return {
    name: `elevenlabs/${model}`,

    async transcribe(mediaPath: string, opts: TranscribeOptions = {}): Promise<Transcript> {
      const audio = await extractSpeechAudio(mediaPath);
      try {
        const form = new FormData();
        form.set("model_id", model);
        form.set("file", new Blob([await readFile(audio)], { type: "audio/flac" }), "speech.flac");
        // Word timings are the only reason a second opinion is usable at all:
        // without them there is nothing to align the two transcripts on.
        form.set("timestamps_granularity", "word");
        form.set("tag_audio_events", "false");
        // A stated language is obeyed. `opts.expected` — the language we
        // merely believe, from what the person wrote — is deliberately *not*
        // used here: Scribe detects Arabic on its own, and handing both models
        // the same assumption would turn the cross-check into two copies of
        // one guess. This is the provider that is allowed to disagree with us.
        if (opts.language) form.set("language_code", opts.language);
        if (opts.diarize) form.set("diarize", "true");

        const response = await doFetch(ENDPOINT, {
          method: "POST",
          headers: { "xi-api-key": options.apiKey },
          body: form,
          signal: opts.signal,
        });

        if (!response.ok) {
          throw new Error(`elevenlabs ${response.status}: ${await safeBody(response)}`);
        }
        return parseElevenLabs(await response.json(), `elevenlabs/${model}`);
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
export function parseElevenLabs(payload: unknown, source: string): Transcript {
  const root = payload as {
    language_code?: string;
    text?: string;
    words?: Array<{
      text?: string;
      start?: number;
      end?: number;
      type?: string;
      speaker_id?: string;
      logprob?: number;
    }>;
  };

  if (!Array.isArray(root.words)) {
    if (typeof root.text === "string") {
      throw new Error(
        "elevenlabs returned text without word timings — the request is missing timestamps_granularity",
      );
    }
    throw new Error("elevenlabs returned no words — the request shape is wrong, not the audio");
  }

  const words: TranscriptWord[] = [];
  const speakers: Array<string | undefined> = [];

  for (const raw of root.words) {
    // `spacing` entries carry the whitespace between words and `audio_event`
    // entries carry things like laughter. Neither is a word, and both would
    // shift every timing after them if treated as one.
    if (raw.type !== undefined && raw.type !== "word") continue;
    const text = (raw.text ?? "").trim();
    if (text.length === 0) continue;

    words.push({
      text,
      startMs: Math.round((raw.start ?? 0) * 1000),
      endMs: Math.round((raw.end ?? 0) * 1000),
      confidence: fromLogProb(raw.logprob),
      filler: isFiller(text),
    });
    speakers.push(raw.speaker_id);
  }

  return {
    segments: groupByGaps(words, speakers),
    language: root.language_code ?? null,
    source,
  };
}

/**
 * Scribe reports certainty as a natural log probability. `-0.02` is a word it
 * is sure of; taken at face value it reads as 2% confident and the caption
 * layer would draw the whole transcript as ellipses.
 */
function fromLogProb(logprob: number | undefined): number {
  if (typeof logprob !== "number" || !Number.isFinite(logprob)) return 1;
  return Math.min(1, Math.max(0, Math.exp(logprob)));
}

/**
 * Scribe has no paragraph model, so sentences come from the pauses.
 *
 * This is the weaker of the two segmentations, which is exactly why the merge
 * keeps the primary's: the point of this transcript is its words, not its
 * shape.
 */
function groupByGaps(words: TranscriptWord[], speakers: Array<string | undefined>): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  let current: TranscriptWord[] = [];
  let firstIndex = 0;

  const flush = () => {
    if (current.length === 0) return;
    const speaker = speakers[firstIndex];
    segments.push({
      startMs: current[0].startMs,
      endMs: current[current.length - 1].endMs,
      text: current.map((w) => w.text).join(" ").trim(),
      words: current,
      ...(speaker !== undefined ? { speaker: speakerNumber(speaker) } : {}),
    });
    current = [];
  };

  words.forEach((word, i) => {
    const previous = current[current.length - 1];
    const speakerChanged =
      previous !== undefined && speakers[i] !== undefined && speakers[i] !== speakers[firstIndex];
    if (previous && (word.startMs - previous.endMs > SEGMENT_GAP_MS || speakerChanged)) flush();
    if (current.length === 0) firstIndex = i;
    current.push(word);
  });
  flush();

  return segments;
}

/** Their speaker ids are strings like "speaker_0"; ours are numbers. */
function speakerNumber(id: string): number {
  const digits = id.match(/\d+/)?.[0];
  return digits ? Number(digits) : 0;
}

async function safeBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 300);
  } catch {
    return "<no body>";
  }
}
