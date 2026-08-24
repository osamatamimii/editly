/**
 * Time, before and after the cut.
 *
 * Silence removal gives the file two clocks: the one the recording was made on
 * and the one the viewer will watch. Everything that has to translate between
 * them — the renderer, the critic — needs the same three definitions, and if
 * they lived in `ffmpeg.ts` the critic could not import them without the
 * renderer importing the critic back. So they live here, on their own, with no
 * dependencies at all.
 *
 * `ffmpeg.ts` re-exports them, because that is where callers have always found
 * them and moving a file is not a reason to break an import.
 */

export interface Segment {
  /** Seconds. */
  start: number;
  end: number;
}

/**
 * Headroom kept around the frame when anything moves.
 *
 * Reframing crops to this multiple of the target, and the base zoom then scales
 * it back down to exactly the target — so an unmoved frame is a downscale, not
 * an upscale, and a punch-in has real pixels to expand into instead of
 * inventing them.
 */
export const MOTION_OVERSCAN = 1.15;

/**
 * Inverts a list of silences into the parts worth keeping, growing each kept
 * part by `padding` on both sides so words are not clipped at the cut.
 *
 * `protect` names stretches that must survive whatever the audio says about
 * them. Silence detection hears a demo running on screen, a reveal, or a beat
 * held before a punchline as exactly the same thing as dead air — and removing
 * one of those does not read as a tight edit, it reads as a broken video. A
 * silence that touches a protected stretch at all is left alone rather than
 * trimmed to fit: half of a held beat is worse than all of it.
 */
export function keepSegmentsFrom(
  duration: number,
  silences: Segment[],
  padding: number,
  protect: Segment[] = [],
): Segment[] {
  const kept: Segment[] = [];
  let cursor = 0;

  const isProtected = (silence: Segment): boolean =>
    protect.some((range) => silence.start < range.end && silence.end > range.start);

  for (const silence of silences) {
    if (isProtected(silence)) continue;
    const start = Math.max(0, silence.start + padding);
    if (start > cursor) kept.push({ start: cursor, end: start });
    cursor = Math.max(cursor, Math.min(duration, silence.end - padding));
  }
  if (cursor < duration) kept.push({ start: cursor, end: duration });

  // Fragments this short are cutting artefacts, not content.
  const MIN_SEGMENT_SECONDS = 0.05;
  return kept.filter((s) => s.end - s.start > MIN_SEGMENT_SECONDS);
}

/**
 * How long the edit actually runs.
 *
 * The sum of the kept stretches, less what the joins overlap. Every caller that
 * needs the length of the output needs the same subtraction, and a second place
 * that computes it by hand is a second place to get it wrong: a dissolve that
 * shortens the video without shortening the number the caption clock is checked
 * against pushes the last caption past the end of the file.
 */
export function outputDuration(kept: Segment[], overlap = 0): number {
  const spanned = kept.reduce((sum, s) => sum + (s.end - s.start), 0);
  return spanned - Math.max(0, kept.length - 1) * overlap;
}

/**
 * Where a moment in the original lands after the cuts. Moments inside a removed
 * stretch collapse onto the cut point, which is where a caption for them
 * belongs.
 *
 * `overlap` is how long each join runs both shots at once — zero for a hard
 * cut, the dissolve's duration otherwise. It is a parameter rather than a
 * second function because the alternative is two mappings that agree only while
 * someone remembers to change both: a dissolve moves *every* moment after the
 * first join earlier, and a caption placed by the un-overlapped map drifts
 * further out of sync with every join it survives. Passing zero is the old
 * behaviour exactly.
 */
