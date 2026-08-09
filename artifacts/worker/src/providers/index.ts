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
import { createDeepgramTranscriber } from "./deepgram";
import { createGeminiSceneReader } from "./gemini";
import type { ProviderStatus, SceneReader, Transcriber } from "./types";

export interface Providers {
  transcriber: Transcriber | null;
  sceneReader: SceneReader | null;
  /** Null where the capability is available; otherwise why it is not. */
  status: ProviderStatus;
}

export interface ProviderEnv {
  DEEPGRAM_API_KEY?: string;
  DEEPGRAM_MODEL?: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
}

export function resolveProviders(env: ProviderEnv = process.env as ProviderEnv): Providers {
  const deepgramKey = trimmed(env.DEEPGRAM_API_KEY);
  const geminiKey = trimmed(env.GEMINI_API_KEY);

  const transcriber = deepgramKey
    ? createDeepgramTranscriber({ apiKey: deepgramKey, model: trimmed(env.DEEPGRAM_MODEL) })
    : null;

  const sceneReader = geminiKey
    ? createGeminiSceneReader({ apiKey: geminiKey, model: trimmed(env.GEMINI_MODEL) })
    : null;

  return {
    transcriber,
    sceneReader,
    status: {
      transcription: transcriber
        ? null
        : "no speech recognition is configured, so captions and word-accurate cuts are unavailable — silence detection is doing the cutting",
      vision: sceneReader
        ? null
        : "no scene understanding is configured, so shot selection is based on speech alone",
    },
  };
}

/**
 * The sentence a render note carries when something was skipped. Empty when
 * everything the plan asked for was available.
 */
export function missingCapabilityNotes(status: ProviderStatus, needs: { transcript: boolean; vision: boolean }): string[] {
  const notes: string[] = [];
  if (needs.transcript && status.transcription) notes.push(status.transcription);
  if (needs.vision && status.vision) notes.push(status.vision);
  return notes;
}

function trimmed(value: string | undefined): string | undefined {
  const out = value?.trim();
  return out ? out : undefined;
}
