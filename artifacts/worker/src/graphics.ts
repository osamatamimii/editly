/**
 * Where a reference draws something on the frame, and how it arrived.
 *
 * `style-measure.ts` reads a reference as arithmetic over the whole file: how
 * often it cuts, how loud it ends up, how saturated the grade is. Every number
 * in it is true of the video as a *whole*, and none of them can say the thing a
 * person actually points at when they hand you a video they like — that at
 * three seconds a card comes up from the bottom carrying two words, and at
 * eleven a phone slides in from the right.
 *
 * This reads that. Not what the card says — that is a question for a model with
 * eyes, and it is asked one step later, on three or four stills instead of on a
 * whole video. This answers the two questions that are *measurable*, and that a
 * model asked to guess them gets wrong in a way nobody can check:
 *
 *   **Where** — which rectangle of the frame the thing occupies, in fractions,
 *   and between which seconds it is on screen.
 *
 *   **How** — which way it travelled in, how far, and whether it scaled or
 *   simply appeared. Direction and distance over four samples are arithmetic.
 *
 * ## The discriminator
 *
 * The whole file turns on one distinction, and everything else is thresholds
 * around it:
 *
 *   **A cut changes the whole frame. A graphic changes a part of it while the
 *   rest holds still.**
 *
 * Five rules stand between a difference and a composition, and each one exists
 * for a case that only it refuses:
 *
 *   - **not the whole frame** — a cut, and a dissolve, replace everything.
 *   - **it took time to arrive** — a cut between two similar shots is complete
 *     in one sample; anything drawn takes several.
 *   - **it came to rest** — a pan, a drift, a background loop never stop.
 *   - **it held** — a flash is not a graphic.
 *   - **it is not the picture coming back** — read forwards only, every
 *     graphic is found twice, once arriving and once leaving.
 *
 * ## What it will not find, said plainly
 *
 * A graphic drawn over a picture that is moving while it arrives. A caption
 * dropped onto a handheld walking shot is a real thing that real references
 * do, and this will not report it: from a difference between two frames, a
 * band arriving over a moving picture and the picture simply moving are the
 * same evidence, and the only way to tell them apart is to look — which is the
 * step after this one and costs a model call per candidate.
 *
 * So the scope is deliberate: **the picture holds still while the thing is
 * drawn**. That is the section card on a plate, the device on a flat ground,
 * the kinetic line over a wash — which is what the references are made of, and
 * what the layer language exists to replay. A shortlist that is small and right
 * is worth more than a long one somebody has to check.
 *
 * ## Why a squashed grid
 *
 * Every frame is scaled to a fixed square grid regardless of the reference's
 * aspect, so a cell is always the same fraction of the frame in both axes and a
 * box measured off a 9:16 reference can be replayed on a 16:9 render without a
 * conversion anywhere. That is also the coordinate system `LayerBox` already
 * uses. The squashing costs nothing: nothing here reads shape, only change.
 */
import { spawn } from "node:child_process";
import { guard, LIMITS } from "./deadline";

/**
 * Cells on a side. 48 makes a cell just over two per cent of the frame in each
 * axis — fine enough to put an edge on a lower third, coarse enough that a
 * compression block or a grain pattern never becomes a graphic.
 */
export const GRID = 48;

/**
 * Samples a second.
 *
 * One number serving two purposes, which is why it is neither of the obvious
 * ones. Detection wants as few as possible: four a second finds every graphic
 * that is on screen long enough to read. Measuring the *entrance* wants as many
 * as possible: a spring settles in about 420 ms, and four samples a second sees
 * two of them and cannot tell a rise from an appearance.
 *
 * Twenty a second gives an entrance eight samples and costs 2304 bytes a frame
 * — about five megabytes for the two-minute window, which is smaller than the
 * frame the decoder is already holding.
 */
export const SAMPLE_FPS = 20;

/** The window read, in seconds. A reference states its language early or not at all. */
export const MAX_SAMPLE_SECONDS = 120;

/**
 * A cell counts as changed above this, on the 0..255 scale.
 *
 * Under it lies everything that changes in a still frame for reasons that are
 * not the edit: sensor noise, film grain, the dither of a gradient, the ringing
 * around text after compression. Measured on a static colour rendered by x264
 * at crf 18, cell-to-cell drift stays under 4; on real footage of a person
 * holding still it reaches 7.
 */
const CELL_NOISE = 10;

/**
 * Above this share of the grid changing, it is a cut and not a drawing.
 *
 * A full-frame section card is the hard case here: it covers everything, so on
 * the frame it lands it changes everything, exactly like a cut. What separates
 * them is that a card *arrives over several samples* and a cut does not — so
 * the share below is deliberately generous, and the arrival test is what
 * actually refuses cuts. See `arrives`.
 */
