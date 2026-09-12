/**
 * Which models we actually have, decided once, at the edge.
 *
 * Everything downstream asks this module rather than reading `process.env`
 * itself. That matters for one reason above the others: a capability that is
 * missing must be missing *visibly*. When a key is absent — or was revoked
 * last Tuesday and nobody noticed — the pipeline should keep cutting silence
 * and levelling audio, and the render should come back saying which part it
 * could not do. The failure mode we are designing against is a render that
 * silently drops captions and looks, to the person who paid for it, like the
 * product simply ignored them.
 *
 * Keys are read here and passed by value to the provider that needs them. They
 * are never logged, never returned from this module, and never put in a job
 * record or an error message.
 */
import { createCrossCheckedTranscriber } from "./cross-check";
import { createDeepgramTranscriber } from "./deepgram";
import { createElevenLabsTranscriber } from "./elevenlabs";
import { createGeminiSceneReader } from "./gemini";
import { createGeminiStructureReader } from "./gemini-structure";
import { createLyriaMusicMaker, type MusicMaker } from "./music";
import { createSynthMusicMaker } from "./synth-music";
import type { ProviderStatus, SceneReader, StructureReader, Transcriber } from "./types";
import { pick, sayIn, type Say } from "../say";

export interface Providers {
  transcriber: Transcriber | null;
  sceneReader: SceneReader | null;
  /**
   * Reads the transcript for structure — chapters, claims, questions, peaks,
   * the hook. Text only, and therefore the cheapest thing in here by two orders
   * of magnitude; it is separate from `sceneReader` because they answer
   * different questions from different inputs and one can be down while the
   * other is not.
   */
  structureReader: StructureReader | null;
  /**
   * Makes a music bed from a mood, for somebody who owns no music.
   *
   * Its own key rather than sharing the Gemini one, though both are Google's,
   * and that is not tidiness. Music is the only capability here that costs
   * money *per finished video* rather than per minute of source, and the
   * decision to spend it is a business decision. Sharing a key would mean
   * every deployment that turned on scene reading silently started buying
   * music too.
   */
  musicMaker: MusicMaker | null;
  /** Null where the capability is available; otherwise why it is not. */
  status: ProviderStatus;
}

export interface ProviderEnv {
  DEEPGRAM_API_KEY?: string;
  DEEPGRAM_MODEL?: string;
  ELEVENLABS_API_KEY?: string;
  ELEVENLABS_MODEL?: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  GEMINI_MEDIA_RESOLUTION?: string;
  /** Overrides `GEMINI_MODEL` for the transcript reading alone. */
  GEMINI_STRUCTURE_MODEL?: string;
  LYRIA_API_KEY?: string;
  LYRIA_MODEL?: string;
}

