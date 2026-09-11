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
  make(request: MusicRequest): Promise<{ file: string } | null>;
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
 * How long a bed is, and why we do not ask.
 *
 * Lyria's length is chosen by the *model*, not by a parameter:
 * `lyria-3-clip-preview` makes thirty-second clips and `lyria-3.5` makes
 * whole songs. There is no `durationSeconds` in the request and inventing one
 * would have been a field the API ignores — a setting that looks like control
 * and is decoration.
 *
 * Thirty seconds, looped by the mixer, is the right size anyway, for three
 * reasons in order of how much they matter: a looped thirty seconds under
 * speech at -18 dB is indistinguishable from three minutes of through-composed
 * music; the price is per generation and the clip model is the cheap one; and
 * a file that serves every video length is a file that can be *reused*, which
 * is the entire economic argument of this module.
 *
 * This is what the clip model produces, kept as the number to compare a
 * measured duration against — never as the number to record. What lands in
 * the library is measured from the file.
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
 * Pull the audio out of an interaction response.
 *
 * The shape is `steps[] -> content[] -> {type, data}`, and the walk is written
 * defensively on purpose: this is a preview API, the response is nested three
 * deep, and the failure mode of guessing wrong is not an exception — it is
 * `undefined`, then a zero-byte file, then a render that says it could not
 * make a bed for a reason nobody can see. `output_audio` is the convenience
 * field the official clients read; it is tried first and the walk is the
 * fallback, so a response carrying either one works.
 */
function audioFrom(body: unknown): string | null {
  const root = body as {
    output_audio?: { data?: unknown };
    steps?: { content?: { type?: unknown; data?: unknown }[] }[];
  } | null;

  const direct = root?.output_audio?.data;
  if (typeof direct === "string" && direct.length > 0) return direct;

  for (const step of root?.steps ?? []) {
    for (const block of step?.content ?? []) {
      if (block?.type === "audio" && typeof block.data === "string" && block.data.length > 0) {
        return block.data;
      }
    }
  }
  return null;
}

export function createLyriaMusicMaker(options: LyriaOptions): MusicMaker {
  /*
    The clip model, not the song model.

    `lyria-3-clip-preview` is thirty seconds and `lyria-3.5` is a whole song of
    a couple of minutes. A bed wants the first: it loops, it is cheaper, and a
    song under somebody talking is a song nobody hears the end of.
  */
  const model = options.model?.trim() || "lyria-3-clip-preview";
  const base = options.base?.trim() || "https://generativelanguage.googleapis.com";
  const doFetch = options.fetchImpl ?? fetch;

  return {
    name: `lyria:${model}`,
    async make({ mood, file }) {
      const response = await doFetch(`${base}/v1beta/interactions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // The key travels in a header and never in the URL: a query string
          // is logged by every proxy between here and there.
          "x-goog-api-key": options.apiKey,
        },
        body: JSON.stringify({
          model,
          input: promptFor(mood),
          response_format: { type: "audio" },
        }),
      });

      if (!response.ok) return null;

      const data = audioFrom(await response.json().catch(() => null));
      if (!data) return null;

      const bytes = Buffer.from(data, "base64");
      // A response that parsed but carries a handful of bytes is not audio. It
      // is an error page that happened to be JSON, and writing it would give
      // ffprobe something to fail on later instead of here.
      if (bytes.length < 1024) return null;

      await writeFile(file, bytes);
      /*
        No duration reported, deliberately.

        We did not ask for a length and the model owes us no promise about one,
        so the only honest number comes from the file. `music-library` measures
        it before the row is written — the same rule the tempo follows, and for
        the same reason: a number about audio that did not come from the audio
        is a number that will be wrong on the day it matters.
      */
      return { file };
    },
  };
}