const CUT_SHARE = 0.9;

/** Below this there is no graphic, only noise that cleared the cell threshold. */
const MIN_CELLS = 12;

/**
 * The fewest samples an arrival may take, at `SAMPLE_FPS`.
 *
 * Two, which is a tenth of a second, and it is the whole of what separates a
 * drawn thing from a hard cut between two shots that resemble each other. A cut
 * is complete in one sample by definition; anything drawn — a slide, a scale, a
 * ramp in opacity — takes several, because that is what makes it a movement
 * rather than a replacement.
 *
 * The cost of the rule is a graphic that simply appears, with no entrance at
 * all: it is refused, because it is not distinguishable from a cut by anything
 * measurable. That is the safer of the two errors — a missed card costs a line
 * in a shortlist, an invented one costs a composition replayed from a cut.
 */
const MIN_ARRIVAL_SAMPLES = 2;

/** A graphic holds. Anything shorter is a flicker, a flash frame, or a hand. */
const MIN_HOLD_SECONDS = 0.4;

/**
 * The longest an entrance is looked for.
 *
 * Past this the thing is not arriving, it is moving — a background loop, a
 * scrolling ticker, a subject crossing frame. Those are not compositions and
 * replaying them as one would be a lie about what the reference does.
 */
const MAX_ENTRANCE_SECONDS = 1.2;

/**
 * How far a region must travel to be called a travel rather than an appearance,
 * as a fraction of the frame.
 *
 * A cell is 1/48 of the frame, so anything under one cell is unmeasurable here
 * and is reported as the entrance that does not move.
 */
const MIN_TRAVEL = 1 / GRID;

export type Entrance = "rise" | "drop" | "settle" | "fade";

export interface DrawnBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DrawnMoment {
  /** Seconds into the reference where the thing begins to arrive. */
  at: number;
  /** Seconds where it is fully arrived and holding still. */
  settledAt: number;
  /**
   * Seconds where it leaves, or null when it was still on screen at the end of
   * the window — which is not the same thing and must not be reported as one.
   */
  leavesAt: number | null;
  /** Where it sits once settled, in fractions of the frame. */
  box: DrawnBox;
  /** Which way it came in. */
  enter: Entrance;
  /** How far it travelled, as a fraction of the frame. 0 for settle and fade. */
  travel: number;
}

export interface GraphicsRead {
  moments: DrawnMoment[];
  /** Seconds of reference actually examined. */
  sampledSeconds: number;
  /**
   * False when nothing could be read — no video stream, or a stream the sampler
   * produced no frames from. An empty `moments` with this true means the
   * reference genuinely draws nothing, which is a real and common answer and a
   * different one from "we could not look".
   */
  measured: boolean;
}

/* ── The reading, which is all arithmetic over a small grid ─────────────────
 *
 * Split from the ffmpeg call on purpose: every threshold above is checked
 * against grids built by hand in the tests, where a frame is nine lines of
 * code and the expected answer is not in doubt. A test that has to render a
 * video to check a threshold is a test that gets deleted the first time it is
 * slow.
 */

const CELLS = GRID * GRID;

/** Cells that differ by more than the noise floor, as a flat boolean grid. */
function changedCells(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(CELLS);
  for (let i = 0; i < CELLS; i += 1) {
    out[i] = Math.abs((b[i] ?? 0) - (a[i] ?? 0)) > CELL_NOISE ? 1 : 0;
  }
  return out;
}

function countOf(mask: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < CELLS; i += 1) n += mask[i] ?? 0;
  return n;
}

