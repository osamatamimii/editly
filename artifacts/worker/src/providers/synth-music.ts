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
 * Four waveforms, because a saw and a sine at the same pitch are two
 * instruments and that is the cheapest timbral distance there is.
 *
 * `phase` is in turns, so one whole number is one cycle. The saw and square
 * are the naive forms and will alias above a few kilohertz; every voice that
 * uses them goes through the low-pass below, which is what keeps that from
 * being audible as fizz.
 */
function osc(wave: Wave, phase: number): number {
  const p = phase - Math.floor(phase);
  switch (wave) {
    case "sine":
      return Math.sin(2 * Math.PI * p);
    case "tri":
      return 4 * Math.abs(p - Math.floor(p + 0.75) + 0.25) - 1;
    case "saw":
      return 2 * p - 1;
    case "square":
      // Slightly narrow rather than square, which is thinner and sits under a
      // voice better than the hollow 50% duty cycle does.
      return p < 0.45 ? 1 : -1;
  }
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

type Wave = "sine" | "tri" | "saw" | "square";
type Kit = "acoustic" | "eight08" | "brush" | "boom";

interface Recipe {
  bpm: number;
  /** Root of the key, in semitones above A0. */
  root: number;
  /** The four chords, as semitone offsets from the root. */
  chords: number[];
  /** Major or minor third in the triad. */
  third: 3 | 4;
  /** The pad's timbre. A saw and a sine at the same pitch are two instruments. */
  wave: Wave;
  /** How present the drums are. */
  drums: number;
  /** Which drums. This is the axis that separates a genre from a mood. */
  kit: Kit;
  /** Hats per beat: 2 is an offbeat tick, 4 is sixteenths, 8 is a trap roll. */
  hats: number;
  /** How late the offbeats sit, as a fraction of the subdivision. 0 is straight. */
  swing: number;
  /**
   * How bright the pad is, in hertz of low-pass cutoff.
   *
   * It only bites on `tri`, `saw` and `square`. A sine has no harmonics to
   * remove, so a "bright" sine mood is a claim the synthesis does not deliver
   * — which is exactly how `corporate` came to measure as dark as `dark`
   * while its recipe said 5 kHz. Brightness is a choice of waveform first and
   * a cutoff second.
   */
  cutoff: number;
  /** A plucked line over the pad. */
  pluck: boolean;
  /** A sixteenth-note arpeggio through the chord, which reads as movement. */
  arp: boolean;
  /** Weight of a sub-bass sine an octave below the bass. 0 for none. */
  sub: number;
  /** Vinyl hiss and crackle, which is most of what makes lo-fi sound lo-fi. */
  vinyl: number;
}

/**
 * Each mood, as numbers.
 *
 * Three rules govern this table and none of them is taste.
 *
 * **Every tempo sits inside the window `beats.ts` searches** (50-200 bpm) and
 * away from its edges. **Every mood carries drums**: a bed with no transients
 * is a bed whose tempo cannot be measured, `music_tracks.bpm` would be null
 * for it, and the zoom punches would have nothing to land on.
 *
 * **And every pair has to be tellable apart by ear.** That is not a claim made
 * here — `music-test` renders all of them, measures seven acoustic features
 * from the rendered audio, and fails when any two moods land too close
 * together. The list is as long as it can be *and still be honest*: a
 * vocabulary where "corporate" and "calm" produce the same bed lies to the
 * person choosing from it, which is worse than a short list.
 */
const RECIPES: Record<MusicMood, Recipe> = {
  // A minor: i - VI - III - VII, the progression that sounds like waiting.
  calm: { bpm: 72, root: 12, chords: [0, 8, 3, 10], third: 3, wave: "sine", drums: 0.75, kit: "brush", hats: 2, swing: 0, cutoff: 1400, pluck: false, arp: false, sub: 0, vinyl: 0 },
  // C major: I - V - vi - IV.
  upbeat: { bpm: 120, root: 15, chords: [0, 7, 9, 5], third: 4, wave: "tri", drums: 1, kit: "acoustic", hats: 2, swing: 0, cutoff: 3200, pluck: true, arp: false, sub: 0, vinyl: 0 },
  cinematic: { bpm: 76, root: 17, chords: [0, 5, 8, 10], third: 3, wave: "saw", drums: 0.8, kit: "boom", hats: 0, swing: 0, cutoff: 800, pluck: false, arp: false, sub: 0.3, vinyl: 0 },
  dark: { bpm: 90, root: 17, chords: [0, 10, 8, 7], third: 3, wave: "square", drums: 0.8, kit: "acoustic", hats: 2, swing: 0, cutoff: 900, pluck: false, arp: false, sub: 0.6, vinyl: 0 },
  // G major, bright and bouncing.
  playful: { bpm: 110, root: 22, chords: [0, 9, 5, 7], third: 4, wave: "tri", drums: 0.85, kit: "acoustic", hats: 4, swing: 0, cutoff: 4000, pluck: true, arp: false, sub: 0, vinyl: 0 },
  // F major, mellow.
  warm: { bpm: 92, root: 20, chords: [0, 5, 9, 7], third: 4, wave: "sine", drums: 0.75, kit: "brush", hats: 2, swing: 0.12, cutoff: 2200, pluck: true, arp: false, sub: 0, vinyl: 0 },

  /*
    The six added after the first six were heard. Chosen by what short-form
    video actually uses rather than by what makes a varied-looking list — trap
    first, because it is the sound of the feed and its absence was the largest
    hole in the vocabulary.
  */
  trap: { bpm: 140, root: 8, chords: [0, 0, 10, 8], third: 3, wave: "square", drums: 1, kit: "eight08", hats: 8, swing: 0, cutoff: 1100, pluck: false, arp: false, sub: 1, vinyl: 0 },
  lofi: { bpm: 78, root: 18, chords: [0, 5, 9, 7], third: 4, wave: "tri", drums: 0.7, kit: "boom", hats: 4, swing: 0.3, cutoff: 1600, pluck: true, arp: false, sub: 0.2, vinyl: 0.7 },
  corporate: { bpm: 100, root: 15, chords: [0, 5, 7, 5], third: 4, wave: "tri", drums: 0.9, kit: "acoustic", hats: 4, swing: 0, cutoff: 6000, pluck: false, arp: true, sub: 0, vinyl: 0 },
  epic: { bpm: 106, root: 15, chords: [0, 8, 5, 10], third: 3, wave: "saw", drums: 1.2, kit: "boom", hats: 4, swing: 0, cutoff: 3400, pluck: true, arp: false, sub: 0.9, vinyl: 0 },
  retro: { bpm: 126, root: 12, chords: [0, 10, 8, 7], third: 3, wave: "square", drums: 1.1, kit: "eight08", hats: 2, swing: 0, cutoff: 3000, pluck: false, arp: true, sub: 0.55, vinyl: 0 },
  boombap: { bpm: 86, root: 10, chords: [0, 7, 5, 10], third: 3, wave: "tri", drums: 0.95, kit: "boom", hats: 4, swing: 0.3, cutoff: 1400, pluck: true, arp: false, sub: 0.25, vinyl: 0.35 },
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
        value += osc(recipe.wave, f * t) / notes.length;
      }
      pad[index] = value * shape * 0.5;
    }

    // The bass: the root, two octaves down, one note per bar.
    const rootHz = hz(recipe.root + chord - 24);
    for (let i = 0; i < Math.round(bar * SAMPLE_RATE) && barIndex * Math.round(bar * SAMPLE_RATE) + i < total; i += 1) {
      const index = barIndex * Math.round(bar * SAMPLE_RATE) + i;
      const t = i / SAMPLE_RATE;
      const held = envelope(t, 0.02, bar * 0.9);
      bass[index] = Math.sin(2 * Math.PI * rootHz * t) * held * 0.6;
      /*
        And an octave below it, where the 808 lives.

        A sub is not a louder bass: it is a different band. It is what makes a
        trap bed feel like one on a phone speaker that cannot reproduce a note
        of it, and it is the single feature that separates that mood from
        everything else in the table when the features are measured.
      */
      if (recipe.sub > 0) {
        bass[index] += Math.sin(2 * Math.PI * (rootHz / 2) * t) * held * 0.55 * recipe.sub;
      }
    }

    /*
      The plucked line, on the offbeats, from the notes of the chord.

      Only where the recipe asks for it. A pluck over a cinematic drone is a
      music box in a trailer.
    */
    /*
      A sixteenth-note arpeggio through the chord.

      What "corporate" is made of, and "retro": constant motion at a fixed
      subdivision rather than notes placed where they feel right. It reads as
      busy and purposeful, which is exactly the quality those two are asked
      for, and it puts a very different onset density into the measurement
      than a pad does.
    */
    if (recipe.arp) {
      const steps = [0, recipe.third, 7, 12, 7, recipe.third];
      for (let step = 0; step < 16; step += 1) {
        const at = start + step * (beat / 4);
        const note = hz(recipe.root + chord + steps[step % steps.length]! + 12);
        const from = Math.round(at * SAMPLE_RATE);
        for (let i = 0; i < Math.round(0.2 * SAMPLE_RATE) && from + i < total; i += 1) {
          const t = i / SAMPLE_RATE;
          lead[from + i] += osc(recipe.wave === "saw" ? "tri" : recipe.wave, note * t) * envelope(t, 0.003, 0.18) * 0.13;
        }
      }
    }

    if (recipe.pluck) {
      for (let eighth = 0; eighth < 8; eighth += 1) {
        if (random() < 0.45) continue;
        /*
          Swung, like the hats.

          The swing parameter was decoration until this line: it moved the hats
          alone, and the hats are the quietest thing in the mix, so a bed
          declared at 0.22 swing measured as straight. A number in a recipe
          that does not change the output is worse than no number, because the
          next person reads it and believes it.

          The backbeat itself stays exactly on the beat. That is both what a
          swung groove actually does and what keeps `beatsOf` able to find the
          grid.
        */
        const late = eighth % 2 === 1 ? recipe.swing / 2 : 0;
        const at = start + (eighth + late) * (beat / 2);
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
      A backbeat: kick on the odd beats, snare on the even ones, so **every
      beat carries an onset of comparable weight**.

      This replaced a strong/weak accent pattern that put the kick on beats one
      and three and something quieter between them. That is more musical and it
      measured wrong: the strongest period in the file became two beats, and
      `beatsOf` answered half tempo for five of the twelve moods and nothing at
      all for three more. The detector was right about the audio each time.

      A backbeat is also simply what these genres are. The fix and the better
      music turned out to be the same change, which is not always how it goes.
    */
    const onKick = b % 2 === 0;
    const weight = 1;

    /*
      The kick, and the kit is what makes a genre out of a mood.

      `acoustic` is a swept sine gone in a fifth of a second. `eight08` holds
      for two-thirds of a second at a much lower pitch, which is the note you
      feel rather than hear and is most of what "trap" means. `boom` is the
      big slow hit a trailer uses. `brush` barely thumps at all and is there to
      keep a grid findable under a quiet pad rather than to be listened to.
    */
    const kick = {
      acoustic: { from: 120, to: 45, fall: 28, decay: 0.2, level: 1 },
      eight08: { from: 90, to: 32, fall: 9, decay: 0.66, level: 1.15 },
      boom: { from: 150, to: 40, fall: 16, decay: 0.45, level: 1.2 },
      brush: { from: 90, to: 55, fall: 30, decay: 0.14, level: 0.55 },
    }[recipe.kit];

    if (onKick) for (let i = 0; i < Math.round((kick.decay + 0.05) * SAMPLE_RATE) && at + i < total; i += 1) {
      const t = i / SAMPLE_RATE;
      const frequency = kick.to + (kick.from - kick.to) * Math.exp(-t * kick.fall);
      drums[at + i] +=
        Math.sin(2 * Math.PI * frequency * t) * envelope(t, 0.002, kick.decay) * recipe.drums * weight * kick.level;
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
      drums[at + i] += (random() * 2 - 1) * envelope(t, 0.0004, 0.0035) * 0.24 * recipe.drums;
    }

    /*
      The hats, at whatever subdivision the recipe asks for, swung where it
      asks for that too.

      `hats: 8` is the trap roll and it is deliberately uneven: a machine-exact
      roll is the thing that makes a generated beat sound generated. Every hat
      sits *between* the beats the kick is laying down, so it colours the
      groove without competing with the grid `beatsOf` has to find.
    */
    for (let h = 1; h < recipe.hats; h += 1) {
      const fraction = h / recipe.hats;
      // Swing pushes the second half of each pair later, which is the whole
      // difference between a straight beat and one that walks.
      const swung = fraction + (h % 2 === 1 ? recipe.swing / recipe.hats : 0);
      const offbeat = Math.round((b + swung) * beat * SAMPLE_RATE);
      // Swung kits play their hats louder, because a groove nobody can hear
      // is not a groove. Straight kits keep them as colour.
      const heard = recipe.swing > 0.1 ? 0.11 : 0.06;
      const level = recipe.hats >= 8 && random() < 0.3 ? 0.03 : heard;
      for (let i = 0; i < Math.round(0.05 * SAMPLE_RATE) && offbeat + i < total; i += 1) {
        const t = i / SAMPLE_RATE;
        drums[offbeat + i] += (random() * 2 - 1) * envelope(t, 0.001, 0.045) * level * recipe.drums;
      }
    }

    /*
      A snare on two and four, for the kits that have one.

      It is what makes boom bap and trap read as beats rather than as pulses,
      and it is noise plus a tuned body, which is what a snare is.
    */
    if (!onKick) {
      /*
        A snare where the kick is not, so the grid is even.

        `brush` gets a rim tick rather than a crack: it is the kit for a bed
        that must not be listened to, and a full snare on every other beat of a
        calm pad is a drum solo under somebody talking.
      */
      const crack = recipe.kit === "brush" ? 0.22 : 0.62;
      for (let i = 0; i < Math.round(0.18 * SAMPLE_RATE) && at + i < total; i += 1) {
        const t = i / SAMPLE_RATE;
        const body = Math.sin(2 * Math.PI * 190 * t) * 0.4;
        drums[at + i] += ((random() * 2 - 1) * 0.6 + body) * envelope(t, 0.001, 0.16) * crack * recipe.drums;
      }
    }
  }

  /*
    Vinyl: hiss all the way through, and a crackle every so often.

    Almost all of what makes lo-fi sound like lo-fi, and it costs six lines.
    It is also a real acoustic difference rather than a stylistic claim — it
    puts broadband noise into the measurement that no other mood has.
  */
  if (recipe.vinyl > 0) {
    for (let i = 0; i < total; i += 1) {
      drums[i] += (random() * 2 - 1) * 0.012 * recipe.vinyl;
      if (random() < 0.00018) {
        for (let j = 0; j < 120 && i + j < total; j += 1) {
          drums[i + j] += (random() * 2 - 1) * Math.exp(-j / 25) * 0.09 * recipe.vinyl;
        }
      }
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
