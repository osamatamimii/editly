/**
 * Measuring a look instead of naming one.
 *
 * There is no default style in this product: the user decides. But "decide the
 * style" is a terrible thing to ask someone who edits by feel — nobody knows
 * they want 120 ms of lead-in before a word, or captions anchored at 62% of the
 * frame. What they know is that a particular video looks right.
 *
 * So they hand us one, and this reads it. Everything here is a measurement of
 * the reference, not an opinion about it: how often the picture changes, how
 * much silence was left in, how loud it ends up, how saturated the grade is.
 * Each number lands directly on a knob the renderer already has.
 *
 * The reference is uploaded, never fetched from a link. Downloading someone's
 * TikTok to analyse it breaks that platform's terms, and the exposure would be
 * ours rather than the user's.
 */
import { spawn } from "node:child_process";
import { guard, LIMITS } from "./deadline";

export interface StyleProfile {
  /** Visual changes per minute — cuts, and by extension how restless the edit is. */
  cutsPerMinute: number;
  /** The longest pause the reference was willing to keep, in milliseconds. */
  keptSilenceMs: number;
  /** Integrated loudness. Only meaningful when `audioMeasured`. */
  targetLufs: number;
  /** Loudness range. Wide means dynamic; narrow means compressed and loud. */
  loudnessRange: number;
  /** False when the reference had no audio, or none loud enough to measure. */
  audioMeasured: boolean;
  /**
   * False when the reference had no readable video — an audio file, or anything
   * signalstats could not sample a frame from. Without it the empty readings
   * average to 0, which reads as a real flat-grey grade rather than as "not
   * measured", and pulls the user's footage toward grey on a comparison that
   * never happened. Only meaningful readings when this is true.
   */
  gradeMeasured: boolean;
  /** Mean saturation on the 0..1 scale described by SAT_FULL_SCALE. */
  saturation: number;
  /** Mean luma, 0..1. Tells bright-and-airy from moody. */
  brightness: number;
  /** How much the picture moves, 0..1. See MOTION_FULL_SCALE. */
  motion: number;
  /** Seconds of reference actually examined — capped at the sample window. */
  sampledSeconds: number;
  /**
   * The whole length of the file, which is not the same as `sampledSeconds`:
   * the reader looks at the first two minutes at most, but a punch budget is
   * spread over the *entire* source. Using the sample window instead kept 12
   * punches of 40 on a ten-minute talk and reported "6 a minute". 0 when the
   * duration could not be read.
   */
  sourceSeconds: number;
}

/**
 * signalstats reports SATAVG as a chroma distance in 8-bit units, whose real
 * ceiling is sqrt(2) x 127.5 ~ 180, not 255. Dividing by 255 would quietly
 * squash every saturation reading into the bottom two thirds of the range.
 */
const SAT_FULL_SCALE = 180;

/**
 * YDIF is the mean absolute luma change between the frames we sample, in 8-bit
 * units. We sample at 4 fps, so a reading of 32 means the average pixel shifted
 * an eighth of full scale in a quarter second — already a lot of movement. That
 * is the top of our scale; a locked-off talking head sits near zero.
 */
const MOTION_FULL_SCALE = 32;

/**
 * Runs ffmpeg and hands back everything it said, on both streams.
 *
 * Both, because the filters we rely on do not agree on where to talk:
 * showinfo, silencedetect and ebur128 report on stderr, while
 * `metadata=print:file=-` means stdout specifically. Reading only stderr costs
 * nothing at the time and quietly returns zero for every grade and motion
 * number, which looks exactly like flat grey footage. The null muxer writes no
 * bytes of its own, so there is nothing here to confuse with a filter's report.
 */
function ffmpeg(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-hide_banner", "-nostdin", ...args]);
    const deadline = guard(child, { ...LIMITS.analysis, what: "measuring the reference clip" });
    let said = "";
    const collect = (d: Buffer) => {
      deadline.touch();
      said += d.toString();
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (err) => {
      deadline.clear();
      reject(err);
    });
    child.on("close", () => {
      deadline.clear();
      // This resolves on any exit code, so the flag is the only thing that
      // separates "the clip had nothing to report" from "we stopped reading
      // it" — and the first of those is a style of flat grey footage.
      if (deadline.expired) reject(deadline.error);
      else resolve(said);
    });
  });
}

