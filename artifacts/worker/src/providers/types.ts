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
}

export interface Transcriber {
  readonly name: string;
  /** `mediaPath` is a local file. Implementations extract their own audio. */
  transcribe(mediaPath: string, options?: TranscribeOptions): Promise<Transcript>;
}

export interface TranscribeOptions {
  /** BCP-47 hint. Omit to let the provider detect. */
  language?: string;
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

/** Why a capability is unavailable, in words a render note can carry. */
export interface ProviderStatus {
  transcription: string | null;
  vision: string | null;
}