export function resolveProviders(env: ProviderEnv = process.env as ProviderEnv): Providers {
  const deepgramKey = trimmed(env.DEEPGRAM_API_KEY);
  const elevenLabsKey = trimmed(env.ELEVENLABS_API_KEY);
  const geminiKey = trimmed(env.GEMINI_API_KEY);

  const deepgram = deepgramKey
    ? createDeepgramTranscriber({ apiKey: deepgramKey, model: trimmed(env.DEEPGRAM_MODEL) })
    : null;

  const elevenLabs = elevenLabsKey
    ? createElevenLabsTranscriber({ apiKey: elevenLabsKey, model: trimmed(env.ELEVENLABS_MODEL) })
    : null;

  // Deepgram is the clock in every pairing, because its word boundaries are
  // what the cuts are measured against. With only ElevenLabs configured it
  // becomes the clock by default — one accurate reader beats none, and the
  // notes will say the timings are not the ones the pipeline was tuned on.
  const transcriber: Transcriber | null =
    deepgram && elevenLabs
      ? createCrossCheckedTranscriber({ primary: deepgram, secondary: elevenLabs })
      : (deepgram ?? elevenLabs);

  const sceneReader = geminiKey
    ? createGeminiSceneReader({
        apiKey: geminiKey,
        model: trimmed(env.GEMINI_MODEL),
        mediaResolution: trimmed(env.GEMINI_MEDIA_RESOLUTION),
      })
    : null;

  // The same key as the scene reader, and deliberately its own field: the two
  // are separate capabilities on one account, and a deployment that turns the
  // expensive one off should not lose the cheap one with it.
  /*
    Lyria where it is paid for, and our own synthesiser everywhere else.

    Never null, which is the change worth noticing. Every other capability in
    this file degrades to absence when its key is missing, because there is no
    substitute for reading speech. Music has one: `synth-music.ts` computes a
    bed from oscillators and seeded noise, the same way the sixteen sound
    effects in this product are computed, and it needs no key, no host and no
    invoice.

    That matters more than it looks. Reaching Lyria requires a Google Cloud
    billing account, and a payment system can refuse one for reasons that have
    nothing to do with this product or this customer. A music feature whose
    critical path runs through somebody else's risk model is a music feature
    that can stop shipping on a Tuesday.
  */
  const lyriaKey = trimmed(env.LYRIA_API_KEY);
  const musicMaker: MusicMaker = lyriaKey
    ? createLyriaMusicMaker({ apiKey: lyriaKey, model: trimmed(env.LYRIA_MODEL) })
    : createSynthMusicMaker();

  const structureReader = geminiKey
    ? createGeminiStructureReader({
        apiKey: geminiKey,
        model: trimmed(env.GEMINI_STRUCTURE_MODEL) ?? trimmed(env.GEMINI_MODEL),
      })
    : null;

  return {
    transcriber,
    sceneReader,
    structureReader,
    musicMaker,
    status: {
      transcription: transcriber
        ? null
        : {
            en: "no speech recognition is configured, so captions and word-accurate cuts are unavailable. Silence detection is doing the cutting",
            ar: "لا يوجد تعرّف على الكلام مُهيّأ، فالكابشن والقصّ الدقيق على الكلمات غير متاحين. كشف الصمت هو الذي يقصّ",
          },
      vision: sceneReader
        ? null
        : {
            en: "no scene understanding is configured, so shot selection is based on speech alone",
            ar: "لا يوجد فهم للمشهد مُهيّأ، فاختيار اللقطات يعتمد على الكلام وحده",
          },
      crossCheck:
        deepgram && elevenLabs
          ? null
          : transcriber
            ? {
                en: "only one speech model is configured, so captions rest on a single reading instead of two that agree",
                ar: "نموذج كلام واحد فقط مُهيّأ، فالكابشن يستند إلى قراءة واحدة بدل قراءتين تتّفقان",
              }
            : null,
      /*
        Absent is the ordinary state here, unlike every other line in this
        object. Music is off by default in this product — a bed is laid only
        when somebody asks for one in words — so a deployment with no music key
        is a deployment working as intended, and this note is only ever read by
        a render whose plan actually asked for a bed.
      */
      /*
        Not "is there a generator" any more — there always is. What this says
        now is *which*, because the difference is audible: a written track from
        a catalogue model against a loop we compute. Still absent from most
        renders, since music is only ever laid when somebody asks for it.
      */
      music: lyriaKey
        ? null
        : {
            en: "music beds are the ones this product generates itself, which are loops rather than written tracks. Upload your own audio file for anything more than a bed",
            ar: "الفرشات الموسيقية هي التي يولّدها هذا المنتج بنفسه، وهي حلقات لا مقطوعات مؤلَّفة. ارفع ملفًّا صوتيًّا خاصًّا بك لما هو أكثر من فرشة",
          },
      structure: structureReader
        ? null
        : {
            en: "nothing is configured to read what was said for meaning, so the strongest moments are chosen by how densely somebody was talking rather than by what they said",
            ar: "لا يوجد ما يقرأ الكلام قراءةً معنويّة، فاختيار أقوى اللحظات يجري بكثافة الكلام لا بما قيل فيه",
          },
    },
  };
}

/**
 * The sentence a render note carries when something was skipped. Empty when
 * everything the plan asked for was available.
 */
export function missingCapabilityNotes(
  status: ProviderStatus,
  needs: { transcript: boolean; vision: boolean },
  say: Say = sayIn("en"),
): string[] {
  const notes: string[] = [];
  if (needs.transcript && status.transcription) notes.push(pick(say, status.transcription));
  if (needs.transcript && status.crossCheck) notes.push(pick(say, status.crossCheck));
  if (needs.vision && status.vision) notes.push(pick(say, status.vision));
  return notes;
}

function trimmed(value: string | undefined): string | undefined {
  const out = value?.trim();
  return out ? out : undefined;
}
