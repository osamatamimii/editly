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
import { sayIn } from "../say";

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
      /*
        The notes below are read by a person, in their chat, so they are
        written in their language.

        They were English literals. An Arabic customer's summary read Arabic,
        then a sentence about a speech model in English, then Arabic again.
        `say.ts` makes both halves required arguments exactly so this cannot
        happen; a plain string is the seam that rule cannot reach across, and
        this is that seam.
      */
      const t = sayIn(opts.notesIn);
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
          const why = whyUnavailable(second.reason);
          return withNotes(first.status === "fulfilled" ? first.value : emptyOf(primary), [
            t(
              `a second reading was not available${why.en}, so the words come from a single pass and were not cross-checked`,
              `تعذّرت القراءة الثانية${why.ar}، فالكلمات من قراءة واحدة بلا مقابلة`,
            ),
          ]);
        }

        if (first.status === "rejected") {
          const why = whyUnavailable(first.reason);
          return withNotes(second.value, [
            t(
              `the first reading was not available${why.en}, so both the words and the timings come from a single pass`,
              `تعذّرت القراءة الأولى${why.ar}، فالكلمات والتوقيتات كلّها من قراءة واحدة`,
            ),
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
          /*
            Whose reading to keep is not always the primary's.

            A disagreement where one model *cannot detect* what the other heard
            is not two opinions — the blind model guessed a language it was
            never able to name. On an Arabic clip uploaded through an English
            interface, Deepgram (which cannot detect Arabic) comes back with a
            confident wrong language and words to match, while the model that
            heard Arabic was right. So the reader whose language the other
            cannot name wins.
          */
          const primaryCanNameSecondary = primary.canDetectLanguage?.(alsoHeard) ?? true;
          const secondaryCanNamePrimary = secondary.canDetectLanguage?.(heard) ?? true;
          const trustSecondary = !primaryCanNameSecondary && secondaryCanNamePrimary;
          const winner = trustSecondary ? second.value : first.value;
          /*
            Which model won, which is blind to what, and the two language codes
            all still decide `winner` above. None of them is in the note any
            more, so none of them is named here either: a binding that exists
            only to be interpolated into a sentence outlives the sentence and
            is the reason the next one gets written with it.
          */
          return withNotes(winner, [
            /*
              What the customer needs from this, and nothing else.

              It read: "the two speech models heard different languages (en and
              eng); deepgram/nova-3 cannot detect eng, so the words are as
              elevenlabs/scribe_v1 heard them". Osama read that in the product
              and said so. He is right: every proper noun in it is our
              plumbing. The person did not choose these services, cannot act on
              which one won, and is being asked to hold two of their names in
              their head to finish the sentence.

              What is theirs is the fact: the reading was checked twice, the
              two disagreed about which language this is, and one was picked
              rather than the two mixed together. The names, the codes and
              which model is blind to what go to the log, where the person who
              can act on them is already looking.
            */
            t(
              "I read the speech twice to check it, and the two readings disagreed about which language this is. I kept the one that matched the recording rather than mixing them",
              "قرأت الكلام مرّتين للتأكد، واختلفت القراءتان على لغة التسجيل. أبقيت القراءة التي طابقت الصوت بدل أن أمزج بينهما",
            ),
          ]);
        }

        const merged = mergeTranscripts(first.value, second.value, opts.notesIn);
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

/**
 * Why a reading did not come back, shaped for a customer note — bilingual,
 * because these sentences land word for word in the person's chat.
 *
 * The one fact a person can act on is the *kind* of failure — was the
 * service overloaded, so try later, or something else — and nothing more.
 * The raw error a rejected provider carries is ours to read in a log: a
 * memory address, a stack frame, a request id or a line of the provider's
 * own prose in a chat bubble tells the customer nothing and hands them our
 * internals — and the old note also named the third-party services we run
 * on. So only the status code is read out of the error, and only when it is
 * one a person can do something about; the matched text is never echoed, so
 * nothing else in the message can ride out. Same rule as `enrich.ts`'s
 * `visionExcuse`, which this deliberately mirrors.
 *
 * Ported from another session's fix that was cut against the English-only
 * version of this file and could not apply here; the behaviour is its, the
 * bilingual shape is this file's.
 */
function whyUnavailable(error: unknown): { en: string; ar: string } {
  const line = (error instanceof Error ? error.message : String(error)).split("\n")[0];
  const status = Number(line.match(/\b([45]\d\d)\b/)?.[1] ?? 0);
  // A rate limit (429) or a service-side error (5xx) is "busy, try again";
  // any other failure is not something the viewer can act on and gets no
  // gloss. Only these fixed sentences are ever emitted.
  if (status === 429 || (status >= 500 && status <= 599)) {
    return {
      en: " because the service was busy, and it usually works a little later",
      ar: " لأن الخدمة كانت مزدحمة، وغالبًا تعود بعد قليل",
    };
  }
  return { en: "", ar: "" };
}
