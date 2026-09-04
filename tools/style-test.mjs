/**
 * Checks that the style reader can actually tell two edits apart.
 *
 * The trap with a measurement layer is that it runs cleanly and returns
 * confident numbers that mean nothing. So every check here builds two clips
 * that differ in exactly one way — one cut every half second against one
 * unbroken shot, a second of air between lines against a quarter, a saturated
 * grade against a grey one — and asserts the profile moves in the direction it
 * should, by a margin big enough that noise cannot produce it.
 *
 * The clips are generated, not fixtures, so this runs anywhere ffmpeg does.
 *
 * Usage: node tools/style-test.mjs
 * Requires: ffmpeg and ffprobe on PATH.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-style-build-"));
const modulePath = path.join(buildDir, "style-measure.mjs");

const esbuild = spawnSync(
  require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/worker"] }),
  [
    path.join(repoRoot, "artifacts/worker/src/style-measure.ts"),
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--target=node22",
    `--outfile=${modulePath}`,
    "--log-level=error",
  ],
  { stdio: "inherit" },
);
if (esbuild.status !== 0) {
  console.error("could not bundle the style module");
  process.exit(1);
}

const { measureStyle, styleToSettings } = await import(pathToFileURL(modulePath).href);

let checks = 0;
let failures = 0;
const check = (name, ok, detail = "") => {
  checks += 1;
  if (ok) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

const workDir = await mkdtemp(path.join(tmpdir(), "editly-style-"));
const at = (name) => path.join(workDir, name);

function ff(args) {
  const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...args], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${args.join(" ")}`);
}

/** A clip that changes picture every `every` seconds, by hard cut. */
async function cutClip(name, every, seconds) {
  const colours = ["red", "green", "blue", "yellow", "magenta", "cyan", "white", "black"];
  const lines = [];
  const count = Math.round(seconds / every);
  for (let i = 0; i < count; i += 1) {
    const seg = at(`${name}-${i}.mp4`);
    ff([
      "-f", "lavfi",
      "-i", `color=c=${colours[i % colours.length]}:size=320x240:rate=25:duration=${every}`,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "5", seg,
    ]);
    lines.push(`file '${seg}'`);
  }
  const list = at(`${name}.txt`);
  await writeFile(list, lines.join("\n"));
  const out = at(`${name}.mp4`);
  ff(["-f", "concat", "-safe", "0", "-i", list, "-c:v", "libx264", "-pix_fmt", "yuv420p", out]);
  return out;
}

/** One unbroken shot. */
function stillClip(name, colour, seconds) {
  const out = at(`${name}.mp4`);
  ff([
    "-f", "lavfi", "-i", `color=c=${colour}:size=320x240:rate=25:duration=${seconds}`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", out,
  ]);
  return out;
}

/**
 * Speech-shaped audio over a still picture: a tone that runs for `onSec` then
 * drops out for `offSec`, which is what silencedetect sees when someone stops
 * talking between lines.
 */
