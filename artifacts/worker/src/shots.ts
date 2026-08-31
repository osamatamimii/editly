/**
 * One camera made to look like two.
 *
 * Everything this renderer does to the frame happens at one focal length. The
 * window is placed well — `framing.ts` finds where the person is and follows
 * them — but it is the same width in the last frame as in the first, and that
 * is the difference a viewer reads as "cut by a machine". The first thing a
 * human editor does after making a cut is come back closer, and the second is
 * go back out. A single-camera recording becomes a two-camera interview by
 * nothing more than that.
 *
 * ## Why it is free
 *
 * The renderer already crops wider than the frame it delivers whenever
 * something is going to move — `MOTION_OVERSCAN`, 1.15 — so that a zoom is a
 * downscale of pixels already in hand rather than an upscale of pixels that
 * are not. That margin is cropped and thrown away on every render that has any
 * motion in it. This spends it: the *tight* size is exactly the frame that was
 * asked for, native, and the *wide* size is that frame plus the margin. No
 * upscaling is introduced at either size, and at the default amount the crop
 * is not even a different size than it is today.
 *
 * That is also why the wide size is the opening one. The margin is closer to
 * what the camera actually saw, and the first thing a viewer is shown should
 * be the frame the person shooting chose, not our accent on it.
 *
 * ## Why a step and not a ramp
 *
 * `zoomPunch` eases in over a quarter of a second, and that is right for what
 * it does: the movement *is* the emphasis, and a punch that arrived instantly
 * would read as a glitch. Here the movement is the fault. The whole illusion is
 * that a second camera was already running at that size — so the new size has
 * to be there in the first frame of the new shot, with nothing travelling
 * between them. A ramp across a cut is one camera zooming, which is the thing
 * this is supposed to replace.
 *
 * ## Every threshold points at doing nothing
 *
 * A size change that lands wrong is worse than no size change at all, because
 * a viewer who notices the framing has stopped watching the video. So each
 * rule below refuses rather than permits, and the file is a set of reasons not
 * to act:
 *
 * - **A shot under 1.2 seconds is a glimpse, not a shot.** Changing size for
 *   something that brief is a flicker.
 * - **The size holds for at least two seconds.** Two changes in quick
 *   succession are not coverage, they are a fault in the file.
 * - **Under three shots there is nothing to alternate with.** Two pieces are
 *   one join, and a size change across a single join has no pattern to belong
 *   to: it reads as an export that went wrong halfway.
 * - **If the tight size holds more than 60% of the running time it is not an
 *   accent, it is the frame** — so the sizes are swapped and the accent becomes
 *   the wide one.
 * - **A shot too short to change inherits the previous size rather than being
 *   skipped.** Skipping it would leave the size changing *inside* a glimpse and
 *   changing back out of it, which is the flutter the first rule exists to
 *   prevent, reintroduced by the mechanism meant to avoid it.
 *
 * The functions here are pure. They take numbers and return numbers, so the
 * suite that checks them needs no ffmpeg, no video and no clock — which is the
 * only way a rule like "not more than one change every two seconds" gets
 * checked at all, rather than being a sentence in a comment.
 */
import type { Segment } from "./timeline";

/** Shorter than this is a glimpse. The size it is shown at is not a decision. */
export const MIN_SHOT_SECONDS = 1.2;

/** However the cuts fall, the size changes at most this often. */
export const MIN_SIZE_HOLD_SECONDS = 2;

/** Below this many pieces there is no pattern for a size change to belong to. */
export const MIN_SHOTS = 3;

/** Past this share of the running time, the tight size has become the frame. */
export const TIGHT_CEILING = 0.6;

export type ShotSize = "wide" | "tight";

/** A stretch between two joins, on the edited clock. */
export interface Shot {
  start: number;
  end: number;
}

/** A stretch of the finished video held at one size. */
export interface Take {
  from: number;
  to: number;
  size: ShotSize;
}

/**
 * Where the joins are, in the finished video.
 *
 * On the edit's clock, not the source's — which is the mistake this repository
 * has already made once, in the reframe, where a crop keyframed on source
 * seconds followed the speaker seventy seconds late and the note said it had
 * followed them. The arithmetic is the same one the critic uses to keep a punch
 * clear of a splice: the kept spans summed as they play, less the overlap each
 * join eats when the cuts dissolve rather than jump.
 */