/** The smallest rectangle holding every set cell, in fractions of the frame. */
export function boxOf(mask: Uint8Array): DrawnBox | null {
  let minX = GRID;
  let minY = GRID;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < GRID; y += 1) {
    for (let x = 0; x < GRID; x += 1) {
      if ((mask[y * GRID + x] ?? 0) === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return {
    x: minX / GRID,
    y: minY / GRID,
    w: (maxX - minX + 1) / GRID,
    h: (maxY - minY + 1) / GRID,
  };
}

/** The centre of a box, in fractions. */
function centreOf(box: DrawnBox): { x: number; y: number } {
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

/**
 * Reads one arrival: the frames from the first change until the picture holds
 * still again, and what they say about how the thing got there.
 *
 * The four entrances are told apart by what the box does across the burst, and
 * each test is the one that distinguishes it from the others rather than the
 * one that describes it:
 *
 *   - the box *moves* and ends higher than it began → `rise`
 *   - the box moves and ends lower → `drop`
 *   - the box *grows* from near its own centre → `settle`
 *   - the box is its final size from the first sample → `fade`
 *
 * `fade` is last because it is what is left, and that is honest: a thing that
 * neither moved nor grew either faded in or appeared instantly, and at twenty
 * samples a second those are the same reading. Replaying an instant appearance
 * as a fade is the smaller error of the two, and it is the one a viewer does
 * not notice.
 */
export function readEntrance(boxes: DrawnBox[]): { enter: Entrance; travel: number } {
  const first = boxes[0];
  const last = boxes[boxes.length - 1];
  if (!first || !last || boxes.length < 2) return { enter: "fade", travel: 0 };

  const from = centreOf(first);
  const to = centreOf(last);
  const dy = to.y - from.y;
  const dx = to.x - from.x;
  const travel = Math.hypot(dx, dy);

  if (travel >= MIN_TRAVEL && Math.abs(dy) >= Math.abs(dx)) {
    return { enter: dy < 0 ? "rise" : "drop", travel };
  }

  // Growth, measured against the settled size rather than against the first
  // sample: a box that starts at a third of its final size and reaches it is a
  // scale-in whatever it did sideways on the way.
  const grew = first.w * first.h < last.w * last.h * 0.7;
  if (grew) return { enter: "settle", travel: 0 };

  return { enter: "fade", travel: travel >= MIN_TRAVEL ? travel : 0 };
}

/**
 * The whole reading, over a list of grids taken at a known rate.
 *
 * Written as a scan with one thing in flight at a time. A reference that draws
 * two things at once — a card and a pill under it — reports them as one box,
 * and that is the right answer rather than a limitation: they arrived together
 * and they are one composition. What it will not do is merge two things that
 * arrive a second apart, because the second one arrives over a background that
 * now contains the first, and the first is therefore not changing.
 */
export function momentsFrom(frames: Uint8Array[], fps = SAMPLE_FPS): DrawnMoment[] {
  const moments: DrawnMoment[] = [];
  const at = (index: number): number => index / fps;
  const maxEntranceFrames = Math.max(2, Math.round(MAX_ENTRANCE_SECONDS * fps));
  const minHoldFrames = Math.max(1, Math.round(MIN_HOLD_SECONDS * fps));

  /** The picture as it stood before the last thing that happened to it. */
  let quiet = frames[0] ?? new Uint8Array(CELLS);

  let i = 1;
  while (i < frames.length) {
    const before = frames[i - 1];
    const now = frames[i];
    if (!before || !now) break;

    const change = changedCells(before, now);
    const changed = countOf(change);
    if (changed < MIN_CELLS || changed > CELLS * CUT_SHARE) {
      i += 1;
      continue;
    }

    /*
      The arrival, gathered against the frame *before* it started.

      Against the previous frame rather than the first one is the mistake that
      looks right: a card that has finished moving stops differing from the
      frame before it, so the region shrinks to nothing at exactly the moment
      it is fully arrived, and every box read that way is the box of the last
      few pixels still in motion. Every box in the burst is therefore measured
      against `before`, which is the picture as it was with nothing drawn on
      it.
    */
    const boxes: DrawnBox[] = [];
    let settle = i;
    let rested = false;
    for (let j = i; j < Math.min(frames.length, i + maxEntranceFrames); j += 1) {
      const frame = frames[j];
      if (!frame) break;
      const against = changedCells(before, frame);
      const box = boxOf(against);
      if (!box) break;
      boxes.push(box);
      settle = j;

      // Has it stopped? Two consecutive frames that differ from each other by
      // less than the noise floor over more than a handful of cells.
      const previous = frames[j - 1];
      if (previous && j > i) {
        const moving = countOf(changedCells(previous, frame));
        if (moving < MIN_CELLS) {
          rested = true;
          break;
        }
      }
    }

    /*
      It has to have *stopped*, and running out of patience is not stopping.

      Without this the loop settles by timeout, and anything that keeps moving
      for longer than an entrance is reported as a graphic that arrived over
      the whole window: a pan, a handheld drift, a background loop. Measured on
      a drifting plate with no graphic on it at all, this produced one moment
      with a box of the whole frame and an entrance of `fade` — a composition
      invented out of a camera move, which is the worst thing this file could
      hand to the step that replays what it finds.

      The stillness test cannot catch that one: a full-frame region has no
      background to be still, so it scores a perfect 1. These two rules are
      therefore not variations on each other — one says the rest of the frame
      held, the other says the thing itself stopped — and a picture that never
      stops fails only the second.
    */
    if (!rested) {
      quiet = before;
      i = settle + 1;
      continue;
    }

    const settled = boxes[boxes.length - 1];
    if (!settled) {
      i += 1;
      continue;
    }

    const settledMask = changedCells(before, frames[settle] ?? now);
    if (countOf(settledMask) < MIN_CELLS) {
      i += 1;
      continue;
    }

    /*
      And it took time to arrive, which a cut does not.

      `rested` above refuses everything that never stops. This refuses the
      opposite: a picture that was already stopped one sample after it changed,
      which is the definition of a cut. Two shots similar enough to leave a
      tenth of the frame unchanged slip past the share test above and land here
      instead, as a full-frame graphic with an entrance of `fade` and a
      duration of the rest of the video.
    */
    if (settle - i < MIN_ARRIVAL_SAMPLES) {
      quiet = before;
      i = settle + 1;
      continue;
    }

    /*
      And did it stay? A graphic holds; a flash does not.

      "Stayed" is measured as still differing from `before` in most of the
      cells it claimed — not as "nothing changed since", which a caption with a
      blinking cursor in it would fail.
    */
    const claimed = countOf(settledMask);
    let leaves: number | null = null;
    let held = 0;
    for (let j = settle + 1; j < frames.length; j += 1) {
      const frame = frames[j];
      if (!frame) break;
      const still = countOf(changedCells(before, frame));
      if (still < claimed * 0.5) {
        leaves = at(j);
        break;
      }
      held += 1;
    }
    /*
      `held` and not `leaves === null`.

      A graphic that is still on screen when the window ends has not been shown
      to hold — it has been shown not to have left yet, which is the same
      sentence a single flash frame at the last sample can say. Requiring the
      frames outright costs one moment drawn in the final four hundred
      milliseconds of a two-minute read, and refuses every flash.
    */
    if (held < minHoldFrames) {
      // Remembered even though it was refused: what this rejects is a flash,
      // and a flash going out is the very thing the rule above must catch.
      quiet = before;
      i = settle + 1;
      continue;
    }

    /*
      A picture coming back is not a picture being drawn on.

      Nothing in a difference between two frames says which way round it
      happened: a card appearing over a grey ground and the same card leaving
      it are the same rectangle changing by the same amount. Read forwards
      only, every graphic is found twice — once arriving and once, a beat
      later, as the ground "arriving" over it. The flash test caught this: a
      shape shown for a tenth of a second was correctly refused for not
      holding, and then its own disappearance was accepted as a graphic that
      holds for the rest of the video.

      What distinguishes them is memory. `quiet` is the picture as it stood
      before the last thing happened to it; a candidate whose settled frame
      matches it is that thing going away rather than a
      new thing arriving.
    */
    const returned = countOf(changedCells(quiet, frames[settle] ?? now)) < MIN_CELLS;
    quiet = before;
    if (returned) {
      i = settle + 1;
      continue;
    }

    const { enter, travel } = readEntrance(boxes);
    moments.push({
      at: at(i - 1),
      settledAt: at(settle),
      leavesAt: leaves,
      box: settled,
      enter,
      travel,
    });

    // Past the end of this one. Nothing that happens inside a graphic's own
    // arrival is a second graphic.
    i = settle + 1;
  }

  return moments;
}

/* ── The reading, off a file ────────────────────────────────────────────── */

/**
 * Samples a reference and reports what it draws.
 *
 * Greyscale, a 48x48 grid, twenty frames a second, two minutes at most — and
 * it never leaves the machine. The model that reads *what* the boxes say gets
 * three or four stills at the moments this found, which is the reason to
 * measure first and ask second: the question is cheap because the answer to
 * "where and when" is already known.
 */
export function readGraphics(
  file: string,
  seconds = MAX_SAMPLE_SECONDS,
): Promise<GraphicsRead> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", [
      "-hide_banner", "-nostdin", "-loglevel", "error",
      "-t", String(seconds),
      "-i", file,
      "-an",
      // `area` rather than the default: a graphic edge falling between cells
      // must lighten both of them, not vanish because bilinear happened to
      // sample beside it.
      "-vf", `fps=${SAMPLE_FPS},scale=${GRID}:${GRID}:flags=area,format=gray`,
      "-f", "rawvideo", "-",
    ]);

    const deadline = guard(child, { ...LIMITS.analysis, what: "reading what the reference draws" });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => {
      deadline.touch();
      chunks.push(d);
    });
    child.on("error", (err) => {
      deadline.clear();
      reject(err);
    });
    child.on("close", () => {
      deadline.clear();
      if (deadline.expired) {
        reject(deadline.error);
        return;
      }
      const raw = Buffer.concat(chunks);
      const count = Math.floor(raw.length / CELLS);
      if (count === 0) {
        resolve({ moments: [], sampledSeconds: 0, measured: false });
        return;
      }
      const frames: Uint8Array[] = [];
      for (let f = 0; f < count; f += 1) {
        frames.push(new Uint8Array(raw.subarray(f * CELLS, (f + 1) * CELLS)));
      }
      resolve({
        moments: momentsFrom(frames),
        sampledSeconds: count / SAMPLE_FPS,
        measured: true,
      });
    });
  });
}
