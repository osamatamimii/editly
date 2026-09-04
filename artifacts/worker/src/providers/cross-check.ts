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

        // Two readings of *different languages* are not two opinions on the
        // same words, and merging them word by word produces a hybrid that
        // belongs to neither. This was reachable: Deepgram used to be asked
        // for English whatever the audio, while ElevenLabs detects — so on an
        // Arabic clip the two came back in different languages and the merge
        // called it "the models disagreed on a word". They did not disagree;
        // they were listening for different things.
        //
        // Detection is on now, so this should not happen. The guard stays
        // because "should not happen" is exactly the condition worth failing
        // loudly on, and because a detector can be wrong about a quiet clip.
        const heard = first.value.language;
        const alsoHeard = second.value.language;
        if (heard && alsoHeard && baseLanguage(heard) !== baseLanguage(alsoHeard)) {
          // Whose reading to keep is not always the primary's. A disagreement
          // where one model *cannot detect* what the other heard is not two
          // opinions — the blind model guessed a language it was never able to
          // name. On an Arabic clip uploaded through an English UI, Deepgram
          // (which cannot detect Arabic) comes back with a confident wrong
          // language and words to match, while the model that heard Arabic was
          // right. So the reader whose language the other cannot name wins.
          const primaryCanNameSecondary = primary.canDetectLanguage?.(alsoHeard) ?? true;
          const secondaryCanNamePrimary = secondary.canDetectLanguage?.(heard) ?? true;
          const trustSecondary = !primaryCanNameSecondary && secondaryCanNamePrimary;
          const winner = trustSecondary ? second.value : first.value;
          const winnerName = trustSecondary ? secondary.name : primary.name;
          const blindName = trustSecondary ? primary.name : secondary.name;
          const blindTo = trustSecondary ? alsoHeard : heard;
          return withNotes(winner, [
            trustSecondary || (!secondaryCanNamePrimary && primaryCanNameSecondary)
              ? `the two speech models heard different languages (${heard} and ${alsoHeard}); ${blindName} cannot detect ${blindTo}, so the words are as ${winnerName} heard them`
              : `the two speech models heard different languages (${heard} and ${alsoHeard}), so the words are as ${winnerName} heard them rather than a mixture of the two`,
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

/**
 * "ar-EG" and "ar" are the same language for this purpose.
 *
 * Comparing the full tags would refuse to merge two correct readings of the
 * same Arabic just because one detector named the dialect and the other did
 * not — which would turn a guard against a real failure into a guard against
 * working normally.
 */
function baseLanguage(tag: string): string {
  return tag.toLowerCase().split(/[-_]/)[0];
}

function short(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 120 ? `${message.slice(0, 117)}…` : message;
}
