/**
 * The words that were said and did not need to be.
 *
 * ## The gap this closes
 *
 * `removeSilence` cuts where the audio is quiet. That is the operation this
 * product is built around and it is only half of what a person means by "tidy
 * this up", because the other half is loud: an «آآ» held at full volume, a
 * sentence started twice, a "the — the" stutter. None of it is silent, so none
 * of it is touched, and a video with every pause removed still sounds like
 * somebody thinking out loud.
 *
 * The information to fix it has been sitting in this codebase the whole time.
 * `isFiller` marks hesitations on every word of every transcript; the captions
 * drop them, the highlight scorer counts them against a window, and **nothing
 * has ever cut one out of the video**. This is that.
 *
 * ## Why it produces spans instead of doing the cutting
 *
 * Because the cutting is already correct. `keepSegmentsFrom` inverts spans into
 * kept stretches, `snapToWords` moves a cut off the middle of a word,
 * `remapTime` moves every caption and punch onto the new clock, and the critic
 * checks the result. A second cutter would be a second place for all of that to
 * be got wrong — and the worst bug this renderer ever had was two places
 * knowing about source-versus-edited time.
 *
 * So this returns a list of spans to remove, in source seconds, and they join
 * the silences on their way to the same machinery.
 *
 * ## The one rule that keeps it from being worse than nothing
 *
 * **Never remove a word somebody meant.** A hesitation left in is untidy; a
 * word cut out changes what a person said, on a recording published under
 * their name. Every threshold below is set on that side of the line — which is
 * why the filler list refuses «يعني» and «طيب», why a repeat must be immediate
 * and close in time, and why the whole pass gives up rather than exceed a share
 * of the video.
 */
import { isFiller } from "./providers/fillers";
import type { Segment, SpokenWord } from "./timeline";

/** A span to drop, with the padding it wants at its edges. */
export interface Cut extends Segment {
  /**
   * Seconds kept inside each edge of this span.
   *
   * Silence detection needs padding because amplitude does not respect words.
   * These spans come from word boundaries and are already exact, so they take
   * none — a filler padded by the silence pass's 80 ms is a filler with its
   * first and last eightieth of a second still in the video, which is audible
   * as a click rather than as a word.
   */
  pad?: number;
  why: "filler" | "repeat";
}

/**
 * Below this a word's timing is recogniser noise rather than a measurement,
 * and cutting on it lands somewhere arbitrary.
 */
const MIN_FILLER_SECONDS = 0.08;

/** Above this it is not a hesitation, it is something else that got marked. */
const MAX_FILLER_SECONDS = 2.0;

/**
 * Breath left at each side of a filler cut.
 *
 * Cutting from the previous word's end to the next word's start removes the
 * hesitation *and* the pause it sat in, which is what a person editing by hand
 * does. Taking all of it makes the join sound rushed, so a beat stays.
 */
const BREATH_SECONDS = 0.06;

/** Two runs further apart than this are not a false start, they are a callback. */
const MAX_REPEAT_GAP_SECONDS = 2.5;

/** The longest phrase treated as a restart. Beyond this it is a real repetition. */
const MAX_REPEAT_WORDS = 5;

/**
 * The most of a video this pass is allowed to take.
 *
 * Not a tuning knob. If a quarter of somebody's recording reads as filler and
 * false starts, the transcript is wrong or the video is not speech, and the
 * honest answer is to do nothing and say so — a video that came back a quarter
 * shorter with no explanation is a bug report, not an edit.
 */
export const MAX_DROP_SHARE = 0.25;

/** Lowercased, stripped of anything that is not a letter or a digit. */
const NOT_A_LETTER = /[^\p{L}\p{N}]/gu;

/** Arabic marks are pronunciation, not spelling: «قَالَ» and «قال» are one word. */
const ARABIC_MARKS = /[ً-ْٰـ]/g;

export function normaliseWord(text: string): string {
  return text
    .replace(ARABIC_MARKS, "")
    .replace(NOT_A_LETTER, "")
    .toLowerCase();
}

interface Timed extends SpokenWord {
  text: string;
}

/** Only words with text and a real span can be reasoned about. */
function usable(words: SpokenWord[]): Timed[] {
  return words.filter(
    (w): w is Timed => typeof w.text === "string" && w.text.trim().length > 0 && w.end > w.start,
  );
}

/**
 * Hesitations, with the dead air they sat in.
 *
 * A filler is cut from a breath after the previous word to a breath before the
 * next, so the join is one clean edit rather than two half-pauses stitched
 * together. At the ends of the clip there is no neighbour, so the span stops at
 * the word itself.
 */