/** Every number in `pattern`'s first capture group, in order. */
function numbers(text: string, pattern: RegExp): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(pattern)) {
    const v = Number(m[1]);
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const round = (v: number, places: number) => +v.toFixed(places);

/**
 * How long to look at. Style repeats — the first two minutes of a clip carry
 * the same grade, pacing and loudness as the twentieth, and reading the whole
 * thing would cost time for a number that would not move.
 */
const MAX_SAMPLE_SECONDS = 120;

/** Below this a scene score is ordinary frame-to-frame change, not a cut. */
const SCENE_THRESHOLD = 0.25;

/** Quieter than this and ebur128 is measuring a room tone, not a mix. */
const SILENT_MIX_LUFS = -45;

export async function measureStyle(referencePath: string): Promise<StyleProfile> {
  const duration = await probeDuration(referencePath);
  const sampled = Math.min(duration || MAX_SAMPLE_SECONDS, MAX_SAMPLE_SECONDS);
  const window = ["-t", String(sampled), "-i", referencePath];

  // Cuts. `showinfo` prints one line per frame that survives the select, and
  // the select only passes frames whose scene score clears the threshold.
  const cutsOut = await ffmpeg([
    ...window,
    "-vf", `select='gt(scene,${SCENE_THRESHOLD})',showinfo`,
    "-an", "-f", "null", "-",
  ]);
  const cuts = numbers(cutsOut, /pts_time:([\d.]+)/g).length;

  // Silence the reference chose to keep. An editor who cuts hard leaves almost
  // none; one who lets a line breathe leaves half a second at a time. The 90th
  // percentile rather than the longest, so one dead top-and-tail does not
  // decide the whole profile.
  const silenceOut = await ffmpeg([
    ...window,
    "-af", "silencedetect=noise=-32dB:d=0.20",
    "-vn", "-f", "null", "-",
  ]);
  const silences = numbers(silenceOut, /silence_duration:\s*([\d.]+)/g);
  const keptSilenceMs = silences.length === 0 ? 0 : Math.round(percentile(silences, 0.9) * 1000);

  // Loudness, and how much of it moves.
  const loudOut = await ffmpeg([...window, "-af", "ebur128=peak=true", "-vn", "-f", "null", "-"]);
  const integrated = lastNumber(loudOut, /I:\s+(-?[\d.]+)\s+LUFS/g);
  const lra = lastNumber(loudOut, /LRA:\s+(-?[\d.]+)\s+LU/g);
  const audioMeasured = integrated !== null && Number.isFinite(integrated) && integrated > SILENT_MIX_LUFS;

  // The grade, and how much the picture moves. Sampled at 4 fps: saturation and
  // brightness do not change meaningfully between neighbouring frames, and this
  // keeps a two-minute read to a few seconds.
  const statsOut = await ffmpeg([
    ...window,
    "-vf", "fps=4,signalstats,metadata=print:file=-",
    "-an", "-f", "null", "-",
  ]);
  const sat = numbers(statsOut, /lavfi\.signalstats\.SATAVG=([\d.]+)/g);
  const luma = numbers(statsOut, /lavfi\.signalstats\.YAVG=([\d.]+)/g);
  const lumaDiff = numbers(statsOut, /lavfi\.signalstats\.YDIF=([\d.]+)/g);

  const gradeMeasured = sat.length > 0 && luma.length > 0;

  return {
    cutsPerMinute: sampled > 0 ? round(cuts / (sampled / 60), 2) : 0,
    keptSilenceMs,
    targetLufs: audioMeasured ? (integrated ?? -14) : -14,
    loudnessRange: audioMeasured ? (lra ?? 0) : 0,
    audioMeasured,
    gradeMeasured,
    saturation: round(clamp(mean(sat) / SAT_FULL_SCALE, 0, 1), 3),
    brightness: round(clamp(mean(luma) / 255, 0, 1), 3),
    motion: round(clamp(mean(lumaDiff) / MOTION_FULL_SCALE, 0, 1), 3),
    sampledSeconds: round(sampled, 1),
    sourceSeconds: round(duration > 0 ? duration : sampled, 1),
  };
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[i];
}

function lastNumber(text: string, pattern: RegExp): number | null {
  const all = numbers(text, pattern);
  return all.length ? all[all.length - 1] : null;
}

function probeDuration(path: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=nw=1:nk=1",
      path,
    ]);
    const deadline = guard(child, { ...LIMITS.probe, what: "reading the reference clip's length" });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d.toString();
    });
    child.on("error", () => {
      deadline.clear();
      resolve(0);
    });
    child.on("close", () => {
      deadline.clear();
      // Zero is this function's own "could not tell", which is what a killed
      // probe honestly is. It fails soft because a reference clip we cannot
      // measure is a style we do not copy, not a render we refuse.
      resolve(deadline.expired ? 0 : Number(out.trim()) || 0);
    });
  });
}

