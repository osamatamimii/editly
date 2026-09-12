/**
 * Music we make ourselves, out of arithmetic.
 *
 * The sixteen sound effects in this product are not recordings: they are
 * computed by a script in the repository from seeded noise, sine waves,
 * filters and envelopes, and that is the whole reason they can be shipped
 * where a catalogue cannot. `assets/sfx/README.md` states the argument — "CC0
 * on a download page is somebody else's assertion about somebody else's
 * recording" — and this file is that argument applied to a music bed.
 *
 * It exists because the alternative had a single point of failure nobody had
 * priced: Lyria is the only music generator that publishes a price and sells
 * it self-serve, and reaching it needs a Google Cloud billing account that a
 * payment system can refuse for reasons that have nothing to do with the
 * product. A feature that cannot ship because a card was declined is a feature
 * built on somebody else's risk model.
 *
 * So this is the floor: always present, costs nothing, needs no key, no
 * network and no account. Lyria stays configured as the better maker where it
 * works, and the seam they share (`MusicMaker`) is what makes that a one-line
 * choice rather than two code paths.
 *
 * ## What it is honest about
 *
 * This makes *beds*: instrumental loops, in one key, with one four-bar
 * progression, designed to sit eighteen decibels under somebody talking. Under
 * a fifteen-second product ad the difference from a written track is close to
 * inaudible. As the opening of a podcast it is audibly a loop, and the right
 * answer there is still the customer's own file.
 */
import { spawn } from "node:child_process";
import { writeFile, rm } from "node:fs/promises";
import type { MusicMood } from "@workspace/api-zod";
import { guard, LIMITS } from "../deadline";
import type { MusicMaker } from "./music";

const SAMPLE_RATE = 44100;

/**
 * How loud the file sits before the mixer touches it.
 *
 * Peak-normalised, like the sound effects at -3 dBFS, and for the same reason:
 * a library whose variants come out at different levels is a bed that changes
 * volume when the chooser happens to pick a different one. -6 rather than -3
 * because a bed is summed *under* a programme rather than accented over it,
 * and the extra headroom is what keeps the mix from clipping when the ducking
 * lets it back up between sentences.
 */
const PEAK_DBFS = -6;

/** Roughly how long a bed should be. Rounded to whole bars below. */
const TARGET_SECONDS = 30;

/**
 * A seeded generator, so a bed is a function of its seed and nothing else.
 *
 * The same mulberry32 `make-sfx.mjs` uses. Determinism is not a nicety here:
 * it is what lets a suite assert that the tempo we built is the tempo the beat
 * detector finds, which is the one check that proves both of them at once.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Semitones above A0 (27.5 Hz) to hertz, in equal temperament. */
function hz(semitonesAboveA0: number): number {
  return 27.5 * Math.pow(2, semitonesAboveA0 / 12);
}

/**
 * A one-pole low-pass, which is all the filtering a bed needs.
 *
 * Written out rather than imported because the worker has no DSP dependency
 * and should not grow one for six oscillators. The coefficient is the standard
 * RC form; `cutoff` is in hertz.
 */
function lowpass(buffer: Float32Array, cutoff: number): void {
  const rc = 1 / (2 * Math.PI * cutoff);
  const dt = 1 / SAMPLE_RATE;
  const alpha = dt / (rc + dt);
  let last = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    last += alpha * (buffer[i]! - last);
    buffer[i] = last;
  }
}

/** Attack/decay envelope, in seconds, evaluated at one sample. */
function envelope(t: number, attack: number, decay: number): number {
  if (t < 0) return 0;
  if (t < attack) return t / attack;
  const fell = (t - attack) / decay;
  return fell >= 1 ? 0 : Math.pow(1 - fell, 2);
}

interface Recipe {
  bpm: number;
  /** Root of the key, in semitones above A0. */
  root: number;
  /** The four chords, as semitone offsets from the root. */
  chords: number[];
  /** Major or minor third in the triad. */
  third: 3 | 4;
  /** How present the drums are. 0 leaves the mood without a grid to cut to. */
  drums: number;
  /** How bright the pad is, in hertz of low-pass cutoff. */
  cutoff: number;
  /** Whether a plucked line plays over the pad. */
  pluck: boolean;
}

