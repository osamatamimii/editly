/**
 * Builds every sound effect this product ships.
 *
 * ## Why they are synthesised and not downloaded
 *
 * A clip we hand somebody is a licence we take on their behalf. That sentence
 * is already in the contract, about music, and it is the reason there is no
 * music catalogue in this product. Sound effects are the same claim with a
 * smaller file attached: "CC0" on a download page is somebody else's assertion
 * about somebody else's recording, and the person who finds out it was wrong is
 * the customer whose video got a claim on it.
 *
 * So none of these are recordings. Every sample below is arithmetic — noise
 * from a seeded generator, sine waves, envelopes — written here, in this file.
 * The provenance is not a link that may rot: it is a script anybody can run to
 * get the same bytes back. That is what makes the CC0 dedication in README.md
 * ours to give.
 *
 * ## Why the DSP is written out rather than assembled from ffmpeg filters
 *
 * A whoosh is noise through a filter whose cutoff moves. ffmpeg's `lowpass`
 * and `bandpass` take a frequency, not an expression of `t`, so a sweep has to
 * be faked by crossfading bands — which sounds like crossfaded bands. Sixty
 * lines of biquad here buys a real sweep and, more to the point, a file a
 * person can read and change.
 *
 * Deterministic on purpose: the noise comes from a seeded PRNG, so re-running
 * this produces byte-identical files and a diff on these assets means somebody
 * changed a number here.
 *
 * Usage: node artifacts/worker/assets/sfx/make-sfx.mjs
 * Requires: ffmpeg on PATH (for the WAV → FLAC encode only).
 */
import { writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const RATE = 48000;

// ── The smallest amount of DSP that will do ─────────────────────────────────

/** Seeded PRNG. The seed is part of the recipe, so the noise is reproducible. */
function noiseFrom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

/**
 * A state-variable filter, stepped per sample so its cutoff can move.
 *
 * Chamberlin's topology rather than a biquad, because the coefficients are two
 * cheap numbers recomputed every sample instead of five, and because it hands
 * back low, band and high from one pass — which is what lets one function make
 * both a whoosh (band) and an air layer (high).
 *
 * Stable while f < rate/6, which every sweep here stays under.
 */
function svf() {
  let low = 0;
  let band = 0;
  return (x, cutoff, q) => {
    const f = 2 * Math.sin((Math.PI * Math.min(cutoff, RATE / 6)) / RATE);
    const damp = Math.min(2 * (1 - Math.pow(q, 0.25)), Math.min(2, 2 / f - f * 0.5));
    const high = x - low - damp * band;
    band += f * high;
    low += f * band;
    return { low, band, high };
  };
}

const lerp = (a, b, u) => a + (b - a) * u;
/** Exponential in frequency, because pitch is heard on a log scale. */
const glide = (a, b, u) => a * Math.pow(b / a, u);

/** Attack, then a curved decay. `curve` above 1 falls away faster at the end. */
function ad(u, attack, curve) {
  if (u < attack) return u / attack;
  const v = (u - attack) / (1 - attack);
  return Math.pow(1 - v, curve);
}

// ── The catalogue, as recipes ───────────────────────────────────────────────
//
// Every file's *role* lives in worker/src/sfx.ts; this file only knows how to
// make the sound. The two are checked against each other by sfx-test.

const SOUNDS = {
  // Movement. Band-passed noise whose centre sweeps — the whole sound is the
  // sweep, which is why the filter had to be written out.
  "whoosh-soft": { seconds: 0.55, build: sweepNoise({ from: 300, to: 3500, q: 0.55, attack: 0.12, curve: 2.0, seed: 11 }) },
  "whoosh-fast": { seconds: 0.32, build: sweepNoise({ from: 600, to: 6000, q: 0.5, attack: 0.07, curve: 2.6, seed: 22 }) },
  "whoosh-down": { seconds: 0.5, build: sweepNoise({ from: 5200, to: 320, q: 0.55, attack: 0.1, curve: 1.8, seed: 33 }) },
  "whoosh-air": { seconds: 0.85, build: airNoise({ cutoff: 2200, seed: 44 }) },

  // Weight. A sine dropping in pitch is what a hit *is*; the noise on the
  // front is only what tells you it started.
  "impact-soft": { seconds: 0.5, build: hit({ from: 95, to: 46, drop: 0.13, curve: 3.2, click: 0.16, seed: 55 }) },
  "impact-deep": { seconds: 0.9, build: hit({ from: 72, to: 31, drop: 0.2, curve: 2.4, click: 0.1, seed: 66 }) },
  "impact-tight": { seconds: 0.25, build: hit({ from: 170, to: 82, drop: 0.07, curve: 4.0, click: 0.28, seed: 77 }) },
  "impact-snap": { seconds: 0.18, build: snap({ centre: 1900, q: 0.35, seed: 88 }) },
  thud: { seconds: 0.42, build: hit({ from: 58, to: 40, drop: 0.25, curve: 3.0, click: 0.06, seed: 99 }) },

  // Lift. Noise and a tone climbing together, and then — this is the part that
  // matters — 70ms of nothing at the end. A riser that runs into the moment it
  // was announcing buries it; the hole is the announcement.
  "riser-short": { seconds: 1.0, build: riser({ seed: 101 }) },
  "riser-mid": { seconds: 2.0, build: riser({ seed: 102 }) },
  "riser-long": { seconds: 3.0, build: riser({ seed: 103 }) },

  // Small marks, for an edit that wants punctuation rather than percussion.
  tick: { seconds: 0.08, build: snap({ centre: 6200, q: 0.3, seed: 111 }) },
  pop: { seconds: 0.14, build: tone({ from: 900, to: 300, attack: 0.02, curve: 3.0 }) },
  blip: { seconds: 0.16, build: tone({ from: 1150, to: 1150, attack: 0.03, curve: 2.2 }) },
  "sweep-up": { seconds: 0.4, build: tone({ from: 320, to: 2000, attack: 0.25, curve: 1.4 }) },
};

function sweepNoise({ from, to, q, attack, curve, seed }) {
  return (n) => {
    const rnd = noiseFrom(seed);
    const filter = svf();
    const out = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      const u = i / n;
      const { band } = filter(rnd(), glide(from, to, u), q);
      out[i] = band * ad(u, attack, curve);
    }
    return out;
  };
}

