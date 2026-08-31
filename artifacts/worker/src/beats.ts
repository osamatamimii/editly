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
  let bestLag = 0;
  let bestScore = 0;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let s = 0;
    for (let i = 0; i + lag < x.length; i += 1) s += x[i]! * x[i + lag]!;
    const score = s / energy;
    scores[lag] = score;
    if (score > bestScore) { bestScore = score; bestLag = lag; }
  }
  if (bestLag === 0) return { lag: 0, confidence: 0 };

  /**
   * A whole number of frames is not a tempo.
   *
   * The lag is measured in 11.6 ms steps, so the closest integer to 90 bpm is
   * 90.67 — three quarters of a percent out. That reads as correct on a
   * twelve-second fixture and drifts a third of a second over a minute, which
   * is punches that start on the beat and end up between them. This is exactly
   * the defect the fixtures caught: the tempo was right and the *grid* was not.
   *
   * The autocorrelation is smooth around its peak, so a parabola through the
   * three points either side of it gives the fractional lag the samples imply.
   */
  const left = scores[bestLag - 1] ?? bestScore;
  const right = scores[bestLag + 1] ?? bestScore;
  const curvature = left - 2 * bestScore + right;
  const shift = curvature === 0 ? 0 : (0.5 * (left - right)) / curvature;
  const lag = bestLag + (Math.abs(shift) < 1 ? shift : 0);
  return { lag, confidence: bestScore };
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
