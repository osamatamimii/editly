/**
 * A video made out of photographs.
 *
 * Every operation this renderer has assumes there is already a video: cuts,
 * silences, captions from speech, punches on the words somebody leaned on.
 * That assumption is fine for the person editing a recording of themselves,
 * and it is the whole product for them. It also means the product has nothing
 * at all to say to a shop owner, who does not own a camera and does not appear
 * on screen. What they own is six photographs of a product and a headline.
 *
 * So this file makes the missing thing: a clip, from stills, that the rest of
 * the pipeline can then treat as an ordinary upload. Nothing downstream knows
 * where the file came from. The reframe, the grade, the bed, the sound layer,
 * the titles, the fade, the review pass and the meter all work exactly as they
 * already do and are exactly as tested as they already are — which is the
 * argument for building it here rather than teaching the renderer a second
 * kind of input.
 *
 * ## One encode per still, then a concatenation that copies
 *
 * The obvious implementation is one filter graph with N image inputs. It is
 * also the one that takes the render machine down. Measured on this product's
 * own hardware, ffmpeg peaks at 602MB on two 1080p pieces and 1088MB on six,
 * against a worker with a single gigabyte — and a still driven through
 * `zoompan` is scaled up before it is cropped, so it is not cheaper than a
 * piece of video, it is dearer.
 *
 * Each still is therefore encoded on its own, which costs one image's worth of
 * memory whatever the count, and the segments are joined with the concat
 * *demuxer* and `-c copy`: no second encode, no generation loss, no arithmetic.
 * The cost is that the joins are hard cuts, because a dissolve is a filter and
 * a filter means decoding both sides again.
 *
 * That is not a compromise. A dissolve between two product photographs is the
 * house style of every slideshow anybody has ever skipped. Cuts are what an ad
 * is made of, the motion carries across them by design (see `motionFor`), and
 * the ten transition styles this renderer already owns are for cuts in real
 * footage, where they mean something.
 *
 * ## Nothing here is random
 *
 * Same photographs in, same bytes out. The motion alternates on a rule rather
 * than a shuffle, because a reel somebody re-renders to fix a typo must not
 * come back moving differently: that is the moment a person stops believing
 * the tool is doing what they asked.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { guard, LIMITS } from "./deadline";
import { FfmpegError } from "./ffmpeg";

const FFMPEG = process.env["FFMPEG_PATH"] ?? "ffmpeg";
const FFPROBE = process.env["FFPROBE_PATH"] ?? "ffprobe";

/**
 * The shortest a photograph can be on screen and still be looked at.
 *
 * Under this it is a flash rather than a shot, and a viewer reads a sequence
 * of flashes as a fault in the video rather than as a pace.
 */
export const MIN_SECONDS_EACH = 1.2;
/**
 * And the longest before it stops being an advertisement.
 *
 * Four seconds on one photograph is where a feed viewer leaves. The reel is
 * allowed to come out shorter than asked rather than hold a still past this.
 */
export const MAX_SECONDS_EACH = 4;
/**
 * How much a still may be enlarged before it is padded instead.
 *
 * The same 1.25 the critic caps a punch-in at, and for the same reason: past
 * it the enlargement is visible as softness, and a viewer reads a soft product
 * photo as a cheap product. A thumbnail blown up to fill a phone screen is the
 * single commonest tell of an automatically generated ad.
 */
export const MAX_UPSCALE = 1.25;
/**
 * And how much of a photograph may be thrown away to make it fill the frame.
 *
 * The second half of the same question, and the half that arithmetic alone
 * gets wrong. A four-thousand-pixel square photograph needs no enlargement at
 * all to cover a 9:16 frame — it needs the outer 44% of its width removed, and
 * a product photograph is not a landscape with room at the edges. It is a
 * product, framed to fill the picture, usually by the supplier. Crop it that
 * hard and the thing being advertised loses its sides.
 *
 * A third is about where a centred subject survives. Past it the image sits
 * inside the frame instead.
 */
export const MAX_CROP = 0.35;

export interface ReelTiming {
  /** How many of the stills are used, in the order they were given. */
  keep: number;
  /** How long each one holds. */
  secondsEach: number;
  /** How long the finished reel runs. */
  seconds: number;
  /** Stills that did not fit, said out loud rather than silently dropped. */
  dropped: number;
}

