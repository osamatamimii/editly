/**
 * Asking two models and reconciling the answers.
 *
 * This is a `Transcriber` like any other, which is the point: nothing
 * downstream needs to know whether one model was asked or two. `enrich` calls
 * `transcribe` and gets a transcript; whether that transcript was corroborated
 * shows up where it belongs, in the notes attached to it.
 *
 * The failure behaviour is the part worth reading. Two providers means two
 * chances to have a bad afternoon, and a cross-check that turns one outage
 * into a failed render would be worse than no cross-check at all. So both are
 * asked at once and the result is whatever we got: both, and we merge; one,
 * and we use it and say the check did not happen; neither, and only then does
 * the caller hear about a failure — with the primary's error, because that is
 * the one that describes the pipeline people are actually paying for.
 *
 * The audio is extracted once and handed to both. It is the same 16 kHz mono
 * FLAC either way, and pulling it twice from a two-hour source to send the
 * same bytes to two endpoints is a minute of CPU spent on nothing.
 */
import { rm } from "node:fs/promises";
import path from "node:path";
import { extractSpeechAudio } from "./deepgram";
import { mergeTranscripts } from "../transcript-merge";
import type { Transcriber, Transcript, TranscribeOptions } from "./types";

export interface CrossCheckOptions {
  /** The clock. Its word boundaries and sentence breaks are the ones that survive. */
  primary: Transcriber;
  /** The second opinion. Its wording wins where the two differ. */
  secondary: Transcriber;
  /** Injected in tests, where there is no ffmpeg and no media file. */
  prepareAudio?: (mediaPath: string) => Promise<string>;
}

export function createCrossCheckedTranscriber(options: CrossCheckOptions): Transcriber {
  const { primary, secondary } = options;
  const prepare = options.prepareAudio ?? extractSpeechAudio;

  return {
    name: `${primary.name}+${secondary.name}`,

    async transcribe(mediaPath: string, opts: TranscribeOptions = {}): Promise<Transcript> {
      const audio = await prepare(mediaPath);
      const shared = audio !== mediaPath;

      try {
        const [first, second] = await Promise.allSettled([
          primary.transcribe(audio, opts),
          secondary.transcribe(audio, opts),
        ]);

        if (first.status === "rejected" && second.status === "rejected") {
          throw first.reason;
        }

        if (second.status === "rejected") {
          return withNotes(first.status === "fulfilled" ? first.value : emptyOf(primary), [
            `the second speech model was unavailable (${short(second.reason)}), so the words are as ${primary.name} heard them and were not cross-checked`,
          ]);
        }

        if (first.status === "rejected") {
          return withNotes(second.value, [
            `the main speech model was unavailable (${short(first.reason)}), so both the words and the timings come from ${secondary.name} alone`,
          ]);
        }

        const merged = mergeTranscripts(first.value, second.value);
        return withNotes(merged.transcript, merged.notes);
      } finally {
        if (shared) await rm(path.dirname(audio), { recursive: true, force: true });
      }
    },
  };
}

function withNotes(transcript: Transcript, notes: string[]): Transcript {
  if (notes.length === 0) return transcript;
  return { ...transcript, notes: [...(transcript.notes ?? []), ...notes] };
}

/** Unreachable in practice; here so the type does not need a non-null assertion. */
function emptyOf(transcriber: Transcriber): Transcript {
  return { segments: [], language: null, source: transcriber.name };
}

function short(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 120 ? `${message.slice(0, 117)}…` : message;
}