function airNoise({ cutoff, seed }) {
  return (n) => {
    const rnd = noiseFrom(seed);
    const filter = svf();
    const out = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      const u = i / n;
      const { high } = filter(rnd(), cutoff, 0.7);
      // A bell rather than a hit: this one is a pass of air, not a start.
      out[i] = high * Math.pow(Math.sin(Math.PI * u), 2.2);
    }
    return out;
  };
}

function hit({ from, to, drop, curve, click, seed }) {
  return (n) => {
    const rnd = noiseFrom(seed);
    const filter = svf();
    const out = new Float64Array(n);
    let phase = 0;
    for (let i = 0; i < n; i += 1) {
      const u = i / n;
      const seconds = i / RATE;
      const f = glide(from, to, Math.min(1, seconds / drop));
      phase += (2 * Math.PI * f) / RATE;
      const body = Math.sin(phase) * Math.pow(1 - u, curve);
      const { low } = filter(rnd(), 2600, 0.5);
      const transient = low * click * Math.exp(-seconds * 260);
      out[i] = body + transient;
    }
    return out;
  };
}

function snap({ centre, q, seed }) {
  return (n) => {
    const rnd = noiseFrom(seed);
    const filter = svf();
    const out = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      const u = i / n;
      const { band } = filter(rnd(), centre, q);
      out[i] = band * Math.pow(1 - u, 2.6);
    }
    return out;
  };
}

function tone({ from, to, attack, curve }) {
  return (n) => {
    const out = new Float64Array(n);
    let phase = 0;
    for (let i = 0; i < n; i += 1) {
      const u = i / n;
      phase += (2 * Math.PI * glide(from, to, u)) / RATE;
      // A little second harmonic, so it reads as a mark rather than as a test
      // tone.
      out[i] = (Math.sin(phase) + 0.22 * Math.sin(2 * phase)) * ad(u, attack, curve);
    }
    return out;
  };
}

function riser({ seed }) {
  return (n) => {
    const rnd = noiseFrom(seed);
    const noiseFilter = svf();
    const out = new Float64Array(n);
    let phase = 0;
    // The hole at the end. Held to a tenth of the sound so the short riser
    // still has a rise in it.
    const holeSeconds = Math.min(0.07, (n / RATE) * 0.1);
    const holeFrom = n - Math.round(holeSeconds * RATE);
    for (let i = 0; i < n; i += 1) {
      const u = Math.min(1, i / holeFrom);
      const { band } = noiseFilter(rnd(), glide(420, 7200, u), 0.5);
      phase += (2 * Math.PI * glide(200, 1250, u)) / RATE;
      const climb = Math.pow(u, 2.2);
      let sample = (band * 0.8 + Math.sin(phase) * 0.35) * climb;
      if (i >= holeFrom) {
        // Not a cut to zero — that is a click. 8ms out.
        const g = Math.max(0, 1 - (i - holeFrom) / (0.008 * RATE));
        sample *= g;
      }
      out[i] = sample;
    }
    return out;
  };
}

// ── Writing them out ────────────────────────────────────────────────────────

/** Peak to -3 dBFS. Perceived level is the catalogue's job, not the file's. */
function normalise(samples) {
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  if (peak === 0) throw new Error("a recipe produced silence");
  const gain = Math.pow(10, -3 / 20) / peak;
  for (let i = 0; i < samples.length; i += 1) samples[i] *= gain;
  return samples;
}

/**
 * A ramp on both ends, always.
 *
 * A file that starts or stops mid-waveform clicks, and a click is the one
 * artefact a listener notices in a layer they were never supposed to notice.
 */
function deClick(samples) {
  const ramp = Math.round(0.003 * RATE);
  for (let i = 0; i < ramp && i < samples.length; i += 1) {
    samples[i] *= i / ramp;
    samples[samples.length - 1 - i] *= i / ramp;
  }
  return samples;
}

function wav(samples) {
  const body = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    body.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + body.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(body.length, 40);
  return Buffer.concat([header, body]);
}

mkdirSync(here, { recursive: true });
let total = 0;
for (const [name, recipe] of Object.entries(SOUNDS)) {
  const samples = deClick(normalise(recipe.build(Math.round(recipe.seconds * RATE))));
  const scratch = path.join(here, `${name}.wav`);
  const out = path.join(here, `${name}.flac`);
  writeFileSync(scratch, wav(samples));
  const encoded = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", scratch, "-c:a", "flac", "-compression_level", "12", out], {
    stdio: "inherit",
  });
  unlinkSync(scratch);
  if (encoded.status !== 0) {
    console.error(`could not encode ${name}`);
    process.exit(1);
  }
  total += 1;
  console.log(`  ${name}.flac  ${recipe.seconds.toFixed(2)}s`);
}
console.log(`\n${total} sounds written to ${here}`);
