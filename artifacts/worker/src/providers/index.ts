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
import type { ProviderStatus, SceneReader, Transcriber } from "./types";
import { pick, sayIn, type Say } from "../say";

export interface Providers {
  transcriber: Transcriber | null;
  sceneReader: SceneReader | null;
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

  return {
    transcriber,
    sceneReader,
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