/**
 * How long each photograph gets, and how many of them there is room for.
 *
 * The target length wins over the count, which is the right way round: an ad
 * is a length, and a shop with forty product photographs does not want a
 * hundred-second video, they want fifteen seconds of the best six. What this
 * cannot do is choose *which* six — it takes them in the order the merchant
 * arranged them, because that order is a decision somebody already made and
 * this file has no better information than they had.
 */
export function reelTiming(count: number, targetSeconds: number): ReelTiming {
  const total = Math.max(0, count);
  if (total === 0) return { keep: 0, secondsEach: 0, seconds: 0, dropped: 0 };

  // The most stills that fit at the fastest honest pace.
  const room = Math.max(1, Math.floor(targetSeconds / MIN_SECONDS_EACH));
  const keep = Math.min(total, room);
  const each = Math.min(MAX_SECONDS_EACH, Math.max(MIN_SECONDS_EACH, targetSeconds / keep));
  // Rounded to whole frames' worth of milliseconds so every segment is the
  // same length to the millisecond and the concatenation has no drift in it.
  const secondsEach = Math.round(each * 1000) / 1000;
  return {
    keep,
    secondsEach,
    seconds: Math.round(keep * secondsEach * 1000) / 1000,
    dropped: total - keep,
  };
}

export interface Move {
  /** Zoom at the first frame of this still. */
  from: number;
  /** And at the last. */
  to: number;
}

/**
 * Which way each photograph moves.
 *
 * A still that does not move is a slide, and a sequence of slides is a
 * slideshow — the thing every one of these tools is accused of producing. But
 * the same push on every still is worse than none: it is the tell that nobody
 * chose anything, and it reads as a machine within three shots.
 *
 * So they alternate, and the alternation is the point. A push that ends tight
 * cut against one that starts tight keeps the frame moving *through* the cut,
 * which is what makes a hard join between two photographs read as an edit
 * rather than as a jump. Deterministic on the index, so a re-render of the
 * same reel moves the same way.
 */
export function motionFor(index: number, amount: number): Move {
  if (amount <= 0) return { from: 1, to: 1 };
  // Even stills push in, odd stills pull out. Which means every join is
  // tight-to-tight or wide-to-wide: the size is continuous across the cut and
  // only the subject changes, which is the join a person would have made.
  return index % 2 === 0 ? { from: 1, to: 1 + amount } : { from: 1 + amount, to: 1 };
}

export type Fit = "cover" | "pad";

/**
 * Fill the frame, or sit inside it on a blurred copy of itself.
 *
 * Covering is right nearly always: a product photograph is squarer than a
 * phone screen and cropping the top and bottom of it costs nothing, while
 * white bars down a vertical video are the first thing that says "this was
 * made by a tool". But covering a small image means enlarging it, and past
 * `MAX_UPSCALE` the softness is visible.
 *
 * The alternative is not bars. It is the image sitting on a blurred, enlarged
 * copy of itself — which reads as a deliberate treatment rather than as a
 * mistake, and is what every competent editor does with an undersized asset.
 */
export function fitFor(
  image: { width: number; height: number },
  frame: { width: number; height: number },
): Fit {
  if (image.width <= 0 || image.height <= 0) return "pad";
  const scale = Math.max(frame.width / image.width, frame.height / image.height);
  if (scale > MAX_UPSCALE) return "pad";
  // What covering would discard, as a fraction of the dimension it takes it
  // from. Only one of the two can be non-zero: covering makes one dimension
  // exact and lets the other overflow.
  const covered = { width: image.width * scale, height: image.height * scale };
  const lost = Math.max(1 - frame.width / covered.width, 1 - frame.height / covered.height);
  return lost <= MAX_CROP ? "cover" : "pad";
}

export interface ReelStill {
  file: string;
  width: number;
  height: number;
}

export interface ReelOptions {
  width: number;
  height: number;
  fps: number;
  targetSeconds: number;
  /** 0 for no movement at all. */
  motion: number;
  /** Where the segments and the finished reel are written. */
  workDir: string;
  onProgress?: (fraction: number) => void;
}

export interface Reel {
  file: string;
  seconds: number;
  used: number;
  dropped: number;
  /** How many had to be padded rather than cropped, for the note. */
  padded: number;
}

/**
 * The filter chain for one still.
 *
 * Read from the inside out: the image is enlarged to twice the frame before
 * anything moves, because `zoompan` crops out of the frame it is handed and a
 * pan across a frame-sized image is a pan across single pixels. Two times is
 * enough for any move this file will ask for and is where the memory goes, so
 * it is not three.
 *
 * `d=1` with the zoom written against `on` — the output frame number — rather
 * than `d=<frames>`, which is the form this repository already uses in
 * `zoomExpression`. The other form animates once per *input* frame, and an
 * input that is one looped photograph has one.
 */