function talkClip(name, onSec, offSec, gain, seconds) {
  const out = at(`${name}.mp4`);
  const period = onSec + offSec;
  ff([
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`,
    "-f", "lavfi", "-i", `color=c=gray:size=320x240:rate=25:duration=${seconds}`,
    "-filter_complex", `[0:a]volume='if(lt(mod(t,${period}),${onSec}),${gain},0)':eval=frame[a]`,
    "-map", "[a]", "-map", "1:v",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", out,
  ]);
  return out;
}

console.log("\nPacing");
{
  const fast = await cutClip("fast", 0.5, 20);
  const slow = stillClip("slow", "teal", 20);
  const fastStyle = await measureStyle(fast);
  const slowStyle = await measureStyle(slow);

  check(
    "a cut every half second reads as a restless edit",
    fastStyle.cutsPerMinute > 60,
    `${fastStyle.cutsPerMinute}/min`,
  );
  check(
    "one unbroken shot reads as no cuts at all",
    slowStyle.cutsPerMinute === 0,
    `${slowStyle.cutsPerMinute}/min`,
  );

  const fastSettings = styleToSettings(fastStyle);
  const slowSettings = styleToSettings(slowStyle);
  check(
    "the restless reference earns more punches than the calm one",
    fastSettings.punchesPerMinute > slowSettings.punchesPerMinute + 5,
    `${fastSettings.punchesPerMinute} vs ${slowSettings.punchesPerMinute}`,
  );
  check(
    "and a stronger push on the frame",
    fastSettings.kenBurnsTo > slowSettings.kenBurnsTo,
    `${fastSettings.kenBurnsTo} vs ${slowSettings.kenBurnsTo}`,
  );
  check(
    "but never past the ceiling, however chopped the reference",
    fastSettings.kenBurnsTo <= 1.12 && fastSettings.punchesPerMinute <= 12,
    JSON.stringify(fastSettings),
  );
}

console.log("\nBreathing room");
{
  const breathy = talkClip("breathy", 1, 1, 0.5, 20);
  const tight = talkClip("tight", 0.8, 0.25, 0.5, 20);
  const breathyStyle = await measureStyle(breathy);
  const tightStyle = await measureStyle(tight);

  check(
    "a second of air between lines is measured as about a second",
    Math.abs(breathyStyle.keptSilenceMs - 1000) < 150,
    `${breathyStyle.keptSilenceMs} ms`,
  );
  check(
    "a quarter second is measured as about a quarter",
    Math.abs(tightStyle.keptSilenceMs - 250) < 120,
    `${tightStyle.keptSilenceMs} ms`,
  );
  check(
    "so the breathy reference lets us keep longer pauses",
    styleToSettings(breathyStyle).maxSilenceMs > styleToSettings(tightStyle).maxSilenceMs + 200,
    `${styleToSettings(breathyStyle).maxSilenceMs} vs ${styleToSettings(tightStyle).maxSilenceMs}`,
  );
  check(
    "and neither is allowed to mean 'leave every pause in'",
    styleToSettings(breathyStyle).maxSilenceMs <= 900,
    `${styleToSettings(breathyStyle).maxSilenceMs} ms`,
  );
}

console.log("\nSound");
{
  // Both gains stay above the "this is room tone, not a mix" floor, so this
  // checks the loudness reading itself rather than the silent-clip fallback.
  const loud = talkClip("loud", 0.8, 0.25, 1.0, 20);
  const quiet = talkClip("quiet", 0.8, 0.25, 0.125, 20);
  const loudStyle = await measureStyle(loud);
  const quietStyle = await measureStyle(quiet);

  check("a clip with a mix reports that it measured one", loudStyle.audioMeasured, "");
  check(
    "louder audio reads louder",
    loudStyle.targetLufs > quietStyle.targetLufs + 6,
    `${loudStyle.targetLufs} vs ${quietStyle.targetLufs} LUFS`,
  );

  const mute = stillClip("mute", "teal", 8);
  const muteStyle = await measureStyle(mute);
  check("a silent reference admits it has no loudness to give", !muteStyle.audioMeasured, "");
  check(
    "and we fall back to the platform target instead of matching silence",
    styleToSettings(muteStyle).targetLufs === -14,
    `${styleToSettings(muteStyle).targetLufs} LUFS`,
  );
}

console.log("\nGrade");
{
  const graded = stillClip("graded", "red", 8);
  const flat = stillClip("flat", "gray", 8);
  const gradedStyle = await measureStyle(graded);
  const flatStyle = await measureStyle(flat);

  check(
    "a saturated reference reads saturated",
    gradedStyle.saturation > 0.3,
    `${gradedStyle.saturation}`,
  );
  check("a grey one reads as no colour at all", flatStyle.saturation < 0.02, `${flatStyle.saturation}`);

  const mid = stillClip("mid", "0x804040", 8);
  const midStyle = await measureStyle(mid);
  check(
    "pushing a flat source toward a graded reference lifts saturation",
    styleToSettings(gradedStyle, midStyle).saturationBoost > 1.05,
    `${styleToSettings(gradedStyle, midStyle).saturationBoost}`,
  );
  check(
    "pushing a graded source toward a flatter reference pulls it back",
    styleToSettings(midStyle, gradedStyle).saturationBoost < 0.98,
    `${styleToSettings(midStyle, gradedStyle).saturationBoost}`,
  );
  check(
    "with no source to compare against, the grade is left alone",
    styleToSettings(gradedStyle).saturationBoost === 1,
    `${styleToSettings(gradedStyle).saturationBoost}`,
  );
  check(
    "a near-monochrome source cannot produce a runaway multiplier",
    styleToSettings(gradedStyle, flatStyle).saturationBoost === 1,
    `${styleToSettings(gradedStyle, flatStyle).saturationBoost}`,
  );

  const bright = stillClip("bright", "white", 8);
  const dark = stillClip("dark", "black", 8);
  check(
    "brightness separates a bright reference from a dark one",
    (await measureStyle(bright)).brightness - (await measureStyle(dark)).brightness > 0.6,
    "",
  );
}

console.log("\nMovement");
{
  const moving = at("moving.mp4");
  ff([
    "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=10",
    "-vf", "scroll=horizontal=0.02",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", moving,
  ]);
  const still = stillClip("stillshot", "teal", 10);
  const movingStyle = await measureStyle(moving);
  const stillStyle = await measureStyle(still);

  check("a moving picture reads as movement", movingStyle.motion > 0.5, `${movingStyle.motion}`);
  check("a locked-off shot reads as none", stillStyle.motion === 0, `${stillStyle.motion}`);
  check(
    "motion is normalised, not raw — it never leaves 0..1",
    movingStyle.motion <= 1,
    `${movingStyle.motion}`,
  );
  check(
    "and the punch strength it drives stays inside its range",
    styleToSettings(movingStyle).punchAmount <= 0.22 &&
      styleToSettings(stillStyle).punchAmount >= 0.06 &&
      styleToSettings(movingStyle).punchAmount > styleToSettings(stillStyle).punchAmount,
    `${styleToSettings(movingStyle).punchAmount} vs ${styleToSettings(stillStyle).punchAmount}`,
  );
}

console.log("\nReading only what it needs");
{
  const long = stillClip("long", "teal", 12);
  const style = await measureStyle(long);
  check(
    "it reports how much of the reference it actually looked at",
    Math.abs(style.sampledSeconds - 12) < 0.6,
    `${style.sampledSeconds}s`,
  );
  check(
    "and a short source's whole length is its sampled length",
    Math.abs(style.sourceSeconds - 12) < 0.6,
    `${style.sourceSeconds}s`,
  );

  // A source longer than the sample window: the reader looks at the first two
  // minutes, but the whole length has to be reported too, because a punch
  // budget is spread over the entire source and using the 120s window kept a
  // fraction of the punches on a long talk.
  const overCap = at("over-cap.mp4");
  ff(["-f", "lavfi", "-i", "color=c=teal:size=160x120:rate=2:duration=150", "-c:v", "libx264", "-pix_fmt", "yuv420p", overCap]);
  const capped = await measureStyle(overCap);
  check(
    "a source past the sample cap still samples only the window",
    Math.abs(capped.sampledSeconds - 120) < 1,
    `${capped.sampledSeconds}s`,
  );
  check(
    "but reports its whole length, not the window",
    Math.abs(capped.sourceSeconds - 150) < 2,
    `${capped.sourceSeconds}s`,
  );
  check(
    "so the source length exceeds the sampled length on a long source",
    capped.sourceSeconds > capped.sampledSeconds + 20,
    `source ${capped.sourceSeconds}s vs sampled ${capped.sampledSeconds}s`,
  );
}

console.log("\nA reference with no readable video says so, rather than measuring grey");
{
  /*
    The reference gate accepts by extension, so an audio file — or anything
    signalstats samples no frame from — reaches the reader. Its empty video
    readings averaged to 0, which is a real flat-grey grade, not "not measured".
    `gradeMeasured` has to be false so nothing downstream pulls the footage grey.
  */
  const audioOnly = at("audio-only.m4a");
  ff(["-f", "lavfi", "-i", "sine=frequency=440:duration=6", "-c:a", "aac", audioOnly]);
  const style = await measureStyle(audioOnly);
  check("a reference with no video reports its grade was not measured", style.gradeMeasured === false, JSON.stringify(style));
  check(
    "and matching a flat source against it leaves the colour alone",
    styleToSettings(style, await measureStyle(stillClip("realvid", "red", 4))).saturationBoost === 1,
    `${styleToSettings(style, { saturation: 0.3, gradeMeasured: true }).saturationBoost}`,
  );
  // A real video reference still reports it was measured.
  const real = await measureStyle(stillClip("realref", "red", 4));
  check("a reference with video reports its grade was measured", real.gradeMeasured === true, JSON.stringify(real.gradeMeasured));
}

await rm(workDir, { recursive: true, force: true });
await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("The style reader tells one edit from another.");
