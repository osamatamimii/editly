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
/**
 * The two streams kept apart, which is what lets two readings share one decode.
 *
 * They used to be concatenated, and that was fine while every filter had a run
 * of its own. It stops being fine the moment `showinfo` and
 * `metadata=print` are in the same graph: both print `pts_time:` for every
 * frame they pass, so the cut count — which is *how many lines carry a
 * `pts_time`* — would have counted the four-per-second metadata frames too and
 * reported a reference that cuts three hundred times a minute.
 *
 * `metadata=print:file=-` writes to stdout and every other filter here writes
 * to stderr, so keeping them apart separates the two by construction rather
 * than by a regular expression that has to stay clever.
 */
function ffmpeg(args: string[]): Promise<{ out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-hide_banner", "-nostdin", ...args]);
    const deadline = guard(child, { ...LIMITS.analysis, what: "measuring the reference clip" });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => {
      deadline.touch();
      out += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      deadline.touch();
      err += d.toString();
    });
    child.on("error", (error) => {
      deadline.clear();
      reject(error);
    });
    child.on("close", () => {
      deadline.clear();
      // This resolves on any exit code, so the flag is the only thing that
      // separates "the clip had nothing to report" from "we stopped reading
      // it" — and the first of those is a style of flat grey footage.
      if (deadline.expired) reject(deadline.error);
      else resolve({ out, err });
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

  /*
    Four readings, two decodes.

    This was four `ffmpeg` runs over the same window: scene detection, silence,
    loudness, and the grade. Each one decoded the clip again from the top, and
    the two video ones decode every frame of it — a two-minute 1080p reference
    is 3,600 frames, twice. Measured on this machine over a 120-second 1080p
    clip: **39.2 seconds** for the four, against **25.1** for the two below,
    reading identical numbers. And it is paid twice on a render with a
    reference, because `enrich.ts` measures the source the same way.

    Nothing failed. Every reading was right; a quarter of a minute of a
    single-core machine went into decoding the same file four times, on a job
    somebody is waiting for.

    The pairs are chosen by what they need, not by what is convenient. The two
    audio filters chain — `silencedetect` passes its input through — so they
    are one leg with no split at all. The two video ones cannot: `select` drops
    every frame that is not a cut, so a `fps=4` after it would sample the cuts
    rather than the clip, and `fps=4` before it would hand scene detection
    every fourth frame and change what a cut is. So the picture is split once
    and each branch gets the frames it needs.
  */
  const [picture, sound] = await Promise.all([
    ffmpeg([
      ...window,
      "-filter_complex",
      "[0:v]split=2[cuts][grade];" +
        `[cuts]select='gt(scene,${SCENE_THRESHOLD})',showinfo,nullsink;` +
        // `format=yuv420p` before `signalstats`, because signalstats reports
        // its averages in the source's own bit depth: a 10-bit source — the
        // iPhone default — gives SATAVG and YAVG on a 0..1023 scale, four
        // times the 0..255 these readings are divided against, so every 10-bit
        // reference measured saturation and brightness of 1.0 (clamped) and
        // drove the grade to its ceiling on a comparison that never happened.
        //
        // Sampled at 4 fps: saturation and brightness do not change
        // meaningfully between neighbouring frames, and this keeps a
        // two-minute read to a few seconds.
        "[grade]fps=4,format=yuv420p,signalstats,metadata=print:file=-[graded]",
      "-map", "[graded]",
      "-an", "-f", "null", "-",
    ]),
    /*
      Skipped outright when there is no sound, rather than run for nothing.

      A silent clip used to get both audio filters anyway: two processes that
      decoded a video stream they had been told to ignore and reported nothing.
      `audioMeasured` was already false afterwards, so the answer was right and
      the work was wasted — which is the same shape as everything else on this
      page.
    */
    hasAudioStream(referencePath).then((present) =>
      present
        ? ffmpeg([
            ...window,
            "-af", "silencedetect=noise=-32dB:d=0.20,ebur128=peak=true",
            "-vn", "-f", "null", "-",
          ])
        : { out: "", err: "" },
    ),
  ]);

  /*
    Cuts. `showinfo` prints one line per frame that survives the select, and the
    select only passes frames whose scene score clears the threshold.

    Anchored on the filter's own name as well as read from stderr. The stream
    split above is what makes this unambiguous; the anchor is what keeps it
    unambiguous if a later filter starts printing timestamps to stderr too.
  */
  const cuts = numbers(picture.err, /Parsed_showinfo[^\n]*pts_time:([\d.]+)/g).length;

  // Silence the reference chose to keep. An editor who cuts hard leaves almost
  // none; one who lets a line breathe leaves half a second at a time. The 90th
  // percentile rather than the longest, so one dead top-and-tail does not
  // decide the whole profile.
  const silences = numbers(sound.err, /silence_duration:\s*([\d.]+)/g);
  const keptSilenceMs = silences.length === 0 ? 0 : Math.round(percentile(silences, 0.9) * 1000);

  // Loudness, and how much of it moves.
  const integrated = lastNumber(sound.err, /I:\s+(-?[\d.]+)\s+LUFS/g);
  const lra = lastNumber(sound.err, /LRA:\s+(-?[\d.]+)\s+LU/g);
  const audioMeasured = integrated !== null && Number.isFinite(integrated) && integrated > SILENT_MIX_LUFS;

  // The grade, and how much the picture moves.
  const sat = numbers(picture.out, /lavfi\.signalstats\.SATAVG=([\d.]+)/g);
  const luma = numbers(picture.out, /lavfi\.signalstats\.YAVG=([\d.]+)/g);
  const lumaDiff = numbers(picture.out, /lavfi\.signalstats\.YDIF=([\d.]+)/g);

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

/**
 * Does this file carry a sound track at all?
 *
 * Asked so that a silent clip is not handed two audio filters and a decoder
 * for a stream that is not there. It fails soft in the same direction
 * `probeDuration` does — an unreadable probe answers "yes", so the measurement
 * is attempted and the audio filters give the honest empty answer, rather than
 * a clip being silently marked as having no sound because ffprobe hiccuped.
 */
function hasAudioStream(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("ffprobe", [
      "-v", "error",
      "-select_streams", "a:0",
      "-show_entries", "stream=codec_type",
      "-of", "default=nw=1:nk=1",
      path,
    ]);
    const deadline = guard(child, { ...LIMITS.probe, what: "looking for the reference clip's sound" });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d.toString();
    });
    child.on("error", () => {
      deadline.clear();
      resolve(true);
    });
    child.on("close", () => {
      deadline.clear();
      resolve(deadline.expired ? true : out.trim() === "audio");
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
