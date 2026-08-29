/**
 * Proves the beat detector finds a beat — and, more importantly, refuses to.
 *
 * "Cut it to the beat" sat on this product's list of things it could not do for
 * its whole life. What made it hard is not the cutting, it is knowing where the
 * beat is, and the failure mode of every beat detector is the same: it always
 * answers. An autocorrelation over pink noise reports a confident 117 bpm —
 * measured here, not supposed — and punches placed on that grid land nowhere
 * while looking completely deliberate. That is this product's oldest enemy: the
 * bug that does not fail.
 *
 * So half of this file is the negative half, and it is the half worth having.
 *
 * The tracks are synthesised here rather than committed, for the reason the
 * render suite gives about generated media: a fixture whose tempo we chose
 * ourselves is a fixture whose right answer we know, and a beat detector tested
 * against a song somebody liked is tested against nothing in particular.
 *
 * Usage: node tools/beat-test.mjs
 * Requires: ffmpeg.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-beat-build-"));

function bundle(entry, name) {
  const outfile = path.join(buildDir, name);
  const result = spawnSync(
    require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/worker"] }),
    [
      path.join(repoRoot, entry),
      "--bundle", "--platform=node", "--format=esm", "--target=node22",
      `--outfile=${outfile}`, "--log-level=error",
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0) {
    console.error(`could not bundle ${entry}`);
    process.exit(1);
  }
  return pathToFileURL(outfile).href;
}

const { beatsOf, everyNth } = await import(bundle("artifacts/worker/src/beats.ts", "beats.mjs"));

let checks = 0;
let failures = 0;
const check = (name, ok, detail = "") => {
  checks += 1;
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

const work = await mkdtemp(path.join(tmpdir(), "editly-beat-"));
const SR = 22050;

/** A 16-bit mono WAV written by hand, so the fixtures owe nothing to a codec. */
async function wav(name, samples) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(v * 32000), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SR, 24);
  header.writeUInt32LE(SR * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  const file = path.join(work, name);
  await writeFile(file, Buffer.concat([header, data]));
  return file;
}

/** Clicks at an exact tempo: the fixture whose right answer is arithmetic. */
async function clickTrack(name, bpm, seconds = 12) {
  const n = Math.round(SR * seconds);
  const out = new Float32Array(n);
  const step = 60 / bpm;
  for (let b = 0; b * step < seconds; b += 1) {
    const start = Math.round(b * step * SR);
    for (let i = 0; i < Math.round(SR * 0.03) && start + i < n; i += 1) {
      out[start + i] += 0.9 * Math.exp(-i / (SR * 0.004)) * Math.sin((2 * Math.PI * 1000 * i) / SR);
    }
  }
  return { file: await wav(name, out), bpm, step };
}

/**
 * Something closer to music than a metronome: kick, snare, hats and a pad.
 *
 * A detector can be tuned until it passes on clicks and falls over on anything
 * with a sustained note in it, which is every piece of music anybody would
 * actually put under a video. The pad is here to be in the way.
 */
async function drumTrack(name, bpm, seconds = 12) {
  const n = Math.round(SR * seconds);
  const out = new Float32Array(n);
  const step = 60 / bpm;
  // A fixed generator: a fixture that differs run to run is a flaky check.
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed / 0x7fffffff) * 2 - 1;
  };
  const put = (at, length, gen) => {
    const start = Math.round(at * SR);
    for (let i = 0; i < Math.round(length * SR) && start + i < n; i += 1) {
      if (start + i >= 0) out[start + i] += gen(i / SR);
    }
  };
  for (let b = 0; b * step < seconds; b += 1) {
    const at = b * step;
    if (b % 4 === 0 || b % 4 === 2) {
      put(at, 0.4, (t) => 0.9 * Math.exp(-t * 18) * Math.sin(2 * Math.PI * (110 * Math.exp(-t * 8) + 45) * t));
    } else {
      put(at, 0.3, (t) => 0.5 * Math.exp(-t * 25) * (rand() * 0.7 + Math.sin(2 * Math.PI * 190 * t) * 0.3));
    }
    put(at, 0.12, (t) => 0.25 * Math.exp(-t * 60) * rand());
    put(at + step / 2, 0.12, (t) => 0.25 * Math.exp(-t * 60) * rand());
  }
  for (let i = 0; i < n; i += 1) {
    const t = i / SR;
    out[i] += 0.1 * (Math.sin(2 * Math.PI * 110 * t) + Math.sin(2 * Math.PI * 164.8 * t) + Math.sin(2 * Math.PI * 220 * t)) / 3;
  }
  return { file: await wav(name, out), bpm, step };
}

