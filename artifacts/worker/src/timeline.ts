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
    /*
      The cursor cannot go back behind the piece just pushed.

      It was clamped against its own previous value and against the duration,
      and against nothing else — so a padding wider than half a silence put the
      next piece's start *before* the last one's end, and the overlapping
      stretch played, jumped back, and played again. `keepSegmentsFrom(60,
      [{5,5.5},{20,25}], 1.0)` returned `[0,6] [4.5,21] [24,60]`: a second and a
      half of the recording twice. `outputDuration` still summed to less than
      the source, so the "no silence found to remove" guard did not catch it
      either.

      Reachable without anything unusual: the planner takes `minSilenceMs` from
      the model and hard-codes `paddingMs: 80`, so any answer between 100 and
      159 does it — at 60ms of repeated video per cut.
    */
    cursor = closesTheFile
      ? duration
      : Math.min(duration, Math.max(cursor, start, silence.end - pad));
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
export function outputDuration(kept: Segment[], overlap: Overlaps = 0): number {
  const spanned = kept.reduce((sum, s) => sum + (s.end - s.start), 0);
  return spanned - overlapBefore(overlap, Math.max(0, kept.length - 1));
}

/**
 * How long each join runs both shots at once.
 *
 * One number means the same at every join, which is what this was until
 * transitions stopped happening at every join. An array is one entry per join,
 * `kept.length - 1` of them, and a zero in it is a hard cut.
 *
 * Both shapes rather than only the array, because every caller that has a
 * single number would otherwise have to build a list to say a thing it already
 * knows, and a helper that is annoying to call from the simple case is a helper
 * people route around. Passing `0` is the old behaviour exactly.
 */
export type Overlaps = number | readonly number[];

/** The overlap at one join, counting joins from zero. */
export function overlapAt(overlap: Overlaps, join: number): number {
  if (typeof overlap === "number") return overlap;
  return overlap[join] ?? 0;
}

/**
 * Everything the first `joins` joins overlap, added up.
 *
 * The quantity every clock on this timeline is corrected by: a piece is pulled
 * earlier by the sum of the overlaps *before* it, not by its index times one
 * overlap, the moment the overlaps stop being equal. Written once because four
 * files did that multiplication, and four places that each rediscover the same
 * arithmetic are four places for the caption clock to disagree with the file.
 */