export interface StyleSettings {
  maxSilenceMs: number;
  leadInMs: number;
  kenBurnsTo: number;
  punchesPerMinute: number;
  punchAmount: number;
  targetLufs: number;
  saturationBoost: number;
}

/**
 * The measured look, turned into the knobs the renderer already has.
 *
 * Grade is the one thing that cannot be read off the reference alone. "This
 * clip measures 0.31 saturation" says nothing about how much to push the user's
 * footage until we know what the user's footage measures — 0.31 is a lift for
 * flat log footage and a cut for something already graded. So the grade knobs
 * only move when `source` is supplied, and when it is not, we leave the picture
 * exactly as we found it rather than guessing at a house neutral.
 *
 * The rest is deliberately conservative in both directions: a reference cut
 * every second does not license us to shred someone's careful piece to camera,
 * and a calm reference should not flatten an energetic one to nothing. The
 * clamps are the taste in this file, and they are the only taste in it.
 */
export function styleToSettings(style: StyleProfile, source?: StyleProfile): StyleSettings {
  return {
    // What the reference kept, floored so we never clip a breath off the front
    // of a line and ceilinged so a slow reference does not mean "leave it all".
    maxSilenceMs: clamp(style.keptSilenceMs || 350, 150, 900),
    leadInMs: 100,
    // A restless reference gets a stronger push, a calm one barely any.
    kenBurnsTo: round(clamp(1.03 + style.cutsPerMinute / 400, 1.02, 1.12), 3),
    // Punches follow the reference's own rhythm, at a third of its cut rate,
    // because a punch is an accent and accents lose meaning when constant.
    punchesPerMinute: round(clamp(style.cutsPerMinute / 3, 0, 12), 1),
    punchAmount: round(clamp(0.06 + style.motion * 0.16, 0.06, 0.22), 3),
    // Every platform normalises to about -14, so the reference's own loudness
    // only matters as a sanity check on ours — and not at all when the
    // reference had no audio worth measuring.
    targetLufs: style.audioMeasured ? clamp(style.targetLufs, -20, -10) : -14,
    saturationBoost: saturationBoostFor(style, source),
  };
}

/**
 * How far to push the user's grade toward the reference's. A ratio, so it needs
 * no absolute idea of what "normal" saturation is — only the two readings, taken
 * the same way. Clamped hard because saturation is the fastest way to make
 * footage look cheap, and because a near-monochrome source would otherwise
 * produce an unbounded multiplier.
 */
function saturationBoostFor(style: StyleProfile, source?: StyleProfile): number {
  // A grade neither side could read is not a grade to match. Without this an
  // unreadable reference measures 0 saturation, and the ratio pulls the footage
  // grey while a note claims a colour comparison that never happened.
  if (!source || !style.gradeMeasured || !source.gradeMeasured) return 1;
  if (source.saturation < 0.02) return 1;
  const ratio = style.saturation / source.saturation;
  // Half the distance, not all of it: the reference's grade belongs to the
  // reference's footage, shot under its own light.
  return round(clamp(1 + (ratio - 1) * 0.5, 0.85, 1.35), 3);
}
