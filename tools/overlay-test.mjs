/**
 * Proves the library actually reaches the picture.
 *
 * The weak version of this test renders a plan with an overlay in it and checks
 * ffmpeg exited zero. That passes when the overlay is silently dropped, which
 * is exactly the failure worth catching — a graph that composites nothing still
 * encodes a perfectly good video of the original.
 *
 * So this reads pixels. It builds a black source and a pure-magenta image, asks
 * for the image between two seconds, and then samples the frame **inside** the
 * window (magenta must be there) and the frame **outside** it (magenta must not
 * be). B-roll is checked the same way, with a green clip.
 *
 * Usage: node tools/overlay-test.mjs
 * Requires: ffmpeg and ffprobe on PATH.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-overlay-test-"));
const modulePath = path.join(buildDir, "ffmpeg.mjs");

const esbuild = spawnSync(
  require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/worker"] }),
  [
    path.join(repoRoot, "artifacts/worker/src/ffmpeg.ts"),
    "--bundle", "--platform=node", "--format=esm", "--target=node22",
    `--outfile=${modulePath}`, "--log-level=error",
  ],
  { stdio: "inherit" },
);
if (esbuild.status !== 0) {
  console.error("could not bundle the ffmpeg module");
  process.exit(1);
}
const { renderPlan } = await import(pathToFileURL(modulePath).href);

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

function run(args) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr?.slice(0, 400) ?? "ffmpeg failed");
}

/**
 * Average colour of one frame, as [r, g, b].
 *
 * Read by scaling the frame to a single pixel and printing it: cheaper than
 * decoding a PNG here, and it answers the only question being asked — is this
 * colour anywhere in shot.
 */
function averageColourAt(file, seconds) {
  const out = path.join(buildDir, `probe-${seconds}-${Math.random().toString(36).slice(2)}.txt`);
  const r = spawnSync(
    "ffmpeg",
    [
      "-hide_banner", "-loglevel", "error", "-y",
      "-ss", String(seconds), "-i", file, "-frames:v", "1",
      "-vf", "scale=1:1",
      "-f", "rawvideo", "-pix_fmt", "rgb24", out,
    ],
    { encoding: "utf8" },
  );
  if (r.status !== 0) return null;
  const bytes = require("node:fs").readFileSync(out);
  return [bytes[0], bytes[1], bytes[2]];
}

const work = await mkdtemp(path.join(tmpdir(), "editly-ov-"));

// A black clip, so anything coloured on the frame came from an overlay.
const source = path.join(work, "source.mp4");
run(["-f", "lavfi", "-i", "color=c=black:s=640x360:d=8:r=25",
     "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
     "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", source]);

const image = path.join(work, "logo.png");
run(["-f", "lavfi", "-i", "color=c=magenta:s=200x200:d=1", "-frames:v", "1", image]);

const broll = path.join(work, "broll.mp4");
run(["-f", "lavfi", "-i", "color=c=green:s=640x360:d=4:r=25", "-c:v", "libx264", "-pix_fmt", "yuv420p", broll]);

console.log("\nAn image laid over the frame");
{
  const ctx = {
    workDir: await mkdtemp(path.join(tmpdir(), "editly-ov-run-")),
    assets: new Map([["asset-image", { file: image, kind: "image" }]]),
  };
  const plan = {
    version: 1,
    operations: [
      { type: "overlayImage", assetId: "asset-image", at: 3, durationSeconds: 2,
        position: "center", scale: 0.5, opacity: 1 },
    ],
  };
  const result = await renderPlan(source, plan, ctx);

  const inside = averageColourAt(result.output, 4);
  const outside = averageColourAt(result.output, 1);

  // Magenta is high red, low green, high blue. Averaged over a black frame with
  // a quarter-area overlay it stays unmistakably red-and-blue-dominant.
  const magentaish = (c) => c && c[0] > 20 && c[2] > 20 && c[1] < c[0] * 0.6;

  check("the image is on the frame inside its window", magentaish(inside), inside ? `rgb(${inside})` : "no frame");
  check("and is not on the frame outside it", !magentaish(outside), outside ? `rgb(${outside})` : "no frame");
  check("the render says what it did", result.notes.some((n) => n.includes("laid an image")), result.notes.join("; "));
  await rm(ctx.workDir, { recursive: true, force: true });
}

console.log("\nB-roll cut in over the source");
{
  const ctx = {
    workDir: await mkdtemp(path.join(tmpdir(), "editly-br-run-")),
    assets: new Map([["asset-broll", { file: broll, kind: "video" }]]),
  };
  const plan = {
    version: 1,
    operations: [
      { type: "insertBRoll", assetId: "asset-broll", at: 2, durationSeconds: 2, fit: "cover", keepSourceAudio: true },
    ],
  };
  const result = await renderPlan(source, plan, ctx);

  const inside = averageColourAt(result.output, 3);
  const outside = averageColourAt(result.output, 6);
  const greenish = (c) => c && c[1] > 40 && c[1] > c[0] * 1.5 && c[1] > c[2] * 1.5;

  check("b-roll fills the frame inside its window", greenish(inside), inside ? `rgb(${inside})` : "no frame");
  check("and the source is back afterwards", !greenish(outside), outside ? `rgb(${outside})` : "no frame");
  await rm(ctx.workDir, { recursive: true, force: true });
}

console.log("\nAn asset the project does not have");
{
  const ctx = { workDir: await mkdtemp(path.join(tmpdir(), "editly-miss-run-")), assets: new Map() };
  const plan = {
    version: 1,
    operations: [
      { type: "overlayImage", assetId: "not-ours", at: 1, durationSeconds: 1,
        position: "center", scale: 0.5, opacity: 1 },
      { type: "normalizeLoudness", targetLufs: -14 },
    ],
  };
  const result = await renderPlan(source, plan, ctx);
  check(
    "is dropped with a note rather than opened",
    result.notes.some((n) => n.includes("not in this project")),
    result.notes.join("; "),
  );
  await rm(ctx.workDir, { recursive: true, force: true });
}

await rm(work, { recursive: true, force: true });
await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log("The library does not reach the picture.");
  process.exit(1);
}
console.log("What the plan puts on screen is on screen.");
