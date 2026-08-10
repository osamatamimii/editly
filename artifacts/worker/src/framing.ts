/**
 * Choosing where the 9:16 window goes.
 *
 * Turning a landscape take into a vertical one throws away most of the width.
 * Doing it by cropping to the centre — which is what this did, and what every
 * cheap tool does — works only when the subject happens to be centred. When the
 * speaker sits on the left third of an interview frame, a centre crop delivers
 * their shoulder. It is the single most recognisable tell of an automatic edit,
 * and it is a framing mistake, not a technical one.
 *
 * Doing it properly needs to know where the subject is, and the honest way to
 * get that at 30 frames a second is local vision on our own machine — not an
 * API, which cannot return a box per frame at any sane price. That work is
 * still ahead. What this file does in the meantime is not a guess: it measures
 * where the picture's detail and movement actually live, and puts the window
 * there.
 *
 * Two properties matter more than the accuracy of the measurement:
 *
 * The window does not move. One position for the clip, chosen once. A crop that
 * chases the subject frame by frame reads as a camera operator who has had too
 * much coffee, and is far worse than a slightly off crop that holds still.
 *
 * It only moves off centre when the evidence is clear. If the best window is
 * not meaningfully better than the middle, we take the middle. A confidently
 * wrong reframe is worse than a neutral one, because the neutral one is at
 * least what the person shooting expected.
 */
import { spawn } from "node:child_process";

/** Columns the frame is reduced to. Enough to place a person, cheap to read. */
export const COLUMNS = 64;
const ROWS = 36;

/** Frames a second sampled. Framing does not change faster than this. */
const SAMPLE_FPS = 4;

/** Seconds of footage examined. Where the subject sits is decided early. */
const MAX_SAMPLE_SECONDS = 90;

/**
 * How much better than the centre a window must score before we move.
 * Below this the measurement is noise and the middle is the safer answer.
 */
const CONFIDENCE_MARGIN = 1.15;

/**
 * Movement counts for more than detail. A patterned curtain has edges all day
 * and never earns the frame; a person talking moves, and that is the subject.
 */
const MOTION_WEIGHT = 2;

export interface InterestProfile {
  /** One score per column, left to right. Unnormalised. */
  columns: number[];
  /** How many sampled frames went into it. */
  frames: number;
}

/**
 * Reads the clip at a tiny resolution and reports how interesting each vertical
 * strip is. Greyscale, 64x36, four frames a second — about half a megabyte for
 * a minute and a half of video, and it never leaves the machine.
 */
export function measureInterest(file: string, seconds = MAX_SAMPLE_SECONDS): Promise<InterestProfile> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", [
      "-hide_banner", "-nostdin", "-loglevel", "error",
      "-t", String(seconds),
      "-i", file,
      "-an",
      "-vf", `fps=${SAMPLE_FPS},scale=${COLUMNS}:${ROWS}:flags=area,format=gray`,
      "-f", "rawvideo", "-",
    ]);

    const chunks: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.on("error", reject);
    child.on("close", () => {
      try {
        resolve(profileFrom(Buffer.concat(chunks)));
      } catch (error) {
        reject(error);
      }
    });
  });
}

/** Pulled out so the scoring can be tested against frames we construct by hand. */
export function profileFrom(raw: Buffer): InterestProfile {
  const frameSize = COLUMNS * ROWS;
  const frames = Math.floor(raw.length / frameSize);
  const columns = new Array<number>(COLUMNS).fill(0);
  if (frames === 0) return { columns, frames: 0 };

  const detail = new Array<number>(COLUMNS).fill(0);
  const motion = new Array<number>(COLUMNS).fill(0);

  for (let f = 0; f < frames; f += 1) {
    const base = f * frameSize;
    const previous = f > 0 ? base - frameSize : -1;

    for (let r = 0; r < ROWS; r += 1) {
      const row = base + r * COLUMNS;
      for (let c = 0; c < COLUMNS; c += 1) {
        const here = raw[row + c];

        // Horizontal gradient: how much is going on at this strip.
        const left = raw[row + Math.max(0, c - 1)];
        const right = raw[row + Math.min(COLUMNS - 1, c + 1)];
        detail[c] += Math.abs(right - left);

        // Change since the last sample: how much this strip is doing.
        if (previous >= 0) motion[c] += Math.abs(here - raw[previous + r * COLUMNS + c]);
      }
    }
  }

  const samples = frames * ROWS;
  for (let c = 0; c < COLUMNS; c += 1) {
    columns[c] = detail[c] / samples + (MOTION_WEIGHT * motion[c]) / Math.max(1, samples - ROWS);
  }

  return { columns, frames };
}

export interface CropChoice {
  /** Centre of the window as a fraction of source width, 0..1. */
  center: number;
  /** True when the measurement was strong enough to move off centre. */
  moved: boolean;
  /** How much better the chosen window scored than the middle. */
  advantage: number;
}

/**
 * Picks the window. `windowFraction` is how much of the source width the crop
 * covers — 0.32 for a 9:16 window out of a 16:9 frame.
 */
export function chooseCropCenter(profile: InterestProfile, windowFraction: number): CropChoice {
  const width = Math.max(1, Math.min(COLUMNS, Math.round(windowFraction * COLUMNS)));
  const still = { center: 0.5, moved: false, advantage: 1 };

  if (profile.frames === 0 || width >= COLUMNS) return still;

  const total = profile.columns.reduce((a, b) => a + b, 0);
  if (total <= 0) return still;

  const sumFrom = (start: number) => {
    let sum = 0;
    for (let c = start; c < start + width; c += 1) sum += profile.columns[c];
    return sum;
  };

  let bestStart = 0;
  let bestScore = -Infinity;
  for (let start = 0; start + width <= COLUMNS; start += 1) {
    const score = sumFrom(start);
    if (score > bestScore) {
      bestScore = score;
      bestStart = start;
    }
  }

  const centreStart = Math.round((COLUMNS - width) / 2);
  const centreScore = sumFrom(centreStart);
  const advantage = centreScore > 0 ? bestScore / centreScore : Infinity;

  if (advantage < CONFIDENCE_MARGIN) return { center: 0.5, moved: false, advantage };

  return { center: (bestStart + width / 2) / COLUMNS, moved: true, advantage };
}

/**
 * Where to start the crop, in pixels, on the scaled image ffmpeg will produce.
 *
 * Clamped to the image, and snapped to an even number because the chroma planes
 * of 4:2:0 are half resolution and an odd offset makes the encoder resample
 * them — a small, free way to lose sharpness on every reframed clip.
 */
export function cropOffsetX(
  choice: CropChoice,
  scaledWidth: number,
  cropWidth: number,
): number {
  const ideal = choice.center * scaledWidth - cropWidth / 2;
  const clamped = Math.max(0, Math.min(scaledWidth - cropWidth, ideal));
  return Math.round(clamped / 2) * 2;
}

/**
 * The scale ffmpeg applies with `force_original_aspect_ratio=increase`: enough
 * to cover the crop in both directions, which is the larger of the two ratios.
 */
export function coverScale(
  source: { width: number; height: number },
  crop: { width: number; height: number },
): number {
  return Math.max(crop.width / source.width, crop.height / source.height);
}
