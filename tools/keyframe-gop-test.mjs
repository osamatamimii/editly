/**
 * The keyframe cadence is two seconds of *this* video, not two seconds of 30fps.
 *
 * The export set `-g 60`: a keyframe every sixty frames. At 30fps that is the
 * two seconds these platforms want, so that when they re-encode on upload they
 * can cut on a keyframe. At 24fps sixty frames is 2.5 seconds, at 25 it is 2.4
 * — past the ceiling, on every clip whose source is not exactly 30fps, which is
 * most of them (film is 24, PAL and a lot of phones are 25). Nothing failed:
 * the file plays, and the platform's own re-encode is a shade worse, silently.
 *
 * `videoEncodeFor` now computes the interval from the frame rate: `round(fps*2)`
 * frames, which is two seconds at any rate. This proves it — both the number it
 * writes and the keyframe spacing a real encode with that number produces.
 * Revert to a fixed 60 and a 24fps encode's keyframes fall 2.5s apart: red.
 *
 * Usage: node tools/keyframe-gop-test.mjs
 * Requires: ffmpeg/ffprobe.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-gop-build-"));
const workRoot = await mkdtemp(path.join(tmpdir(), "editly-gop-work-"));

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

const { videoEncodeFor } = await import(bundle("artifacts/worker/src/ffmpeg.ts", "ffmpeg.mjs"));

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
const section = (t) => console.log(`\n${t}`);

const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH ?? "ffprobe";
if (spawnSync(FFMPEG, ["-version"]).status !== 0) {
  console.error("ffmpeg is not on the PATH; this suite encodes a real clip and probes its keyframes.");
  process.exit(1);
}

/** The value ffmpeg was handed after a given flag. */
function valueAfter(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

// ── The number it writes ──────────────────────────────────────────────────────

section("The GOP is two seconds of the actual frame rate");
{
  check("24fps → a keyframe every 48 frames", valueAfter(videoEncodeFor(1080, 24), "-g") === "48", valueAfter(videoEncodeFor(1080, 24), "-g"));
  check("25fps → 50", valueAfter(videoEncodeFor(1080, 25), "-g") === "50", valueAfter(videoEncodeFor(1080, 25), "-g"));
  check("30fps → 60", valueAfter(videoEncodeFor(1080, 30), "-g") === "60", valueAfter(videoEncodeFor(1080, 30), "-g"));
  check("60fps → 120", valueAfter(videoEncodeFor(1080, 60), "-g") === "120", valueAfter(videoEncodeFor(1080, 60), "-g"));
  check("keyint_min follows at one second (24 → 24)", valueAfter(videoEncodeFor(1080, 24), "-keyint_min") === "24", valueAfter(videoEncodeFor(1080, 24), "-keyint_min"));
  check("a missing/zero fps falls back to 30, not to NaN", valueAfter(videoEncodeFor(1080, 0), "-g") === "60", valueAfter(videoEncodeFor(1080, 0), "-g"));

  // The 4K branch keeps its own preset/crf/level and still gets a real GOP.
  const uhd = videoEncodeFor(2160, 24);
  check("4K keeps crf 20 and level 5.1", valueAfter(uhd, "-crf") === "20" && valueAfter(uhd, "-level") === "5.1", `${valueAfter(uhd, "-crf")}/${valueAfter(uhd, "-level")}`);
  check("and 4K's GOP is also the frame-rate one", valueAfter(uhd, "-g") === "48", valueAfter(uhd, "-g"));
}

// ── The spacing it actually produces ──────────────────────────────────────────

/** Encode a clip at `fps` using the real encode args, and return keyframe times. */
function keyframeTimes(fps) {
  const src = path.join(workRoot, `src-${fps}.mp4`);
  const made = spawnSync(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `testsrc=size=320x568:rate=${fps}:duration=4`,
    ...videoEncodeFor(1080, fps),
    src,
  ]);
  if (made.status !== 0) {
    console.error(`could not encode src-${fps}: ${String(made.stderr).slice(-400)}`);
    process.exit(1);
  }
  const out = spawnSync(FFPROBE, [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "frame=key_frame,pts_time",
    "-of", "csv=p=0", src,
  ]);
  const times = [];
  for (const line of String(out.stdout).trim().split("\n")) {
    const [key, t] = line.split(",");
    if (key === "1") times.push(Number(t));
  }
  return times.filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
}

section("A 24fps encode keeps keyframes within two seconds");
{
  const times = keyframeTimes(24);
  check("there is more than one keyframe to measure", times.length >= 2, JSON.stringify(times));
  let maxGap = 0;
  for (let i = 1; i < times.length; i++) maxGap = Math.max(maxGap, times[i] - times[i - 1]);
  // Two seconds plus a frame of slack. On a fixed -g 60 this is 2.5s → red.
  check("the largest keyframe gap is at most ~2s", maxGap <= 2.05, `maxGap=${maxGap.toFixed(3)}s`);
}

await rm(buildDir, { recursive: true, force: true });
await rm(workRoot, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
console.log("Two seconds is two seconds, whatever the frame rate.");