/** One video frame at 30fps. A cut this close to the beat is on the beat. */
const ONE_FRAME = 1 / 30;

console.log("\nA tempo we chose ourselves is the tempo that comes back");
for (const bpm of [90, 120, 140]) {
  const track = await clickTrack(`click${bpm}.wav`, bpm);
  const grid = await beatsOf(track.file);
  check(`${bpm} bpm is found at all`, grid !== null, "no grid, so nothing below can be read");
  if (!grid) continue;

  check(
    `and read as ${bpm}, not as half or double it`,
    Math.abs(grid.bpm - bpm) / bpm < 0.02,
    `read ${grid.bpm.toFixed(2)} — half or double means the detector is counting the off-beats`,
  );

  // Tempo without phase is a grid on the off-beat, which is a specific and
  // recognisable kind of wrong. Every beat must land on a click.
  const worst = Math.max(
    ...grid.beats
      .filter((at) => at < 10)
      .map((at) => Math.abs(at - Math.round(at / track.step) * track.step)),
  );
  check(
    "and every beat lands within a video frame of a real click",
    worst < ONE_FRAME,
    `worst ${(worst * 1000).toFixed(1)} ms — a grid on the off-beat reads as ${(track.step * 500).toFixed(0)} ms`,
  );
}

console.log("\nAnd music, not only a metronome");
{
  const track = await drumTrack("drums100.wav", 100);
  const grid = await beatsOf(track.file);
  check("a drum pattern under a sustained pad is still read", grid !== null);
  if (grid) {
    check(
      "at the tempo it was written at",
      Math.abs(grid.bpm - 100) / 100 < 0.02,
      `read ${grid.bpm.toFixed(2)}`,
    );
    const worst = Math.max(
      ...grid.beats.filter((at) => at < 10).map((at) => Math.abs(at - Math.round(at / track.step) * track.step)),
    );
    check("and on the beat, not between the beats", worst < ONE_FRAME, `worst ${(worst * 1000).toFixed(1)} ms`);
  }
}

/**
 * The half that matters.
 *
 * Onsets are not rhythm. Noise has them, a room with a door in it has them, and
 * speech has them constantly. A detector that answers anyway produces punches
 * that look intentional and land on nothing, and nobody reports that as a bug —
 * they just think the edit is bad.
 */
console.log("\nAnd nothing at all, when there is nothing there");
{
  const n = SR * 12;

  const noise = new Float32Array(n);
  let seed = 11;
  for (let i = 0; i < n; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    noise[i] = ((seed / 0x7fffffff) * 2 - 1) * 0.4;
  }
  check("noise with onsets everywhere gets no grid", (await beatsOf(await wav("noise.wav", noise))) === null);

  const tone = new Float32Array(n);
  for (let i = 0; i < n; i += 1) tone[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR);
  check("a sustained tone with no onsets at all gets no grid", (await beatsOf(await wav("tone.wav", tone))) === null);

  const quiet = new Float32Array(n);
  check("and silence gets no grid rather than an exception", (await beatsOf(await wav("quiet.wav", quiet))) === null);

  check("a file that is not audio gets no grid", (await beatsOf(path.join(work, "does-not-exist.wav"))) === null);
}

console.log("\nOne punch a bar, and only inside the edit");
{
  const grid = { beats: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5], bpm: 120, confidence: 0.9 };
  const bars = everyNth(grid, 4);
  check("every fourth beat, because a punch on every beat is a strobe", JSON.stringify(bars) === JSON.stringify([0, 2, 4]), JSON.stringify(bars));

  const windowed = everyNth(grid, 4, { from: 1, to: 3 });
  check("and nothing outside the finished edit", JSON.stringify(windowed) === JSON.stringify([2]), JSON.stringify(windowed));

  check("every beat is still available when that is what is wanted", everyNth(grid, 1).length === 10);
}

await rm(work, { recursive: true, force: true });
await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log("The beat is not where this says it is.");
  process.exit(1);
}
console.log("It finds the beat, and says so only when there is one.");
