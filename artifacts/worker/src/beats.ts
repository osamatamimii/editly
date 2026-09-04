/**
 * Where the beat is.
 *
 * "Cut it to the beat" was on this product's own list of things it could not
 * do, next to emojis. It is one of the three or four edits short-form video is
 * actually made of, and the reason it stayed on that list is that it needs
 * something none of the other operations need: a *reading of the music*.
 *
 * ## Why this is written here rather than installed
 *
 * The obvious move is `aubio` or `librosa`. Both are a new system dependency in
 * an image whose Dockerfile already refuses to build when its OpenCV, its
 * Chromium or its Arabic shaping is broken — and each of those proofs exists
 * because a dependency that is *present but wrong* is this pipeline's worst
 * failure mode. Onset detection is a spectral flux and an autocorrelation.
 * Written here it is ninety lines, it is deterministic, and it is testable
 * against a click track whose tempo we chose ourselves, which is a stronger
 * position than trusting a library we cannot easily interrogate.
 *
 * ## What it refuses to do
 *
 * **It returns null far more readily than it returns a grid.** Speech has
 * onsets. So does traffic noise, and so does a room tone with a door closing in
 * it. An autocorrelation will happily report 117 bpm for pink noise — measured,
 * not supposed — and a grid built on that is a series of cuts that land
 * *nowhere*, which is worse than no beat sync at all because it looks
 * deliberate. The peak of the normalised autocorrelation separates the two
 * cleanly: a click track scores ~0.88, a synthesised drum pattern ~0.85, pink
 * noise 0.06, a sustained tone 0.0001. The threshold sits in the empty middle,
 * and the caller is expected to say out loud when nothing came back.
 */
import { spawn } from "node:child_process";
import { guard, LIMITS } from "./deadline";

/** Enough for onsets; a tenth of the data of 44.1k. */
const SAMPLE_RATE = 22050;
/** ~11.6 ms between measurements — a third of a video frame. */
const HOP = 256;
const WINDOW = 1024;

/**
 * Tempos we will look for, in seconds per beat.
 *
 * 50–200 bpm. Below that the grid is too sparse to cut against; above it the
 * detector starts locking onto the half-beat, which reads as twice the tempo
 * and puts a cut between every syllable.
 */
const MIN_PERIOD_S = 0.3;
const MAX_PERIOD_S = 1.2;

/**
 * How strong the periodicity has to be before we believe it.
 *
 * Chosen from measurement, in the gap between "music" and "noise that happens
 * to have onsets": drums and clicks land at 0.85–0.88, pink noise at 0.06. A
 * threshold anywhere in that gap is the same decision; this one is close enough
 * to the noise end that quiet or loosely played music still passes, and far
 * enough from it that nothing without a pulse does.
 */
const MIN_CONFIDENCE = 0.3;

/**
 * How much louder the envelope has to be on the grid than off it.
 *
 * The confidence above is a claim that the envelope repeats, and a held chord
 * repeats: two partials that are not bin-centred beat against each other at a
 * steady rate, and a sustained pad measured 0.947 — higher than the click track
 * this was tuned against. Twenty punches on a track with nothing struck in it.
 * See `gridContrast` for the measurements; three sits in the middle of a gap
 * between 2.6 and 15.
 */
const MIN_GRID_CONTRAST = 3;

export interface BeatGrid {
  /** Seconds, from the start of the audio. */
  beats: number[];
  bpm: number;
  /** 0..1, the normalised autocorrelation peak that earned this grid. */
  confidence: number;
}

/** Decode to mono PCM at our own rate. Fails soft: no audio, no grid. */
async function monoPcm(file: string): Promise<Float32Array | null> {
  const chunks: Buffer[] = [];
  const code = await new Promise<number>((resolve) => {
    const ff = spawn("ffmpeg", [
      "-v", "error", "-i", file, "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "s16le", "-",
    ]);
    // It streams PCM the whole time it is decoding, so silence is the tell.
    // A killed child closes like any other, so the flag is checked rather
    // than the exit code: a fragment of a track would produce a confident
    // beat grid for music that was never fully read.
    const deadline = guard(ff, { ...LIMITS.analysis, what: "reading the music track" });
    ff.stdout.on("data", (c: Buffer) => {
      deadline.touch();
      chunks.push(c);
    });
    ff.on("close", (c) => {
      deadline.clear();
      resolve(deadline.expired ? 1 : (c ?? 1));
    });
    ff.on("error", () => {
      deadline.clear();
      resolve(1);
    });
  });
  if (code !== 0) return null;
  const raw = Buffer.concat(chunks);
  const out = new Float32Array(Math.floor(raw.length / 2));
  for (let i = 0; i < out.length; i += 1) out[i] = raw.readInt16LE(i * 2) / 32768;
  return out.length > WINDOW * 8 ? out : null;
}