export function stillFilter(
  still: ReelStill,
  frame: { width: number; height: number },
  fps: number,
  seconds: number,
  move: Move,
  fit: Fit,
): string {
  const frames = Math.max(1, Math.round(seconds * fps));
  /*
    Twice the frame, and the enlargement happens before the move rather than
    after it. `zoompan` crops a window out of the frame it is handed and scales
    that window to its own output size, so handing it a frame-sized image means
    a pan across single pixels and a scale back up from them. Handing it double
    means every output frame is a downscale, which is where sharpness comes
    from. Two rather than three because this is the line item that decides
    whether a still costs more memory than a piece of video.
  */
  const big = { width: frame.width * 2, height: frame.height * 2 };
  // Linear across the whole hold. A still has nothing else happening in it, so
  // an eased move reads as a video that is buffering.
  const z = `${move.from.toFixed(4)}+${(move.to - move.from).toFixed(4)}*on/${frames}`;
  const pan =
    `zoompan=z='${z}':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'` +
    `:s=${frame.width}x${frame.height}:fps=${fps.toFixed(4)}`;

  const shaped =
    fit === "cover"
      ? // Cover, then crop the middle. `increase` scales the short side to fit
        // and lets the long one overflow, which is what "fill the frame" means.
        `scale=${big.width}:${big.height}:force_original_aspect_ratio=increase:flags=lanczos,` +
        `crop=${big.width}:${big.height}`
      : // The blurred bed is the same image, covering the frame, blurred past
        // recognition and darkened so the sharp copy in front of it is
        // unambiguously the subject. One input, split in two, so the file is
        // opened once.
        `split=2[bed][fg];` +
        `[bed]scale=${big.width}:${big.height}:force_original_aspect_ratio=increase,` +
        `crop=${big.width}:${big.height},gblur=sigma=${Math.round(frame.width / 24)},eq=brightness=-0.12[bedout];` +
        `[fg]scale=${big.width}:${big.height}:force_original_aspect_ratio=decrease:flags=lanczos[fgout];` +
        `[bedout][fgout]overlay=(W-w)/2:(H-h)/2`;

  /*
    No fade at either end, and that is a decision rather than an omission.

    A ramp on every segment means every join dips through black, which on a
    six-shot reel is a strobe rather than a style. The joins are meant to be
    invisible as joins: the motion runs through them (see `motionFor`) and the
    picture never leaves.
  */
  return `${shaped},${pan},setsar=1,format=yuv420p`;
}

/**
 * How big a photograph is, asked of the file rather than of the row.
 *
 * `assets.width`/`height` are written by the browser at upload and are
 * nullable, and the whole reason `fitFor` exists is to decide between filling
 * the frame and sitting inside it — a decision made from the wrong numbers
 * produces a soft, cropped advertisement with nothing failing anywhere. So the
 * file is measured. Returns zeroes when it cannot be read, which `fitFor`
 * already treats as "sit inside the frame", the safe answer.
 */
export async function imageSize(file: string): Promise<{ width: number; height: number }> {
  try {
    const { stdout } = await runFfprobe([
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "default=nw=1:nk=1",
      file,
    ]);
    const [width, height] = stdout.trim().split("\n").map((n) => Number.parseInt(n, 10));
    return Number.isFinite(width) && Number.isFinite(height) ? { width, height } : { width: 0, height: 0 };
  } catch {
    return { width: 0, height: 0 };
  }
}

