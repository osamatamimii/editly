/**
 * Turning words into captions someone can actually read.
 *
 * The renderer already burns cues; this decides what a cue *is*. That decision
 * is most of the difference between captions that feel professional and
 * captions that feel automatic, and almost none of it is about fonts.
 *
 * Three constraints fight each other, and the numbers below are where they
 * settle:
 *
 * Reading speed. Roughly 20 characters per second is comfortable; broadcast
 * subtitling has used something close to this for decades. Faster and people
 * stop reading and start missing words.
 *
 * Line length. On a phone held at arm's length, a caption wider than about 20
 * characters per line either shrinks below legibility or runs into the edges.
 * Short-form captions are short for a physical reason, not a stylistic one.
 *
 * Sync. A cue that appears before its first word is a distraction; one that
 * lingers past its last is clutter. We hold to the word timings, and only ever
 * stretch a cue that is too brief to read at all — and then forward, into the
 * silence after it, never backward over speech that has not happened yet.
 */
import type { Transcript, TranscriptWord } from "./providers/types";
import { linesFor } from "./caption-layout";

export interface CaptionCue {
  startMs: number;
  endMs: number;
  text: string;
  words: Array<{ startMs: number; endMs: number; text: string }>;
}

export interface CaptionOptions {
  /** Characters per line before we wrap. Vertical video wants this small. */
  maxCharsPerLine?: number;
  /**
   * How wide a line may draw, in cap heights — the same unit and the same
   * measurement `wrapToLayout` breaks lines on.
   *
   * Grouping and wrapping have to agree, and a character count and a width
   * measurement do not. Left to the count, a group of eight capitals reads as
   * comfortably inside two lines and then draws four, and the fourth is thrown
   * away with an ellipsis — a caption cut short by two estimates disagreeing
   * about the same sentence, with nothing anywhere to say so.
   *
   * Optional so a caller with no layout still gets the old behaviour rather
   * than a NaN budget that groups an entire segment into one cue.
   */
  lineWidthInCaps?: number;
  /** Lines a single cue may occupy. */
  maxLines?: number;
  /** Longest a single cue may stay up, however few characters it has. */
  maxCueMs?: number;
  /** A pause at least this long ends a cue, whatever the character count. */
  breakOnPauseMs?: number;
  /** Leave "um" and "uh" out of the burnt-in text. */
  dropFillers?: boolean;
  /**
   * Words the recogniser was unsure of. Below this we keep the timing (so the
   * karaoke rhythm survives) but the word is more likely wrong than right, and
   * a wrong word on screen is worse than a missing one.
   */
  minConfidence?: number;
}

const DEFAULTS = {
  maxCharsPerLine: 20,
  maxLines: 2,
  maxCueMs: 3500,
  breakOnPauseMs: 500,
  dropFillers: true,
  minConfidence: 0.4,
} satisfies Required<Omit<CaptionOptions, "lineWidthInCaps">>;

/** Below this a cue is a flash, not a caption. */
const MIN_CUE_MS = 700;

/** Comfortable reading rate, characters per second. */
const CHARS_PER_SECOND = 20;

export function buildCaptionCues(transcript: Transcript, options: CaptionOptions = {}): CaptionCue[] {
  const config = { ...DEFAULTS, ...options };
  const maxChars = config.maxCharsPerLine * config.maxLines;
  const budget =
    typeof options.lineWidthInCaps === "number" && options.lineWidthInCaps > 0
      ? options.lineWidthInCaps
      : null;
  /*
    Does this group still fit?

    Answered by *doing the wrap* rather than by comparing a total width to a
    budget, because those are not the same question. Greedy line-filling leaves
    room at the end of every line, so a cue whose text measures exactly three
    lines' worth of width lands on four — and the fourth is over the limit and
    is truncated with an ellipsis. Words thrown away by two steps disagreeing
    about the same sentence, with nothing anywhere to say so.

    Same function as `wrapToLayout` calls, so they cannot disagree.
  */
  const overruns = (words: TranscriptWord[]): boolean =>
    budget === null
      ? charsOf(words) > maxChars
      : linesFor(words.map((w) => w.text).join(" "), budget).length > config.maxLines;
  const cues: CaptionCue[] = [];

  for (const segment of transcript.segments) {
    let group: TranscriptWord[] = [];

    const flush = () => {
      const cue = toCue(group, config);
      if (cue) cues.push(cue);
      group = [];
    };

    for (const word of segment.words) {
      if (config.dropFillers && word.filler) {
        // A filler ends the group rather than joining it: "so — um — anyway"
        // should not become one caption reading "so anyway" stretched across
        // the pause where the "um" was.
        flush();
        continue;
      }

      const previous = group[group.length - 1];
      const wouldOverrun = overruns([...group, word]);
      const pauseBefore = previous ? word.startMs - previous.endMs : 0;
      const wouldRunLong = group.length > 0 && word.endMs - group[0].startMs > config.maxCueMs;

      if (previous && (wouldOverrun || pauseBefore >= config.breakOnPauseMs || wouldRunLong)) flush();
      group.push(word);
    }
    flush();
  }

  return holdLongEnough(cues);
}

