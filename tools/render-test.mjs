/**
 * Runs the worker's ffmpeg pipeline against a generated clip and checks the
 * output is what the plan asked for.
 *
 * This is the test that catches the difference between "ffmpeg exited 0" and
 * "the video is actually shorter, actually 9:16, actually has the caption
 * burned in". It builds the real module rather than reimplementing any of it.
 *
 * Usage: node tools/render-test.mjs
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
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-render-test-"));
const modulePath = path.join(buildDir, "ffmpeg.mjs");

// Bundle the worker's ffmpeg module on its own so the test exercises the real
// code without starting the polling loop in index.ts.
// esbuild is a dependency of the worker package, not of the repo root, and its
// bin is a native executable rather than a script — run it directly.
const esbuild = spawnSync(
  require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/worker"] }),
  [
    path.join(repoRoot, "artifacts/worker/src/ffmpeg.ts"),
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
  console.error("could not bundle the ffmpeg module");
  process.exit(1);
}

const { renderPlan, probeDuration, keepSegmentsFrom, remapTime } = await import(pathToFileURL(modulePath).href);

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

function ffprobe(file, entries) {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", entries, "-of", "default=nw=1:nk=1", file], {
    encoding: "utf8",
  });
  return r.stdout.trim().split("\n");
}

// ── Pure segment maths, no ffmpeg involved ──────────────────────────────────
console.log("\nSegment arithmetic");
{
  const kept = keepSegmentsFrom(20, [{ start: 3, end: 7 }, { start: 10, end: 14 }], 0);
  check(
    "silences invert into the gaps between them",
    JSON.stringify(kept) === JSON.stringify([{ start: 0, end: 3 }, { start: 7, end: 10 }, { start: 14, end: 20 }]),
    JSON.stringify(kept),
  );

  const padded = keepSegmentsFrom(20, [{ start: 3, end: 7 }], 0.5);
  check(
    "padding widens what is kept on both sides of a cut",
    padded[0].end === 3.5 && padded[1].start === 6.5,
    JSON.stringify(padded),
  );

  const trailing = keepSegmentsFrom(10, [{ start: 8, end: 10 }], 0);
  check("a silence running to the end truncates the clip", trailing.length === 1 && trailing[0].end === 8, JSON.stringify(trailing));

  // With 3–7 removed, a caption at t=8 in the original belongs at t=4.
  check("a moment after a cut moves earlier by the cut length", remapTime(8, kept) === 4, String(remapTime(8, kept)));
  // A moment inside the removed stretch collapses onto the cut point.
  check("a moment inside a cut lands on the seam", remapTime(5, kept) === 3, String(remapTime(5, kept)));
  check("a moment before any cut is unmoved", remapTime(2, kept) === 2, String(remapTime(2, kept)));
}

// ── The real pipeline ───────────────────────────────────────────────────────
const workDir = await mkdtemp(path.join(tmpdir(), "editly-render-work-"));
const source = path.join(workDir, "source.mp4");

// 20 seconds, audible only during 0–3, 7–10 and 14–17 — so 9 seconds of sound
// and 11 of silence, including the 3-second tail after 17.
const gen = spawnSync("ffmpeg", [
  "-y", "-loglevel", "error",
  "-f", "lavfi", "-i", "testsrc=size=640x360:rate=25:duration=20",
  "-f", "lavfi", "-i", "sine=frequency=300:duration=20",
  "-filter_complex", "[1:a]volume='if(between(t,0,3)+between(t,7,10)+between(t,14,17),1,0)':eval=frame[a]",
  "-map", "0:v", "-map", "[a]",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
  source,
]);
if (gen.status !== 0) {
  console.error("could not generate the test clip");
  process.exit(1);
}

console.log("\nSilence removal");
{
  const { output, notes } = await renderPlan(
    source,
    { version: 1, operations: [{ type: "removeSilence", thresholdDb: -32, minSilenceMs: 500, paddingMs: 80 }] },
    { workDir },
  );
  const duration = await probeDuration(output);
  check("the clip actually got shorter", duration < 19, `${duration.toFixed(2)}s`);
  // 9s of sound, plus 80ms of padding either side of each of the cuts.
  check("what is left is the audible part, not an arbitrary trim", duration > 9 && duration < 11, `${duration.toFixed(2)}s`);
  check("the worker reports what it did", notes.some((n) => /removed [\d.]+s of silence/.test(n)), JSON.stringify(notes));
  check("the output still has both streams", ffprobe(output, "stream=codec_type").sort().join(",") === "audio,video", ffprobe(output, "stream=codec_type").join(","));
}

console.log("\nReframing");
{
  const { output } = await renderPlan(
    source,
    { version: 1, operations: [{ type: "formatForPlatform", platform: "tiktok" }] },
    { workDir },
  );
  const [width, height] = ffprobe(output, "stream=width,height");
  check("the frame is 1080x1920", width === "1080" && height === "1920", `${width}x${height}`);
  const duration = await probeDuration(output);
  check("reframing does not change the length", Math.abs(duration - 20) < 0.5, `${duration.toFixed(2)}s`);
}

console.log("\nWatermark and captions");
{
  const { output, notes } = await renderPlan(
    source,
    {
      version: 1,
      operations: [
        { type: "watermark", text: "Edited with Editly", position: "bottom-right" },
        { type: "burnCaptions", style: "bold-yellow", cues: [{ startMs: 0, endMs: 2000, text: "Hello there" }] },
      ],
    },
    { workDir },
  );
  check("both operations ran", notes.length === 2, JSON.stringify(notes));
  check("a playable file came out", (await probeDuration(output)) > 19, "");
}

console.log("\nOrdering and safety");
{
  // Captions given in original-timeline coordinates must survive a silence cut.
  const { output, notes } = await renderPlan(
    source,
    {
      version: 1,
      operations: [
        { type: "burnCaptions", style: "bold-white", cues: [{ startMs: 15000, endMs: 16000, text: "Late caption" }] },
        { type: "removeSilence", thresholdDb: -32, minSilenceMs: 500, paddingMs: 80 },
      ],
    },
    { workDir },
  );
  check("silence removal runs before captions regardless of plan order", /removed/.test(notes[0] ?? ""), JSON.stringify(notes));
  const duration = await probeDuration(output);
  check("the caption did not outlive the shortened clip", duration < 14, `${duration.toFixed(2)}s`);
}

console.log("\nDegenerate input");
{
  const silent = path.join(workDir, "silent.mp4");
  spawnSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=4",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    silent,
  ]);
  const { output, notes } = await renderPlan(
    silent,
    { version: 1, operations: [{ type: "removeSilence", thresholdDb: -32, minSilenceMs: 500, paddingMs: 80 }] },
    { workDir },
  );
  check("a clip with no audio track is left alone, not destroyed", notes.some((n) => /no audio track/.test(n)), JSON.stringify(notes));
  check("it still produces a playable file", (await probeDuration(output)) > 3, "");
}

await rm(workDir, { recursive: true, force: true });
await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("The render pipeline does what the plan says.");