export function fillerCuts(words: SpokenWord[]): Cut[] {
  const timed = usable(words);
  const cuts: Cut[] = [];

  for (let i = 0; i < timed.length; i += 1) {
    const word = timed[i];
    // `filler` is set by the merge where a provider marks it, and `isFiller`
    // reads the text where none does. Both, because the English providers mark
    // and the Arabic path is text-only.
    if (!(word.filler === true || isFiller(word.text))) continue;

    const length = word.end - word.start;
    if (length < MIN_FILLER_SECONDS || length > MAX_FILLER_SECONDS) continue;

    const previous = timed[i - 1];
    const next = timed[i + 1];
    const gapBefore = previous ? word.start - previous.end : 0;
    const gapAfter = next ? next.start - word.end : 0;

    const start = previous
      ? Math.max(previous.end + Math.min(gapBefore / 2, BREATH_SECONDS), previous.end)
      : word.start;
    const end = next
      ? Math.min(next.start - Math.min(gapAfter / 2, BREATH_SECONDS), next.start)
      : word.end;

    if (end > start) cuts.push({ start, end, pad: 0, why: "filler" });
  }

  return cuts;
}

/**
 * A phrase started, abandoned, and started again.
 *
 * "I think — I think that…" is one thought and two attempts, and the first
 * attempt is the one a person editing by hand deletes. The check is for an
 * *immediate* repeat: the same run of words again, with nothing between them
 * but a pause. That narrowness is the point — a phrase repeated later in a
 * sentence is emphasis, and deleting emphasis is deleting meaning.
 *
 * Longest run first, so "I think I think that" is one four-word finding rather
 * than two overlapping two-word ones.
 */
export function repeatCuts(words: SpokenWord[]): Cut[] {
  const timed = usable(words);
  const bare = timed.map((w) => normaliseWord(w.text));
  const cuts: Cut[] = [];
  const taken = new Set<number>();

  for (let n = MAX_REPEAT_WORDS; n >= 1; n -= 1) {
    for (let i = 0; i + 2 * n <= timed.length; i += 1) {
      let clashes = false;
      for (let k = i; k < i + 2 * n; k += 1) if (taken.has(k)) clashes = true;
      if (clashes) continue;

      let same = true;
      for (let k = 0; k < n; k += 1) {
        const a = bare[i + k];
        const b = bare[i + n + k];
        // An empty normalisation is punctuation or a symbol, and two of those
        // matching each other is not a repeated phrase.
        if (!a || a !== b) {
          same = false;
          break;
        }
      }
      if (!same) continue;

      // The two runs have to be adjacent in time as well as in the list: a
      // transcript that dropped a sentence between them would otherwise read
      // as a stutter.
      const gap = timed[i + n].start - timed[i + n - 1].end;
      if (gap > MAX_REPEAT_GAP_SECONDS) continue;

      /*
        The *first* run goes.

        Both are the same words, so the choice is about what surrounds them:
        the second run is the one that continues into the finished sentence,
        and the first is the one that was abandoned. Cutting the second would
        leave the abandoned attempt and delete the completed one.
      */
      const start = timed[i].start;
      const end = timed[i + n].start - Math.min(gap / 2, BREATH_SECONDS);
      if (end > start) {
        cuts.push({ start, end, pad: 0, why: "repeat" });
        for (let k = i; k < i + 2 * n; k += 1) taken.add(k);
      }
    }
  }

  return cuts.sort((a, b) => a.start - b.start);
}

export interface TightenOptions {
  fillers?: boolean;
  repeats?: boolean;
  /** Total length of the source, so the share can be judged. */
  duration: number;
}

export interface TightenResult {
  cuts: Cut[];
  fillersFound: number;
  repeatsFound: number;
  droppedSeconds: number;
  /** Set when the pass gave up, with the reason in plain words. */
  refused: "too much" | null;
}

/**
 * Everything to remove, merged, sorted, and judged as a whole.
 *
 * Merging matters: a filler inside an abandoned phrase is one cut, not two
 * overlapping ones, and `keepSegmentsFrom` walks its input in order assuming
 * the spans do not overlap.
 */
export function tighten(words: SpokenWord[], options: TightenOptions): TightenResult {
  const found: Cut[] = [];
  if (options.fillers !== false) found.push(...fillerCuts(words));
  if (options.repeats !== false) found.push(...repeatCuts(words));

  found.sort((a, b) => a.start - b.start);

  const merged: Cut[] = [];
  for (const cut of found) {
    const last = merged[merged.length - 1];
    if (last && cut.start <= last.end) {
      last.end = Math.max(last.end, cut.end);
      // A merged span keeps the first reason, which is the one the note names.
      continue;
    }
    merged.push({ ...cut });
  }

  const droppedSeconds = merged.reduce((sum, c) => sum + (c.end - c.start), 0);
  const fillersFound = found.filter((c) => c.why === "filler").length;
  const repeatsFound = found.filter((c) => c.why === "repeat").length;

  if (options.duration > 0 && droppedSeconds > options.duration * MAX_DROP_SHARE) {
    /*
      Refused rather than trimmed to the limit.

      A pass that removed exactly a quarter would be a pass that had already
      lost the argument and kept cutting. If this much of a recording reads as
      hesitation, the reading is wrong, and the video should come back as it
      was with a line saying why.
    */
    return { cuts: [], fillersFound, repeatsFound, droppedSeconds: 0, refused: "too much" };
  }

  return { cuts: merged, fillersFound, repeatsFound, droppedSeconds, refused: null };
}