export function shotsFrom(
  kept: Segment[] | null,
  overlap: number,
  duration: number,
): Shot[] {
  if (!(duration > 0)) return [];
  if (!kept || kept.length < 2) return [{ start: 0, end: duration }];

  const bounds = [0];
  let elapsed = 0;
  for (let i = 0; i < kept.length - 1; i += 1) {
    elapsed += kept[i].end - kept[i].start;
    const join = elapsed - (i + 1) * Math.max(0, overlap);
    // A join that has collapsed onto the one before it, or that sits past the
    // end, is not a join anybody can see. Dropping it here keeps every shot a
    // real stretch of time, so nothing downstream has to defend itself against
    // a zero-length one.
    if (join > bounds[bounds.length - 1] + 0.001 && join < duration - 0.001) {
      bounds.push(join);
    }
  }
  bounds.push(duration);

  const shots: Shot[] = [];
  for (let i = 0; i < bounds.length - 1; i += 1) {
    shots.push({ start: bounds[i], end: bounds[i + 1] });
  }
  return shots;
}

/**
 * The shots, sized, merged into the stretches the renderer will hold.
 *
 * Returns an empty list for "leave the frame alone", which is a real and
 * frequent answer: too few pieces, or no piece long enough to earn a change.
 * The caller says so in the render notes rather than reporting an edit that did
 * not happen.
 */
export function alternateShots(shots: Shot[]): Take[] {
  if (shots.length < MIN_SHOTS) return [];

  const sizes: ShotSize[] = [];
  let current: ShotSize = "wide";
  let lastChange = shots[0].start;

  for (let i = 0; i < shots.length; i += 1) {
    const shot = shots[i];
    if (i > 0) {
      const longEnough = shot.end - shot.start >= MIN_SHOT_SECONDS;
      const held = shot.start - lastChange >= MIN_SIZE_HOLD_SECONDS;
      if (longEnough && held) {
        current = current === "wide" ? "tight" : "wide";
        lastChange = shot.start;
      }
    }
    sizes.push(current);
  }

  const total = shots[shots.length - 1].end - shots[0].start;
  const heldAt = (size: ShotSize): number =>
    shots.reduce((sum, shot, i) => sum + (sizes[i] === size ? shot.end - shot.start : 0), 0);

  if (total > 0 && heldAt("tight") / total > TIGHT_CEILING) {
    for (let i = 0; i < sizes.length; i += 1) sizes[i] = sizes[i] === "tight" ? "wide" : "tight";
    /*
      The opening is not part of the swap.

      Inverting is the right correction — a size that holds two thirds of the
      video is the frame and not the accent — but it lands the video on its
      accent, and the first thing anybody sees has to be the frame that was
      shot. Forcing the opening back out can only reduce the tight share
      further, so it cannot undo the correction it follows.
    */
    sizes[0] = "wide";
  }

  // One size for the whole video is not an alternation, it is a crop. Every
  // rule above can produce this, and each time it means the material did not
  // support the idea.
  if (sizes.every((size) => size === sizes[0])) return [];

  const takes: Take[] = [];
  for (let i = 0; i < shots.length; i += 1) {
    const last = takes[takes.length - 1];
    if (last && last.size === sizes[i]) last.to = shots[i].end;
    else takes.push({ from: shots[i].start, to: shots[i].end, size: sizes[i] });
  }
  return takes;
}

/** The whole decision, from what the renderer already knows about the cut. */
export function takesFrom(
  kept: Segment[] | null,
  overlap: number,
  duration: number,
): Take[] {
  return alternateShots(shotsFrom(kept, overlap, duration));
}

/**
 * How much wider the crop has to be for the wide size to exist inside it.
 *
 * At the default `amount` this is the overscan the renderer already takes, so
 * the crop is not one pixel different from what it is today. Ask for more than
 * the margin and the margin grows to hold it, which is the only thing that
 * costs anything here: a wider crop is scaled from further into the source.
 */
export function overscanFor(motionOverscan: number, amount: number): number {
  return Math.max(motionOverscan, 1 + Math.max(0, amount));
}

/**
 * The zoom multiplier for a size, relative to the frame that was asked for.
 *
 * Tight is 1: exactly the delivered frame, native pixels, what every render
 * does today. Wide is below 1, pulling back into the overscan by `amount` —
 * which is why nothing here can upscale. The renderer multiplies these by the
 * base zoom, so a wide take is the only term in the zoom expression that is
 * ever negative.
 */
export function scaleFor(size: ShotSize, amount: number): number {
  return size === "tight" ? 1 : 1 / (1 + Math.max(0, amount));
}
