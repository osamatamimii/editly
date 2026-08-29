import type { NotePair } from "../say";
/**
 * What we ask of a model, stated independently of who answers.
 *
 * Every provider in this folder is one implementation of one of these. The
 * point is not vendor-neutrality for its own sake — it is that the pipeline
 * should be readable without knowing whose API is behind each step, and that
 * swapping Deepgram for a local Whisper should be a change in one file rather
 * than a change in the editor.
 *
 * The second thing these types carry is absence. A missing key is a normal
 * state, not an error: the product still cuts silence, still reframes, still
 * levels audio. So every provider resolves to `null` when it has no key, and
 * the caller has to decide out loud what it does without it. That is why
 * `ProviderStatus` exists and why the render notes mention it — a render that
 * quietly skipped captions because a key expired is far worse than one that
 * says so.
 */

/** One word, with the timing that makes karaoke captions possible. */
export interface TranscriptWord {
  text: string;
  startMs: number;
  endMs: number;
  /** 0..1. Low confidence is a good reason not to burn a word on screen. */
  confidence: number;
  /** True for "um", "uh" and friends, when the provider marks them. */
  filler: boolean;
}

/** A stretch of continuous speech — one speaker, one breath group. */
export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
  words: TranscriptWord[];
  /** Present only when the provider was asked for, and found, more than one speaker. */
  speaker?: number;
}

export interface Transcript {
  segments: TranscriptSegment[];
  /** BCP-47 where the provider reports it. */
  language: string | null;
  /** Which provider and model produced this, for the render notes. */
  source: string;
  /**
   * Anything about *how* this transcript was arrived at that the person who
   * paid for the render deserves to know: a second model being unavailable,
   * words the two of them disagreed on. Absent when there is nothing to say.
   *
   * This exists because the alternative is silence. A transcript that was
   * cross-checked and one that was not look identical from the outside, and
   * quietly downgrading the thing someone is paying for is the failure mode
   * this whole provider layer is built to avoid.
   */
  notes?: string[];
}

export interface Transcriber {
  readonly name: string;
  /** `mediaPath` is a local file. Implementations extract their own audio. */
  transcribe(mediaPath: string, options?: TranscribeOptions): Promise<Transcript>;
}

export interface TranscribeOptions {
  /**
   * A language somebody stated. A provider must obey it, and must not detect
   * instead — the person who says which language it is knows better than any
   * detector.
   */
  language?: string;
  /**
   * The language we have *reason to believe*, with nobody having said so —
   * today, the language the request was written in.
   *
   * It is a belief, not a fact: someone writing Arabic may well have uploaded
   * an English clip. So a provider that can detect this language should still
   * detect, and use this only when detection cannot reach it — which is not a
   * hypothetical. Deepgram's detection covers thirty-five languages and Arabic
   * is not one of them, while Nova-3 transcribes Arabic perfectly well when it
   * is told. For that language, saying so is the only way it is ever heard.
   *
   * And it is deliberately *not* handed to every provider at once. Two models
   * told the same answer are not two opinions, and the cross-check between
   * them is the thing that catches this class of mistake in the first place.
   */
  expected?: string;
  /** Ask for speaker labels. Costs more at some providers. */
  diarize?: boolean;
  signal?: AbortSignal;
}

/**
 * What a model that watches the video tells us, as opposed to one that only
 * hears it. Deliberately coarse: this is scene understanding, not per-frame
 * tracking. Keeping a face in frame at 30fps is local vision work on our own
 * machine, and pretending an API can do it would build the pipeline wrong.
 */
export interface SceneRead {
  startMs: number;
  endMs: number;
  /** One line on what is happening, for the edit decision — not for the user. */
  description: string;
  /** 0..1, how much this stretch earns its place in a short cut. */
  interest: number;
  /** Things that must not be cut through: a screen share, a demo, a reveal. */
  protect: boolean;
}

export interface SceneReader {
  readonly name: string;
  read(mediaPath: string, options?: SceneReadOptions): Promise<SceneRead[]>;
}

export interface SceneReadOptions {
  /** Only look at this stretch. Long sources are read in windows. */
  fromMs?: number;
  toMs?: number;
  signal?: AbortSignal;
}

/**
 * Why a capability is unavailable, in words a render note can carry.
 *
 * Both languages, because these are built once at start-up and read by every
 * job afterwards — long before any of them knows which language it was asked
 * in. The job resolves the pair when it writes its notes.
 */
export interface ProviderStatus {
  transcription: NotePair | null;
  vision: NotePair | null;
  /**
   * Null when two speech models are configured and the words get corroborated.
   * Otherwise why they do not — a capability that is *half* configured is the
   * easiest one to lose without noticing, because everything still works.
   */
  crossCheck: NotePair | null;
}
