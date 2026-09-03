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
 * A span to be taken out, and how much of its own edges it keeps.
 *
 * `pad` is absent on a silence, which takes the pass's padding, and zero on a
 * span that came from a transcript, which is exact already. It exists at all
 * because the two kinds of removal now arrive at the same function.
 */
export interface RemovableSpan extends Segment {
  pad?: number;
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
 * One ordered, non-overlapping list out of several sources of removals.
 *
 * `keepSegmentsFrom` walks its input in order and assumes the spans do not
 * overlap: two that do would put the second one's start behind the cursor and
 * quietly produce a kept stretch of negative length, which is not an error
 * anywhere — it is a video missing a piece nobody asked to remove.
 *
 * That did not matter while silences were the only source. It does now that
 * hesitations arrive from the transcript, because a held "um" inside a detected
 * pause is exactly the overlap this has to collapse.
 *
 * The merged span keeps the **smaller** padding of the two. A span that came
 * from word boundaries is exact and asks for none; padding the union by the
 * silence pass's amount would put the start of a hesitation back into the
 * video, and half an "um" is more noticeable than a whole one.
 */
export function mergeSpans(spans: RemovableSpan[]): RemovableSpan[] {
  const sorted = [...spans].filter((s) => s.end > s.start).sort((a, b) => a.start - b.start);
  const merged: RemovableSpan[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
      if (span.pad !== undefined) {
        last.pad = last.pad === undefined ? span.pad : Math.min(last.pad, span.pad);
      }
      continue;
    }
    merged.push({ ...span });
  }
  return merged;
}

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
  silences: RemovableSpan[],
  padding: number,
  protect: Segment[] = [],
): Segment[] {
  const kept: Segment[] = [];
  let cursor = 0;

  const isProtected = (silence: Segment): boolean =>
    protect.some((range) => silence.start < range.end && silence.end > range.start);

  // Padding exists to stop a cut clipping a word: the leading pad gives the
  // speech *before* a silence room to finish, the trailing pad gives the speech
  // *after* it room to start. Where there is no speech on that side there is
  // nothing to protect — and padding anyway does real damage, because it
  // manufactures a kept piece out of pure silence.
  //
  // A clip that ends in silence, which is nearly all of them — people stop
  // talking before they stop recording — was coming out with a tenth of a
  // second of nothing welded to the end. Two harms, and the second is the one
  // that mattered: that sliver became the shortest piece in the edit, and the
  // transition's headroom is measured against the shortest piece, so **any
  // video that ended in silence quietly lost its dissolves** and was told its
  // pieces were too short to put a transition between. Found by rendering our
  // own templates, which is a thing nothing did until now.
  const EDGE = 1e-3;
  for (const silence of silences) {
    if (isProtected(silence)) continue;
    /*
      Padding is per span, because not every span is a silence.

      `tighten` removes hesitations and abandoned phrases, and its spans come
      from word boundaries in a transcript — they are already exact. Padding one
      by the silence pass's eightieth of a second leaves the first and last
      fraction of an "um" in the video, which is audible as a click rather than
      as a word. Amplitude-detected silences still need theirs.
    */
    const pad = silence.pad ?? padding;
    const opensTheFile = silence.start <= EDGE;
    const closesTheFile = silence.end >= duration - EDGE;
    const start = opensTheFile ? 0 : Math.max(0, silence.start + pad);
    if (start > cursor) kept.push({ start: cursor, end: start });
    cursor = closesTheFile ? duration : Math.max(cursor, Math.min(duration, silence.end - pad));
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
  /**
   * What was said, where the caller has it.
   *
   * Optional because the two oldest readers of this type — the cut snapper and
   * the critic — need only the boundaries and the filler flag. `tighten` needs
   * the word itself, because a sentence started twice can only be recognised by
   * reading it, and the worker has been carrying the text alongside these
   * fields all along without the type saying so.
   */
  text?: string;
  /**
   * Which voice said it, when the transcript was asked for speaker labels.
   *
   * Absent on every plan that did not ask — which is most of them, because
   * diarisation costs more at the provider and a single talking head has one
   * speaker. It is present on a clips plan, where it buys the one boundary a
   * conversation has and a pause does not: the moment the *other* person
   * stopped. See `conversation.ts`.
   */
  speaker?: number;
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

/**
 * A gap between two words long enough to read as the end of a thought.
 *
 * Not punctuation — the recogniser does not give us any, and inventing
 * sentence boundaries from grammar would need a model this stage does not
 * have. It gives us times, and in speech the reliable signal is the breath:
 * words inside a phrase sit tens of milliseconds apart, and a phrase boundary
 * opens a gap you can hear.
 *
 * A third of a second is the shortest gap that is a break rather than a
 * consonant. Below that, ordinary articulation crosses it constantly and every
 * word would be a "sentence start", which is the same as having no boundaries
 * at all.
 */
export const SPEECH_BREAK_SECONDS = 0.35;

/** Where a thought could begin, and where one could end. */
export interface SpeechBreaks {
  /** Word starts that follow a real pause, earliest first. */
  starts: { at: number; gap: number }[];
  /** Word ends that are followed by one. */
  ends: { at: number; gap: number }[];
}

/**
 * The pauses in a transcript, as two lists of times.
 *
 * The first word's start and the last word's end are included with an infinite
 * gap: the beginning and the end of the speech are the strongest boundaries
 * there are, and a clip that starts where the talking starts never needs to be
 * moved.
 */
export function speechBreaks(words: SpokenWord[], minGap = SPEECH_BREAK_SECONDS): SpeechBreaks {
  const spoken = words.filter((w) => w.end > w.start).sort((a, b) => a.start - b.start);
  if (spoken.length === 0) return { starts: [], ends: [] };

  const starts = [{ at: spoken[0].start, gap: Infinity }];
  const ends = [{ at: spoken[spoken.length - 1].end, gap: Infinity }];

  for (let i = 0; i < spoken.length - 1; i += 1) {
    const gap = spoken[i + 1].start - spoken[i].end;
    if (gap >= minGap) {
      ends.push({ at: spoken[i].end, gap });
      starts.push({ at: spoken[i + 1].start, gap });
    }
  }

  starts.sort((a, b) => a.at - b.at);
  ends.sort((a, b) => a.at - b.at);
  return { starts, ends };
}

/**
 * Move a chosen window onto the edges of the speech inside it.
 *
 * The scorer that picks a window is looking for where the talking is densest,
 * and it starts windows on word starts — so the boundary never lands inside a
 * word. That is not the same as landing in a sensible place. A word start in
 * the middle of a sentence is still the middle of a sentence, and a clip that
 * opens on "...and that's why I think" is the single most obvious way an
 * automatic edit announces itself. The right edge is worse: it is wherever
 * `start + the length they asked for` happened to fall.
 *
 * So both edges move to the nearest real pause, within a budget. The budget is
 * what keeps this honest: somebody asked for thirty seconds, and a clip that
 * silently became forty-one because the sentences were long is not the thing
 * they asked for. Inside the budget the *strongest* pause wins rather than the
 * nearest one — a two-second silence is a better place to cut than a
 * four-hundred-millisecond one, and both are equally allowed.
 *
 * The length is then held from the moved start, not from the original: the ask
 * is a duration, so a start that moved back by a second takes its end with it
 * rather than eating a second of the clip.
 *
 * Returns the window unchanged when there is no transcript, when nothing
 * qualifies inside the budget, or when the result would be shorter than half
 * what was asked for — the last because a clip cut down to nothing is worse
 * than one that begins mid-sentence, and this function exists to improve a
 * clip rather than to have an opinion at any price.
 */
export function snapToSpeechBreaks(
  window: Segment,
  words: SpokenWord[] | undefined,
  options: { driftSeconds: number; duration: number; notBefore?: number },
): Segment {
  const asked = window.end - window.start;
  if (!words || words.length === 0 || asked <= 0) return window;

  const { starts, ends } = speechBreaks(words);
  if (starts.length === 0) return window;

  const drift = Math.max(0, options.driftSeconds);
  const floor = options.notBefore ?? 0;

  /** The strongest boundary within `drift` of `target`; null if there is none. */
  const nearest = (list: { at: number; gap: number }[], target: number, lowest: number, highest: number) => {
    let best: { at: number; gap: number } | null = null;
    for (const candidate of list) {
      if (candidate.at < lowest || candidate.at > highest) continue;
      if (Math.abs(candidate.at - target) > drift) continue;
      // Strongest first; among equals, the one that moves the edge least.
      if (
        best === null ||
        candidate.gap > best.gap + 1e-9 ||
        (Math.abs(candidate.gap - best.gap) < 1e-9 &&
          Math.abs(candidate.at - target) < Math.abs(best.at - target))
      ) {
        best = candidate;
      }
    }
    return best;
  };

  const startAt = nearest(starts, window.start, floor, options.duration)?.at ?? window.start;
  const wantedEnd = Math.min(options.duration, startAt + asked);
  const endAt = nearest(ends, wantedEnd, startAt, options.duration)?.at ?? wantedEnd;

  const moved = { start: Math.max(floor, startAt), end: Math.min(options.duration, endAt) };
  if (moved.end - moved.start < asked / 2) return window;
  return moved;
}