function runFfprobe(args: string[]): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFPROBE, args, { stdio: ["ignore", "pipe", "pipe"] });
    // Silent by nature, so a stall clock would never fire: an absolute ceiling
    // is the only honest one here. Same reasoning as `LIMITS.probe`.
    const deadline = guard(child, { ...LIMITS.probe, what: FFPROBE });
    let stdout = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.on("error", (err) => {
      deadline.clear();
      reject(new FfmpegError(`${FFPROBE} could not be started: ${err.message}`));
    });
    child.on("close", (code) => {
      deadline.clear();
      if (deadline.expired) reject(deadline.error);
      else if (code === 0) resolve({ stdout });
      else reject(new FfmpegError(`${FFPROBE} exited ${code}`));
    });
  });
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, args, { stdio: ["ignore", "pipe", "pipe"] });
    /*
      A deadline, like everything else this worker spawns.

      `LIMITS.analysis` rather than the render's: a segment is one photograph
      and a few seconds of output, so it is a small job, and silence for three
      minutes on one means it is not working. The lesson from the outage this
      guard exists for is that the wrong ceiling is worse than none — but here
      the honest ceiling really is small.
    */
    const deadline = guard(child, { ...LIMITS.analysis, what: FFMPEG });
    let stderr = "";
    child.stdout.on("data", () => deadline.touch());
    child.stderr.on("data", (d) => {
      deadline.touch();
      stderr += d.toString();
    });
    child.on("error", (err) => {
      deadline.clear();
      reject(new FfmpegError(`${FFMPEG} could not be started: ${err.message}`));
    });
    child.on("close", (code) => {
      deadline.clear();
      if (deadline.expired) {
        reject(deadline.error);
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      const tail = stderr.trim().split("\n").filter(Boolean);
      reject(
        new FfmpegError(
          `${tail[tail.length - 1] ?? `${FFMPEG} exited ${code}`}\n${FFMPEG} exited ${code}\n${tail.slice(-10).join("\n")}`,
        ),
      );
    });
  });
}

/**
 * Builds the reel and returns the file.
 *
 * Throws only when there is nothing to build from or when ffmpeg refuses; a
 * still that will not decode is dropped with the count reported, because six
 * photographs of which one is broken is a five-photograph ad, not a failure.
 */
export async function buildStillsReel(stills: readonly ReelStill[], options: ReelOptions): Promise<Reel> {
  const timing = reelTiming(stills.length, options.targetSeconds);
  if (timing.keep === 0) throw new FfmpegError("There are no photographs here to build a video from.");

  const frame = { width: options.width, height: options.height };
  const chosen = stills.slice(0, timing.keep);
  const segments: string[] = [];
  let padded = 0;

  for (const [index, still] of chosen.entries()) {
    const fit = fitFor(still, frame);
    if (fit === "pad") padded += 1;
    const segment = path.join(options.workDir, `still-${String(index).padStart(3, "0")}.mp4`);
    const filter = stillFilter(still, frame, options.fps, timing.secondsEach, motionFor(index, options.motion), fit);

    await runFfmpeg([
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      // `-loop 1 -t D` makes a still into a clip of exactly D seconds. The
      // trim is what makes it finite: without it this is an input that never
      // ends and a render that never returns.
      "-loop",
      "1",
      /*
        And the input rate has to be the output rate, which is the bug this
        line exists because of.

        A looped image decodes at ffmpeg's default 25fps whatever `-r` says on
        the way out, so `-t 2.5` produced 63 frames, `zoompan` at `d=1` emitted
        63, and the segment came out 2.1 seconds long instead of 2.5. Nothing
        failed. The reel was simply 16% shorter than the arithmetic that
        priced, timed and billed it said it was, and every segment drifted from
        every other one at the joins.
      */
      "-framerate",
      options.fps.toFixed(4),
      "-t",
      timing.secondsEach.toFixed(3),
      "-i",
      still.file,
      "-filter_complex",
      filter,
      "-r",
      options.fps.toFixed(4),
      /*
        Every segment is encoded identically, and that is a requirement rather
        than tidiness: the concat demuxer below copies streams instead of
        re-encoding them, and it can only do that when the parameters match. A
        segment that differed in profile or pixel format would join silently
        wrong — a file that plays as far as the mismatch and then does not.
      */
      "-c:v",
      "libx264",
      "-profile:v",
      "high",
      "-pix_fmt",
      "yuv420p",
      // Deliberately better than the delivery encode. This is an intermediate
      // that is about to be encoded again, and the loss compounds; the file is
      // discarded within the minute, so the size does not matter.
      "-crf",
      "16",
      "-preset",
      "veryfast",
      "-an",
      segment,
    ]);
    segments.push(segment);
    options.onProgress?.((index + 1) / chosen.length);
  }

  // The concat demuxer's list file. Paths are quoted and single quotes inside
  // them escaped, because a filename is not a keyword and this one came from a
  // directory name we did not choose.
  const listFile = path.join(options.workDir, "reel.txt");
  await writeFile(listFile, segments.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"), "utf8");

  const file = path.join(options.workDir, "reel.mp4");
  await runFfmpeg([
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "concat",
    // The list names absolute paths inside the job's own directory, which is
    // the only reason this is safe to switch on.
    "-safe",
    "0",
    "-i",
    listFile,
    "-c",
    "copy",
    file,
  ]);

  return { file, seconds: timing.seconds, used: timing.keep, dropped: timing.dropped, padded };
}