export function remapTime(seconds: number, kept: Segment[], overlap = 0): number {
  // Where each kept stretch lands in the output, in the order the concat will
  // play them — which since the cold open exists is no longer necessarily the
  // order they occur in the source. Each join after the first pulls everything
  // that follows it earlier by the length of the overlap.
  let elapsed = 0;
  const placed = kept.map((segment, i) => {
    const at = Math.max(0, elapsed - i * overlap);
    elapsed += segment.end - segment.start;
    return { segment, at };
  });
  const total = Math.max(0, elapsed - Math.max(0, kept.length - 1) * overlap);

  for (const { segment, at } of placed) {
    if (seconds >= segment.start && seconds <= segment.end) {
      return Math.min(total, at + (seconds - segment.start));
    }
  }

  // Not inside anything that was kept: this moment was cut away. It lands on
  // the seam where the nearest *following* source material begins — which is
  // what a caption pinned to a deleted sentence should do, and what this
  // function has always done. Written as a search rather than as "the first
  // segment we walked past" so that a reordered list gets the same answer a
  // sorted one would.
  let best: { at: number; start: number } | null = null;
  for (const { segment, at } of placed) {
    if (segment.start > seconds && (best === null || segment.start < best.start)) {
      best = { at, start: segment.start };
    }
  }
  return best ? best.at : total;
}

/**
 * A spoken word, on the source clock, in seconds.
 *
 * One shape for both readers of it: the cut, which only needs the boundaries so
 * it can avoid landing between them, and the critic, which only needs to know
 * whether the word was a hesitation. Two types for the same measurement of the
 * same file would drift.
 */
export interface SpokenWord {
  start: number;
  end: number;
  /** True for "um", "uh" and friends. A punch must not land on one. */
  filler?: boolean;
}

/**
 * The longest a single spoken word is believed to be.
 *
 * The first version of this capped how far a cut could be *dragged*, which was
 * the wrong measure: a boundary inside a word clips that syllable no matter how
 * near the edge it is, so the distance is not what makes the fix worth making.
 * What actually matters is whether the thing we are snapping out of is a word
 * at all. A recogniser occasionally emits a "word" spanning several seconds —
 * a run of speech it could not segment, a stretch of music — and snapping out
 * of one of those would undo the trim entirely for no gain.
 *
 * Two seconds is generous for a word said out loud and short enough to rule
 * that out.
 */
const MAX_WORD_SECONDS = 2;

/**
 * Move every splice out of the middle of a word.
 *
 * Silence detection works on amplitude, and amplitude does not respect words.
 * A stop consonant, an unvoiced syllable, the quiet tail of a sentence — any of
 * them can dip below the threshold for long enough to be read as a pause, and
 * the cut then lands *inside* a word. The result is a clipped syllable: the
 * single most audible way an automatic edit gives itself away, and one nobody
 * reports as a bug because it sounds like the speaker stumbled.
 *
 * The transcript knows exactly where words begin and end, so this is
 * arithmetic, not a judgement. Each boundary moves outward — the start of a
 * kept stretch moves earlier to the word's start, the end moves later to the
 * word's end — because keeping a little extra audio is always safe and losing a
 * little never is.
 */
export function snapToWords(kept: Segment[], words: SpokenWord[]): Segment[] {
  if (kept.length === 0 || words.length === 0) return kept;

  const insideAt = (t: number): SpokenWord | undefined =>
    words.find((word) => t > word.start && t < word.end && word.end - word.start <= MAX_WORD_SECONDS);

  const snapped = kept.map((segment) => {
    let { start, end } = segment;

    const atStart = insideAt(start);
    if (atStart) start = atStart.start;

    const atEnd = insideAt(end);
    if (atEnd) end = atEnd.end;

    return { start: Math.max(0, start), end };
  });

  // Widening both sides can make neighbours meet or overlap. Two kept stretches
  // that now touch were separated by a pause shorter than the word either side
  // of it, which means there was nothing to remove between them: merge rather
  // than emit a zero-length cut ffmpeg would turn into a stutter.
  const merged: Segment[] = [];
  for (const segment of snapped) {
    const previous = merged[merged.length - 1];
    if (previous && segment.start <= previous.end) {
      previous.end = Math.max(previous.end, segment.end);
      continue;
    }
    merged.push({ ...segment });
  }

  return merged.filter((s) => s.end > s.start);
}