/** In-place radix-2 FFT. WINDOW is a power of two, which is why this is short. */
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!; re[i] = re[j]!; re[j] = tr;
      const ti = im[i]!; im[i] = im[j]!; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const ur = re[i + k]!, ui = im[i + k]!;
        const xr = re[i + k + len / 2]!, xi = im[i + k + len / 2]!;
        const vr = xr * cr - xi * ci;
        const vi = xr * ci + xi * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/**
 * Spectral flux: how much *more* energy each bin has than it had last frame.
 *
 * Only rises count. A note ending is not an onset, and counting it doubles
 * every event — which is exactly the mistake that makes a detector report
 * twice the tempo.
 */
export function onsetEnvelope(samples: Float32Array): Float32Array {
  const frames = Math.max(0, Math.floor((samples.length - WINDOW) / HOP));
  const env = new Float32Array(frames);
  const previous = new Float32Array(WINDOW / 2);
  const window = new Float32Array(WINDOW);
  for (let i = 0; i < WINDOW; i += 1) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (WINDOW - 1));
  }
  const re = new Float32Array(WINDOW);
  const im = new Float32Array(WINDOW);
  for (let f = 0; f < frames; f += 1) {
    const off = f * HOP;
    for (let i = 0; i < WINDOW; i += 1) {
      re[i] = samples[off + i]! * window[i]!;
      im[i] = 0;
    }
    fft(re, im);
    let flux = 0;
    for (let k = 0; k < WINDOW / 2; k += 1) {
      const mag = Math.hypot(re[k]!, im[k]!);
      const rise = mag - previous[k]!;
      if (rise > 0) flux += rise;
      previous[k] = mag;
    }
    env[f] = flux;
  }
  return env;
}

/** The lag, in frames — fractional — that the envelope repeats at, and how sure we are. */
export function periodOf(env: Float32Array): { lag: number; confidence: number } {
  if (env.length < 8) return { lag: 0, confidence: 0 };
  let sum = 0;
  for (const v of env) sum += v;
  const mean = sum / env.length;
  const x = Float32Array.from(env, (v) => v - mean);
  let energy = 0;
  for (const v of x) energy += v * v;
  if (energy <= 0) return { lag: 0, confidence: 0 };

  const minLag = Math.round((MIN_PERIOD_S * SAMPLE_RATE) / HOP);
  const maxLag = Math.min(Math.round((MAX_PERIOD_S * SAMPLE_RATE) / HOP), x.length - 1);
  const scores: number[] = [];
  // One lag either side of the range as well, so the interpolation below has
  // neighbours at both edges: without them the fastest tempo the detector
  // admits is refined against itself, and 196 to 200 bpm came back as nothing.
  const from = Math.max(1, minLag - 1);
  const to = Math.min(x.length - 1, maxLag + 1);
  for (let lag = from; lag <= to; lag += 1) {
    let s = 0;
    for (let i = 0; i + lag < x.length; i += 1) s += x[i]! * x[i + lag]!;
    scores[lag] = s / energy;
  }

  /**
   * A whole number of frames is not a tempo — and it is not a fair comparison
   * either.
   *
   * The lag is measured in 11.6 ms steps, so the closest integer to 90 bpm is
   * 90.67, three quarters of a percent out: a grid that reads as correct on a
   * twelve-second fixture and drifts a third of a second over a minute. The
   * autocorrelation is smooth around its peak, so a parabola through the three
   * points either side gives the fractional lag the samples imply.
   *
   * The parabola's *height* matters just as much, and that was the bug. The
   * winner used to be chosen by comparing raw integer samples, and the true
   * lag almost never lands on one — so whichever multiple of it happened to
   * fall closest to a whole frame won. On a 128 bpm click track the true lag is
   * 40.37 frames: `scores[40]` is 0.837 and `scores[81]` — the double — is
   * 0.866, so the detector reported 64 bpm. Nineteen of the seventy-one tempos
   * between 60 and 200 came back as an integer sub-multiple, 128 and 170 among
   * them. Interpolating first puts the two peaks within a per cent of each
   * other, which is what they are.
   */
  const refine = (lag: number): { lag: number; score: number } => {
    const centre = scores[lag] ?? 0;
    const left = scores[lag - 1] ?? centre;
    const right = scores[lag + 1] ?? centre;
    const curvature = left - 2 * centre + right;
    const raw = curvature === 0 ? 0 : (0.5 * (left - right)) / curvature;
    const shift = Math.abs(raw) < 1 ? raw : 0;
    return { lag: lag + shift, score: centre - 0.25 * (left - right) * shift };
  };

  let best = { lag: 0, score: 0 };
  let bestInteger = 0;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    const peak = refine(lag);
    if (peak.score > best.score) {
      best = peak;
      bestInteger = lag;
    }
  }
  if (bestInteger === 0) return { lag: 0, confidence: 0 };

  /*
    And then down an octave, where the octave is really there.

    A signal that repeats every L frames also repeats every 2L and every 3L, so
    the autocorrelation has peaks at all of them and the tallest is not always
    the fastest. Interpolation removes the accident above; this removes the
    ambiguity underneath it. The faster reading is taken when its own peak is
    within a tenth of the slower one — on a click track there is nothing at
    half the period and the test simply fails, which is the point.
  */
  const OCTAVE_TOLERANCE = 0.9;
  for (const divisor of [3, 2]) {
    const around = Math.round(bestInteger / divisor);
    if (around < minLag) continue;
    let faster = { lag: 0, score: 0 };
    for (let lag = Math.max(minLag, around - 2); lag <= Math.min(maxLag, around + 2); lag += 1) {
      const peak = refine(lag);
      if (peak.score > faster.score) faster = peak;
    }
    if (faster.lag > 0 && faster.score >= best.score * OCTAVE_TOLERANCE) {
      return { lag: faster.lag, confidence: faster.score };
    }
  }

  return { lag: best.lag, confidence: best.score };
}