/**
 * Each mood, as numbers.
 *
 * The tempos are chosen inside the range `beats.ts` will look in (50-200 bpm)
 * and away from its edges, and every mood carries some drum energy — including
 * the quiet ones. That is deliberate: a bed with no onsets is a bed whose
 * tempo cannot be measured, and `music_tracks.bpm` would be null for it, which
 * means the zoom punches have nothing to land on. A soft pulse under a calm
 * pad costs nothing and keeps the grid findable.
 */
const RECIPES: Record<MusicMood, Recipe> = {
  // A minor: i - VI - III - VII, the progression that sounds like waiting.
  calm: { bpm: 72, root: 12, chords: [0, 8, 3, 10], third: 3, drums: 0.75, cutoff: 1400, pluck: false },
  // C major: I - V - vi - IV.
  upbeat: { bpm: 120, root: 15, chords: [0, 7, 9, 5], third: 4, drums: 1, cutoff: 3200, pluck: true },
  // D minor, slow and wide.
  dark: { bpm: 90, root: 17, chords: [0, 10, 8, 7], third: 3, drums: 0.8, cutoff: 900, pluck: false },
  cinematic: { bpm: 80, root: 17, chords: [0, 5, 8, 10], third: 3, drums: 1, cutoff: 1200, pluck: false },
  // G major, bright and bouncing.
  playful: { bpm: 110, root: 22, chords: [0, 9, 5, 7], third: 4, drums: 0.85, cutoff: 4000, pluck: true },
  // F major, mellow.
  warm: { bpm: 92, root: 20, chords: [0, 5, 9, 7], third: 4, drums: 0.75, cutoff: 2200, pluck: true },
};

/** What the recipe says the tempo is. Exported so a suite can hold the beat
 *  detector to it rather than to a number written twice. */
export function bpmFor(mood: MusicMood): number {
  return RECIPES[mood].bpm;
}

/**
 * How long a bed is, in seconds: whole bars, and a whole number of times
 * through the four-chord progression.
 *
 * A loop that is not an exact number of bars is a loop with a stumble in it
 * once every pass, and the mixer repeats this file for the length of the
 * video. So the target is advisory and the bar count decides.
 */
export function secondsFor(mood: MusicMood): number {
  const { bpm } = RECIPES[mood];
  const barSeconds = (60 / bpm) * 4;
  const progressions = Math.max(1, Math.round(TARGET_SECONDS / (barSeconds * 4)));
  return progressions * 4 * barSeconds;
}