function toCue(
  words: TranscriptWord[],
  config: Required<Omit<CaptionOptions, "lineWidthInCaps">>,
): CaptionCue | null {
  const kept = words.filter((w) => w.text.trim().length > 0);
  if (kept.length === 0) return null;

  const shown = kept.map((w) => (w.confidence < config.minConfidence ? maskUncertain(w) : w));
  const text = shown
    .map((w) => w.text)
    .join(" ")
    .trim();
  if (text.length === 0) return null;

  return {
    startMs: kept[0].startMs,
    endMs: Math.max(kept[kept.length - 1].endMs, kept[0].startMs + 1),
    text,
    words: shown.map((w) => ({ startMs: w.startMs, endMs: w.endMs, text: w.text })),
  };
}

/**
 * We do not silently invent a word we were told is probably wrong, and we do
 * not leave a hole in the rhythm either. An ellipsis reads as "something was
 * said here", which is the truth.
 */
function maskUncertain(word: TranscriptWord): TranscriptWord {
  return { ...word, text: "…" };
}

/**
 * A cue too short to read gets held longer — but only into the gap before the
 * next one, and never past it. Overlapping cues make the renderer choose, and
 * whatever it chooses looks like a bug.
 */
function holdLongEnough(cues: CaptionCue[]): CaptionCue[] {
  return cues.map((cue, i) => {
    const readable = Math.max(MIN_CUE_MS, (cue.text.length / CHARS_PER_SECOND) * 1000);
    const wanted = cue.startMs + readable;
    const ceiling = cues[i + 1] ? cues[i + 1].startMs : Number.POSITIVE_INFINITY;
    const endMs = Math.min(Math.max(cue.endMs, wanted), ceiling);
    return endMs > cue.endMs ? { ...cue, endMs } : cue;
  });
}

function charsOf(words: TranscriptWord[]): number {
  return words.reduce((n, w, i) => n + w.text.length + (i > 0 ? 1 : 0), 0);
}

/**
 * Where the speaker leaned on a word — the moments a punch-in belongs.
 *
 * This is the cheap version and it is honest about being one: emphasis here
 * means "a word that lands right after a pause and holds longer than the words
 * around it", which is how people stress things when they talk. It needs no
 * model and no key, and it beats spreading punches evenly across the clip by a
 * distance you can see immediately.
 */
export function emphasisPoints(transcript: Transcript, limit = 8): number[] {
  const words = transcript.segments.flatMap((s) => s.words).filter((w) => !w.filler && w.endMs > w.startMs);
  if (words.length < 4) return [];

  const durations = words.map((w) => w.endMs - w.startMs);
  const typical = median(durations);
  if (typical <= 0) return [];

  const scored = words
    .map((word, i) => {
      const previous = words[i - 1];
      const pauseBefore = previous ? word.startMs - previous.endMs : 0;
      const stretch = (word.endMs - word.startMs) / typical;
      // Both signals matter, and neither alone is enough: a long word mid-flow
      // is often just a long word, and a pause followed by a short word is a
      // breath. An ordinary word with neither scores 1.
      return { atMs: word.startMs, score: stretch + Math.min(pauseBefore, 800) / 400 };
    })
    .filter((point) => point.score >= MIN_EMPHASIS_SCORE);

  // Strongest first, and each one silences its neighbours. Taking the top N by
  // score and *then* thinning by time gets this backwards: an ordinary word
  // that happens to sit early can survive the spacing pass and push out the
  // moment the whole punch was for.
  const chosen: Array<{ atMs: number; score: number }> = [];
  for (const point of [...scored].sort((a, b) => b.score - a.score)) {
    if (chosen.length >= limit) break;
    if (chosen.some((taken) => Math.abs(taken.atMs - point.atMs) < MIN_EMPHASIS_GAP_MS)) continue;
    chosen.push(point);
  }

  return chosen.sort((a, b) => a.atMs - b.atMs).map((p) => +(p.atMs / 1000).toFixed(2));
}

/**
 * Below this there is no evidence of emphasis, only ordinary speech — and a
 * punch on ordinary speech is the tell of an automatic edit. Flat delivery
 * should get no punches at all rather than arbitrary ones.
 */
const MIN_EMPHASIS_SCORE = 2;

/** Punches closer together than this stop reading as emphasis and start reading as a tic. */
const MIN_EMPHASIS_GAP_MS = 1500;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