/**
 * How much louder the envelope is on the grid than it is on average.
 *
 * The confidence above says the envelope *repeats*; it does not say the
 * envelope has onsets in it. Two partials of a held chord that are not
 * bin-centred beat against each other, and the beating is periodic, so a
 * sustained pad with nothing struck in it scored 0.947 — higher than the click
 * track this detector was tuned against. Measured on twelve fixtures, the two
 * kinds of input do not overlap anywhere near each other:
 *
 *     click tracks 100-170 bpm   15.1 - 25.3      held triad          1.32
 *     kick and pad, 100 bpm             17.1      Fmaj7 pad           2.56
 *                                                 lofi pad, crackle   1.31
 *                                                 low-passed noise    1.12
 *                                                 speech              1.77
 *                                                 pink noise          1.11
 *
 * A struck sound is several times the average flux by construction; a beat
 * that is only a phase of a smooth oscillation is about 1.4, which is what the
 * peak of a sine is. The gate sits at three, with the whole gap either side.
 */
export function gridContrast(env: Float32Array, lag: number): number {
  if (lag <= 0 || env.length === 0) return 0;
  let total = 0;
  for (const value of env) total += value;
  const mean = total / env.length;
  if (mean <= 0) return 0;

  let strongest = 0;
  for (let offset = 0; offset < Math.ceil(lag); offset += 1) {
    let hit = 0;
    let count = 0;
    for (let at = offset; at < env.length; at += lag) {
      hit += env[Math.round(at)] ?? 0;
      count += 1;
    }
    const average = hit / Math.max(1, count);
    if (average > strongest) strongest = average;
  }
  return strongest / mean;
}

/**
 * Which offset the grid starts on.
 *
 * The tempo says how far apart the beats are and says nothing at all about
 * where they fall — and a perfectly correct tempo on the wrong phase is a cut
 * on every off-beat, which is a specific and recognisable kind of wrong. The
 * offset that collects the most onset energy is the downbeat.
 */
function phaseOf(env: Float32Array, lag: number): number {
  let best = { offset: 0, score: -Infinity };
  for (let offset = 0; offset < Math.ceil(lag); offset += 1) {
    let score = 0;
    for (let at = offset; at < env.length; at += lag) score += env[Math.round(at)] ?? 0;
    if (score > best.score) best = { offset, score };
  }
  return best.offset;
}

/**
 * Half the analysis window, added back to every beat time.
 *
 * Flux is measured over a window, so an onset is reported by the first frame
 * whose window covers it — systematically early, by about half a window.
 * Measured against click tracks at 90, 120 and 140 bpm, this correction lands
 * the grid inside one video frame of the real beat, which is the whole
 * requirement: a cut a frame off the beat is a cut on the beat.
 */
const WINDOW_LATENCY_S = WINDOW / 2 / SAMPLE_RATE;

/**
 * The beat grid of an audio file, or null when there is no pulse to find.
 *
 * Null is the common answer and the caller must have something honest to say
 * about it. A grid invented from noise is worse than no grid.
 */
export async function beatsOf(file: string): Promise<BeatGrid | null> {
  const samples = await monoPcm(file);
  if (!samples) return null;
  const env = onsetEnvelope(samples);
  const { lag, confidence } = periodOf(env);
  if (lag <= 0 || confidence < MIN_CONFIDENCE) return null;
  // A repeating envelope is not the same claim as a struck one. See
  // `gridContrast` for the twelve fixtures this number comes from.
  if (gridContrast(env, lag) < MIN_GRID_CONTRAST) return null;

  const offset = phaseOf(env, lag);
  const beats: number[] = [];
  for (let at = offset; at < env.length; at += lag) {
    beats.push((at * HOP) / SAMPLE_RATE + WINDOW_LATENCY_S);
  }
  if (beats.length < 4) return null;
  return { beats, bpm: 60 / ((lag * HOP) / SAMPLE_RATE), confidence };
}

/**
 * Every `every`-th beat, which is what a cut actually wants.
 *
 * At 120 bpm a punch on every beat is two a second — a strobe, not an edit.
 * Bars are what people mean by "on the beat", so the default is four.
 */
export function everyNth(grid: BeatGrid, every = 4, within?: { from: number; to: number }): number[] {
  const picked: number[] = [];
  for (let i = 0; i < grid.beats.length; i += every) {
    const at = grid.beats[i]!;
    if (within && (at < within.from || at > within.to)) continue;
    picked.push(at);
  }
  return picked;
}