/** Render one bed as interleaved stereo float samples. */
export function renderBed(mood: MusicMood, seed: number): Float32Array {
  const recipe = RECIPES[mood];
  const random = mulberry32(seed);
  const seconds = secondsFor(mood);
  const total = Math.round(seconds * SAMPLE_RATE);
  const beat = 60 / recipe.bpm;
  const bar = beat * 4;

  const pad = new Float32Array(total);
  const bass = new Float32Array(total);
  const lead = new Float32Array(total);
  const drums = new Float32Array(total);

  /*
    The pad: three notes of a triad, held for a bar each, slightly detuned.

    Detuning the second voice by a few cents is what stops three sine waves
    from sounding like one loud sine wave. It is the cheapest thing in this
    file and the largest single difference in how much like "music" the result
    sounds.
  */
  for (let barIndex = 0; barIndex * bar < seconds; barIndex += 1) {
    const chord = recipe.chords[barIndex % recipe.chords.length]!;
    const start = barIndex * bar;
    const notes = [0, recipe.third, 7].map((interval) => hz(recipe.root + chord + interval));
    /*
      A fixed detune, not a random one.

      It was `1 + (random() - 0.5) * 0.004`, and the beating between two
      voices a few cents apart is slow amplitude modulation — energy at
      roughly the same rate as the beat. On some seeds that swamped the onset
      contrast `beats.ts` measures, and the same mood came out with a tempo on
      one seed and `null` on another. A bed whose tempo is measurable only
      sometimes is worse than one that is never measurable, because nothing
      says which kind you got.
    */
    const detune = 1.0016;

    for (let i = 0; i < Math.round(bar * SAMPLE_RATE) && barIndex * Math.round(bar * SAMPLE_RATE) + i < total; i += 1) {
      const index = barIndex * Math.round(bar * SAMPLE_RATE) + i;
      const t = i / SAMPLE_RATE;
      // Swell in and out across the bar so the chord change is a movement
      // rather than a step.
      const shape = Math.min(1, t / 0.35) * Math.min(1, (bar - t) / 0.5);
      let value = 0;
      for (const [voice, frequency] of notes.entries()) {
        const f = frequency * (voice === 1 ? detune : 1);
        value += Math.sin(2 * Math.PI * f * t) / notes.length;
      }
      pad[index] = value * shape * 0.5;
    }

    // The bass: the root, two octaves down, one note per bar.
    const rootHz = hz(recipe.root + chord - 24);
    for (let i = 0; i < Math.round(bar * SAMPLE_RATE) && barIndex * Math.round(bar * SAMPLE_RATE) + i < total; i += 1) {
      const index = barIndex * Math.round(bar * SAMPLE_RATE) + i;
      const t = i / SAMPLE_RATE;
      bass[index] = Math.sin(2 * Math.PI * rootHz * t) * envelope(t, 0.02, bar * 0.9) * 0.6;
    }

    /*
      The plucked line, on the offbeats, from the notes of the chord.

      Only where the recipe asks for it. A pluck over a cinematic drone is a
      music box in a trailer.
    */
    if (recipe.pluck) {
      for (let eighth = 0; eighth < 8; eighth += 1) {
        if (random() < 0.45) continue;
        const at = start + eighth * (beat / 2);
        const note = hz(recipe.root + chord + [0, recipe.third, 7, 12][Math.floor(random() * 4)]! + 12);
        const from = Math.round(at * SAMPLE_RATE);
        for (let i = 0; i < Math.round(0.45 * SAMPLE_RATE) && from + i < total; i += 1) {
          const t = i / SAMPLE_RATE;
          lead[from + i] += Math.sin(2 * Math.PI * note * t) * envelope(t, 0.004, 0.4) * 0.35;
        }
      }
    }
  }

  /*
    The drums, and the reason even the quiet moods have them.

    `beats.ts` finds a grid by looking for onsets, and refuses to answer when
    the contrast between what is on the grid and what is off it is too low —
    a guard it grew after a continuous pad scored 0.947 confidence on nothing.
    A bed with no transients is therefore a bed with no measurable tempo, and
    `music_tracks.bpm` would be null for it: honest, and useless to the zoom
    punches. A kick on the downbeats fixes that for the cost of being heard.
  */
  const beats = Math.floor(seconds / beat);
  for (let b = 0; b < beats; b += 1) {
    const at = Math.round(b * beat * SAMPLE_RATE);

    /*
      One kick on every beat, not every other one.

      The first version put it on alternate beats, which is more musical and
      measured wrong: `beatsOf` read the strongest period as two beats and
      answered 60 bpm for a track built at 120, and 55 for one built at 110.
      The detector was right about what was actually in the file — the onsets
      really were half a beat apart in strength — and the number would have
      gone into `music_tracks.bpm` and put every zoom punch on the offbeat.

      So the grid is one onset per beat, with the first and third accented so
      it still reads as a bar rather than a metronome. Measured after the
      change, not assumed: `music-test` holds each mood's detected tempo to the
      one the recipe built.
    */
    const accented = b % 4 === 0 || b % 4 === 2;
    const weight = accented ? 1 : 0.72;
    for (let i = 0; i < Math.round(0.22 * SAMPLE_RATE) && at + i < total; i += 1) {
      const t = i / SAMPLE_RATE;
      const frequency = 45 + 75 * Math.exp(-t * 28);
      drums[at + i] += Math.sin(2 * Math.PI * frequency * t) * envelope(t, 0.002, 0.2) * recipe.drums * weight;
    }

    /*
      And three milliseconds of click on top of it.

      A swept sine is a kick a person hears and a detector can miss: its energy
      is all below 120 Hz, where a low pad already lives, so the *change* at
      the onset can be small even when the thump is obvious. Real kick drums
      have a beater click for the same reason a snare has a crack — it is what
      makes the attack legible.

      This is the line that made the grid survive a change of seed. Before it,
      whether `beatsOf` found a tempo depended on which random detune the pad
      happened to get.
    */
    for (let i = 0; i < Math.round(0.004 * SAMPLE_RATE) && at + i < total; i += 1) {
      const t = i / SAMPLE_RATE;
      drums[at + i] += (random() * 2 - 1) * envelope(t, 0.0004, 0.0035) * 0.22 * recipe.drums * weight;
    }

    // Hat: filtered noise on the offbeat, short enough to read as a tick. It
    // is between the beats on purpose, so it colours the groove without
    // competing with the grid the kick is laying down.
    const offbeat = Math.round((b + 0.5) * beat * SAMPLE_RATE);
    for (let i = 0; i < Math.round(0.05 * SAMPLE_RATE) && offbeat + i < total; i += 1) {
      const t = i / SAMPLE_RATE;
      drums[offbeat + i] += (random() * 2 - 1) * envelope(t, 0.001, 0.045) * 0.085 * recipe.drums;
    }
  }

  lowpass(pad, recipe.cutoff);
  lowpass(bass, 220);

  /*
    Stereo, and only just.

    The pad is spread by delaying one side by a few milliseconds; everything
    else stays centred. A wide bed fights a centred voice for the same space,
    and the mixer is about to duck this under somebody talking.
  */
  const spread = Math.round(0.008 * SAMPLE_RATE);
  const out = new Float32Array(total * 2);
  for (let i = 0; i < total; i += 1) {
    const padLeft = pad[i]!;
    const padRight = pad[Math.max(0, i - spread)]!;
    const centre = bass[i]! + lead[i]! + drums[i]!;
    out[i * 2] = padLeft + centre;
    out[i * 2 + 1] = padRight + centre;
  }

  // Peak normalise. A library whose variants come out at different levels is a
  // bed that changes volume when the chooser picks a different one.
  let peak = 0;
  for (const sample of out) peak = Math.max(peak, Math.abs(sample));
  if (peak > 0) {
    const target = Math.pow(10, PEAK_DBFS / 20);
    const gain = target / peak;
    for (let i = 0; i < out.length; i += 1) out[i] = out[i]! * gain;
  }

  return out;
}

