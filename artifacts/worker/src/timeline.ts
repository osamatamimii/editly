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
 * Where a moment in the original lands after the cuts. Moments inside a removed
 * stretch collapse onto the cut point, which is where a caption for them
 * belongs.
 */
export function remapTime(seconds: number, kept: Segment[]): number {
  let elapsed = 0;
  for (const segment of kept) {
    if (seconds < segment.start) return elapsed;
    if (seconds <= segment.end) return elapsed + (seconds - segment.start);
    elapsed += segment.end - segment.start;
  }
  return elapsed;
}
