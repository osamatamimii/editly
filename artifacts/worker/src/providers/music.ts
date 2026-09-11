/**
 * Making a bed that did not exist, for somebody who owns no music.
 *
 * For the whole life of this product the answer to "put some music under it"
 * was a refusal with a reason attached: a track we hand out is a licence we
 * bought on the customer's behalf, and the only safe track is one they
 * uploaded themselves. That argument was right about catalogues and it turns
 * out to have an answer — audio generated to our account is audio we own, and
 * handing it on takes nothing from anybody.
 *
 * Two things about the shape of this file are deliberate.
 *
 * **It takes a mood, not a prompt.** A free-text prompt is a fresh generation
 * on every render, priced per render forever. A mood is a key: one calm bed is
 * made once and served to everyone who asks for a calm bed. The cost of the
 * whole music library is bounded by the number of moods, not by the number of
 * videos cut — which is the difference between a line item and a business.
 *
 * **It returns a file and says nothing about where it goes.** Storing the
 * result, measuring its tempo and remembering it for the next person are the
 * library's job, not the maker's. This module knows one thing: how to ask a
 * model for thirty seconds of music and put the bytes on disk.
 */
import { writeFile } from "node:fs/promises";
import type { MusicMood } from "@workspace/api-zod";

export interface MusicRequest {
  mood: MusicMood;
  /** How long a bed to ask for. The model decides whether it can oblige. */
  seconds: number;
  /** Where to write it. The caller owns the path and the cleanup. */
  file: string;
}

export interface MusicMaker {
  /** For the render notes and the logs. Never a key. */
  name: string;
  /**
   * Returns the file it wrote, or null when it could not make one.
   *
   * Null rather than a throw, and for the same reason every other provider in
   * this folder answers null: a bed that could not be made is a worse video,
   * not a failed render. The caller writes a note and carries on.
   */
  make(request: MusicRequest): Promise<{ file: string; seconds: number } | null>;
}

/**
 * What each mood asks the model for.
 *
 * Written out rather than derived from the mood name because the name is for
 * the person and the prompt is for the model, and the two want different
 * words. Every one of them says **instrumental** and says it first: a bed with
 * a voice on it competes with the voice the video already has, which is the
 * one thing a bed must never do.
 *
 * They also all ask for a steady tempo. Not for taste — for `beats.ts`, which
 * has to find a grid in the result if the zoom punches are ever to land on it.
 * A rubato piano piece is a bed whose tempo detector correctly answers "no
 * grid here", and then the punches fall on arithmetic instead.
 */
const PROMPTS: Record<MusicMood, string> = {
  calm: "Instrumental background music, no vocals. Soft warm pads and a gentle steady pulse, unhurried, spacious, even dynamics throughout. Suitable as a quiet bed under speech.",
  upbeat: "Instrumental background music, no vocals. Bright, driving, steady four-on-the-floor pulse, plucky synths and light percussion, energetic but not busy. Suitable as a bed under speech.",
  cinematic: "Instrumental background music, no vocals. Wide sustained strings and low drone, slow steady pulse, restrained and serious, building gently. Suitable as a bed under speech.",
  dark: "Instrumental background music, no vocals. Low brooding bass, sparse muted percussion, steady tense pulse, minor tonality, no sudden hits. Suitable as a bed under speech.",
  playful: "Instrumental background music, no vocals. Light bouncy marimba and plucked notes, steady cheerful pulse, simple and clean, nothing shrill. Suitable as a bed under speech.",
  warm: "Instrumental background music, no vocals. Mellow electric piano and soft bass, relaxed steady groove, gentle and friendly, even dynamics. Suitable as a bed under speech.",
};

/** The prompt a mood asks for. Exported so the suites can read it rather than
 *  re-describing it, and so a mood with no prompt fails a check. */
export function promptFor(mood: MusicMood): string {
  return PROMPTS[mood];
}

/**
 * How long a bed we ask for.
 *
 * Thirty seconds, looped by the mixer, rather than a bed the length of the
 * video. Three reasons, in order of how much they matter: a looped thirty
 * seconds under speech at -18 dB is indistinguishable from three minutes of
 * through-composed music; the price is per generation and a short one costs
 * less; and a file that serves every video length is a file that can be
 * *reused*, which is the entire economic argument of this module.
 */
export const BED_SECONDS = 30;

interface LyriaOptions {
  apiKey: string;
  model?: string | undefined;
  /** Overridable so the suites can point it at a local server. */
  base?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}

/**
 * Google's Lyria, through the Gemini API.
 *
 * Chosen over the licensed catalogues after pricing all of them: it is the
 * only provider in the whole search that publishes a number — $0.04 for a
 * thirty-second clip — and sells it self-serve with no contract. Every
 * catalogue that permits redistributing to our customers prices that privately
 * and starts with a sales call, and the one thing this product could not
 * afford was for the music to wait on a negotiation.
 *
 * What it is not: a substitute for a real catalogue. This makes beds, and beds
 * are what a fifteen-second product ad needs. A podcast intro deserves better
 * and should still be the customer's own file.
 */
export function createLyriaMusicMaker(options: LyriaOptions): MusicMaker {
  const model = options.model?.trim() || "lyria-3-clip-preview";
  const base = options.base?.trim() || "https://generativelanguage.googleapis.com";
  const doFetch = options.fetchImpl ?? fetch;

  return {
    name: `lyria:${model}`,
    async make({ mood, seconds, file }) {
      const response = await doFetch(`${base}/v1beta/models/${model}:generateMusic`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // The key travels in a header and never in the URL: a query string
          // is logged by every proxy between here and there.
          "x-goog-api-key": options.apiKey,
        },
        body: JSON.stringify({
          prompt: { text: promptFor(mood) },
          config: { durationSeconds: Math.max(5, Math.round(seconds)) },
        }),
      });

      if (!response.ok) return null;

      const body = (await response.json().catch(() => null)) as
        | { audio?: { data?: string; mimeType?: string } }
        | null;
      const data = body?.audio?.data;
      if (typeof data !== "string" || data.length === 0) return null;

      const bytes = Buffer.from(data, "base64");
      // A response that parsed but carries a handful of bytes is not audio. It
      // is an error page that happened to be JSON, and writing it would give
      // ffprobe something to fail on later instead of here.
      if (bytes.length < 1024) return null;

      await writeFile(file, bytes);
      return { file, seconds };
    },
  };
}