/** Float samples to a 16-bit PCM WAV, which ffmpeg will encode from. */
function wavOf(samples: Float32Array): Buffer {
  const bytes = Buffer.alloc(44 + samples.length * 2);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(36 + samples.length * 2, 4);
  bytes.write("WAVE", 8);
  bytes.write("fmt ", 12);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(2, 22);
  bytes.writeUInt32LE(SAMPLE_RATE, 24);
  bytes.writeUInt32LE(SAMPLE_RATE * 2 * 2, 28);
  bytes.writeUInt16LE(4, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    bytes.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }
  return bytes;
}

/**
 * The built-in maker.
 *
 * Always available. It has no key to be missing, no host to be unreachable and
 * no invoice, which is the entire point of it: the music feature does not have
 * a payment system on its critical path.
 */
export function createSynthMusicMaker(options: { seed?: number } = {}): MusicMaker {
  return {
    name: "synth",
    async make({ mood, file }) {
      const seed = options.seed ?? Math.floor(Math.random() * 0xffffffff);
      const wav = `${file}.wav`;
      try {
        await writeFile(wav, wavOf(renderBed(mood, seed)));
        /*
          Encoded to mp3 rather than left as WAV, and the reason is in
          `ffmpeg.ts`: a looped AAC bed drops out for twenty milliseconds at
          every seam because `-stream_loop` repeats the decoded stream with the
          encoder's padding in it. That comment also records what was measured
          to be seamless — mp3, wav and ogg — so mp3 is safe here and is a
          tenth of the bytes, on a file that is downloaded once per render.
        */
        const encoded = await encode(wav, file);
        if (!encoded) return null;
        return { file };
      } catch {
        return null;
      } finally {
        await rm(wav, { force: true });
      }
    },
  };
}

function encode(from: string, to: string): Promise<boolean> {
  return new Promise((resolve) => {
    const ff = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", from,
      "-c:a", "libmp3lame", "-b:a", "192k", "-ar", String(SAMPLE_RATE),
      to,
    ]);
    // A deadline, like every other child this worker starts. Encoding thirty
    // seconds takes well under a second; the one that wedges is the one nobody
    // expected to.
    const deadline = guard(ff, { ...LIMITS.analysis, what: "encoding a music bed" });
    ff.on("error", () => {
      deadline.clear();
      resolve(false);
    });
    ff.on("close", (code) => {
      deadline.clear();
      resolve(!deadline.expired && code === 0);
    });
  });
}