export function overlapBefore(overlap: Overlaps, joins: number): number {
  if (joins <= 0) return 0;
  if (typeof overlap === "number") return joins * overlap;
  let sum = 0;
  for (let i = 0; i < joins && i < overlap.length; i += 1) sum += overlap[i] ?? 0;
  return sum;
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
 *
 * It takes a list as readily as a number, and that is not a convenience. Once a
 * transition happens at some seams and not others, "index times overlap" is
 * wrong for every moment after the first hard cut in a transitioned edit, and
 * wrong by a growing amount. There is no version of this where the caller can
 * keep passing one number and be right.
 */
export function remapTime(seconds: number, kept: Segment[], overlap: Overlaps = 0): number {
  // Where each kept stretch lands in the output, in the order the concat will
  // play them — which since the cold open exists is no longer necessarily the
  // order they occur in the source. Each join before a piece pulls it and
  // everything after it earlier by that join's own overlap.
  let elapsed = 0;
  const placed = kept.map((segment, i) => {
    const at = Math.max(0, elapsed - overlapBefore(overlap, i));
    elapsed += segment.end - segment.start;
    return { segment, at };
  });
  const total = Math.max(0, elapsed - overlapBefore(overlap, Math.max(0, kept.length - 1)));

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

/**
 * The shortest stretch that counts as an elision rather than a tidy-up.
 *
 * A transition is punctuation for something taken out. Under a second and a
 * half the two shots either side of a join are recognisably the same moment
 * continuing: the same face, in the same place, in the same light, a breath
 * later. Dissolving there shows a viewer one face melting into the same face
 * slightly displaced, which is the jump dissolve every editing manual warns
 * about and the single most amateur-looking thing a machine editor does.
 *
 * Above it, enough of the recording is gone that the picture either side has
 * genuinely moved on, and the dissolve is doing the job dissolves have done
 * since film: saying that time passed here.
 *
 * It is a threshold about human perception and not about this product, which is
 * why it is a constant with an argument rather than a number read off the plan.
 */
export const SCENE_GAP_SECONDS = 1.5;

/**
 * The least a join can overlap and still be a transition rather than a smear.
 *
 * The contract's own floor for `durationMs`. Below it there is nothing anybody
 * would read as a transition, and the honest answer is that the cut stayed
 * hard.
 */
export const MIN_JOIN_SECONDS = 0.08;

/**
 * The fewest whole frames a join can overlap and still be an overlap.
 *
 * Two. One frame of blend between two shots is a hard cut with one strange
 * frame in the middle of it: nobody reads it as a transition, and on a
 * compressed upload it reads as a decode error. `MIN_JOIN_SECONDS` is the same
 * floor said in the contract's units; this one is the floor the picture has.
 */
const MIN_JOIN_FRAMES = 2;

/**
 * How much of a piece a join is allowed to eat.
 *
 * Two fifths, and it is checked against the *shorter of the two pieces the join
 * sits between* rather than against the shortest piece in the edit. Those are
 * the same number only when every piece is the same length, and the difference
 * is a real defect: one 0.15s sliver anywhere in a forty-cut edit flattened
 * every transition in it to sixty milliseconds, including the ones between
 * pieces ten seconds long. A join is a local fact and it is now measured
 * locally.
 *
 * An interior piece is transitioned into on its way in and out of on its way
 * out, so two fifths leaves a fifth of it on screen by itself. Anything more
 * and the piece is never alone, which is not a transition, it is a smear.
 */
const JOIN_ROOM = 0.4;

/**
 * Which seams are a change of scene rather than a tidying cut.
 *
 * One entry per join, `kept.length - 1` of them, in the order the edit plays.
 *
 * The whole point of this function is that **a transition is not a setting, it
 * is a judgement about a particular seam**. Applying one style uniformly to
 * every join is what a filter does; deciding per join is what an editor does,
 * and the two produce visibly different videos from the same plan. A talking
 * head with forty breaths removed and a dissolve on every one of them looks
 * like a mistake forty times. The same edit with a dissolve only where the
 * recording actually jumped looks edited.
 *
 * Two things make a seam a scene, and both are facts about the kept list rather
 * than guesses about the picture:
 *
 *   **The edit went backwards.** `next.start < previous.end` can only happen
 *   because something reordered the recording: a cold open lifting the hook out
 *   of the middle, reordered highlights, a clip boundary. The viewer is being
 *   moved somewhere else, and that is exactly what a transition is for.
 *
 *   **Enough was taken out.** More than `SCENE_GAP_SECONDS` of source between
 *   the two pieces. Under that the join is a removed breath or a deleted filler
 *   and belongs to the shot it is inside.
 *
 * `everyCut` is the old behaviour, and it stays reachable because somebody
 * asking for a transition on every cut is asking for a thing, not making a
 * mistake — a montage of six-second shots wants one at every seam. It is not
 * the default because the default is what happens to the person who typed
 * "add transitions" and meant "make this look edited".
 */
export function sceneJoins(
  kept: readonly Segment[],
  where: "scenes" | "everyCut" = "scenes",
): boolean[] {
  const joins = Math.max(0, kept.length - 1);
  const out: boolean[] = [];
  for (let i = 0; i < joins; i += 1) {
    if (where === "everyCut") {
      out.push(true);
      continue;
    }
    const before = kept[i]!;
    const after = kept[i + 1]!;
    /*
      Backwards in the source, which only a reorder does.

      The tolerance is a millisecond and not zero because `kept` has been
      rounded onto the frame grid by the time anybody asks, and a piece that
      begins on the exact frame the last one ended on is contiguous rather than
      reordered.
    */
    const wentBack = after.start < before.end - 0.001;
    out.push(wentBack || after.start - before.end >= SCENE_GAP_SECONDS);
  }
  return out;
}

/**
 * The same seams, with a length each: how long every join runs both shots at
 * once, zero where the cut stays hard.
 *
 * Separate from `sceneJoins` because two callers want different halves of the
 * question. An overlapped transition needs both the judgement and the room to
 * make it; a glitch needs only the judgement, because it does not overlap
 * anything and so cannot run out of room. Folding the room test into the
 * predicate would have silently suppressed a glitch between two short pieces,
 * which is a join that costs nothing.
 *
 * Every length that comes back is a whole number of frames on the grid the cut
 * was rounded onto, so that the clock this list builds and the clock in the
 * encoded file are the same clock. See the note where the rounding happens.
 */
export function transitionJoins(
  kept: readonly Segment[],
  {
    seconds,
    where = "scenes",
    fps,
  }: {
    /** What the plan asked for, in seconds. */
    seconds: number;
    where?: "scenes" | "everyCut";
    /**
     * The grid the cut was rounded onto.
     *
     * Required rather than optional: a default here would be a guess about the
     * recording, and the one caller already knows the answer. See the note on
     * the return value for why the grid is not the renderer's business alone.
     */
    fps: number;
  },
): number[] {
  const scenes = sceneJoins(kept, where);
  const cell = 1 / fps;
  return scenes.map((isScene, i) => {
    if (!isScene) return 0;
    // Local room, not global. See JOIN_ROOM.
    const room =
      Math.min(kept[i]!.end - kept[i]!.start, kept[i + 1]!.end - kept[i + 1]!.start) * JOIN_ROOM;
    const length = Math.min(seconds, room);
    if (length < MIN_JOIN_SECONDS) return 0;
    /*
      Down to the frame, never up.

      `xfade` takes its duration in seconds and then overlaps a whole number of
      frames, because frames are the only thing it has. Asking for 0.25s at
      30fps asks for seven and a half of them and gets seven, and the 0.0167s
      nobody asked about is not lost — it is the distance between the clock this
      file hands the captions, the overlays, the b-roll and the sound effects,
      and the clock the encoded file actually keeps. Measured: two three-second
      clips, 0.25s dissolve at 30fps, 173 frames out where the arithmetic here
      predicted 174.6. One join is half a frame of drift and nobody would see
      it; a talking head with eight scene joins in it is a caption arriving a
      tenth of a second after the word, and nothing anywhere reports it.

      So the join is rounded here, once, and every consumer of the list is
      exactly right afterwards. Down rather than to the nearest, because up can
      cross the room test two lines above — the point of which is that a piece
      is never entirely inside its own transitions.
    */
    const frames = Math.floor(length * fps + 1e-6);
    return frames < MIN_JOIN_FRAMES ? 0 : frames * cell;
  });
}
