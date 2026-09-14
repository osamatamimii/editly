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

/**
 * Average colour of one *region* of one frame.
 *
 * The whole-frame average above answers "is this colour anywhere in shot",
 * which is the right question for a cutaway and the wrong one for a box: an
 * inset placed in the wrong half of the frame gives exactly the same average
 * as one placed in the right half. `crop` first, then average.
 *
 * Fractions of the frame, the same four numbers the plan takes, so a check
 * reads against the box it is checking.
 */
function averageColourIn(file, seconds, box) {
  const out = path.join(buildDir, `region-${Math.random().toString(36).slice(2)}.txt`);
  const r = spawnSync(
    "ffmpeg",
    [
      "-hide_banner", "-loglevel", "error", "-y",
      "-ss", String(seconds), "-i", file, "-frames:v", "1",
      "-vf", `crop=iw*${box.w}:ih*${box.h}:iw*${box.x}:ih*${box.y},scale=1:1`,
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

console.log("\nA photograph cut in as b-roll");
{
  /*
    The case a shop owner's advertisement is made of.

    A dropshipper has supplier clips and product photographs, and the
    photographs belong in the ad as cutaways over the footage. That is a legal
    plan — `insertBRoll` names an asset id and the contract has never said the
    asset must be a video — and it used to render as nothing at all.

    `-i <still>` gives an input of exactly one frame. `trim` took that frame,
    `setpts` moved it to the top of the window, and `overlay` with
    `eof_action=pass` let the base through from there on. So the picture never
    changed for a single sample inside the window, ffmpeg exited zero, and the
    note said "cut to b-roll at 2.0s".

    This is the shape of failure this whole file exists for, arriving through
    the one door it had not been pointed at: the video b-roll check above
    passed the entire time.
  */
  const ctx = {
    workDir: await mkdtemp(path.join(tmpdir(), "editly-brimg-run-")),
    assets: new Map([["asset-photo", { file: image, kind: "image" }]]),
  };
  const plan = {
    version: 1,
    operations: [
      { type: "insertBRoll", assetId: "asset-photo", at: 2, durationSeconds: 2, fit: "cover", keepSourceAudio: true },
    ],
  };
  const result = await renderPlan(source, plan, ctx);

  // Three samples inside, not one. A still that appears for a frame and a
  // still that holds for two seconds are different pictures, and one sample in
  // the middle cannot tell them apart.
  const early = averageColourAt(result.output, 2.2);
  const middle = averageColourAt(result.output, 3);
  const late = averageColourAt(result.output, 3.8);
  const after = averageColourAt(result.output, 6);
  // Filling the frame, so the average *is* the colour rather than a fraction
  // of it: magenta is red and blue high with green low.
  const magentaish = (c) => c && c[0] > 90 && c[2] > 90 && c[1] < c[0] * 0.5;

  check("the photograph is on the frame as the cutaway opens", magentaish(early), early ? `rgb(${early})` : "no frame");
  check("still there in the middle of it", magentaish(middle), middle ? `rgb(${middle})` : "no frame");
  check("and still there at its end, rather than one frame and gone", magentaish(late), late ? `rgb(${late})` : "no frame");
  check("the source is back afterwards", !magentaish(after), after ? `rgb(${after})` : "no frame");
  check("and it is reported as a cutaway", result.notes.some((n) => n.includes("cut to b-roll")), result.notes.join("; "));
  await rm(ctx.workDir, { recursive: true, force: true });
}

console.log("\nThe cutaway's own edge");
{
  /*
    A cutaway has two edges, and until now both were hard.

    That is not a defect — short form pops its b-roll, and a hard cutaway over
    a talking head reads as deliberate — but it was the only thing this
    operation could do, and the documentary edge is the one that stops a
    cutaway reading as a glitch when the two pictures are close in brightness.
    So it is a field, and `cut` stays the default: a stored plan replayed has
    to produce what it produced before.

    Measured on black under green, because a ramp between them is a number: a
    frame 80ms into a 160ms dissolve is neither, and a frame 80ms into a hard
    cut is already fully the cutaway. One fixture, two plans, the same sample
    times.
  */
  const plan = (edge) => ({
    version: 1,
    operations: [
      { type: "insertBRoll", assetId: "asset-broll", at: 2, durationSeconds: 3, fit: "cover", keepSourceAudio: true, edge },
    ],
  });
  const runWith = async (edge) => {
    const ctx = {
      workDir: await mkdtemp(path.join(tmpdir(), `editly-edge-${edge}-`)),
      assets: new Map([["asset-broll", { file: broll, kind: "video" }]]),
    };
    const result = await renderPlan(source, plan(edge), ctx);
    const read = {
      notes: result.notes,
      // 80ms in: halfway through a 160ms ramp, and long past a hard cut.
      opening: averageColourAt(result.output, 2.08),
      middle: averageColourAt(result.output, 3.5),
      // 80ms before the end of the window, which is the out ramp's midpoint.
      closing: averageColourAt(result.output, 4.92),
      after: averageColourAt(result.output, 5.6),
    };
    await rm(ctx.workDir, { recursive: true, force: true });
    return read;
  };

  const hard = await runWith("cut");
  const soft = await runWith("dissolve");
  /*
    Measured against the cutaway itself, not against full green.

    `color=c=green` is (0,128,0) and not (0,255,0), so a threshold written
    against the top of the range would have called a fully present cutaway
    half present. The hard cut's middle *is* the cutaway at full strength, by
    construction, so every reading below is a fraction of that — which also
    means the check keeps working if the fixture's colour ever changes.
  */
  const full = hard.middle ? hard.middle[1] : NaN;
  const greenness = (c) => (c && full > 0 ? c[1] / full : NaN);
  check("the fixture is a colour this can be measured against", full > 60, String(full));

  check(
    "a hard cutaway is fully there one frame in",
    greenness(hard.opening) > 0.7,
    `rgb(${hard.opening})`,
  );
  check(
    "and a dissolved one is only part way",
    greenness(soft.opening) > 0.1 && greenness(soft.opening) < 0.7,
    `rgb(${soft.opening}) against hard rgb(${hard.opening})`,
  );
  check(
    "which is the whole difference: at the same instant, one is arriving and the other has arrived",
    greenness(soft.opening) < greenness(hard.opening) - 0.15,
    `soft ${greenness(soft.opening).toFixed(2)}, hard ${greenness(hard.opening).toFixed(2)}`,
  );
  check(
    "it leaves the same way it came",
    greenness(soft.closing) > 0.1 && greenness(soft.closing) < 0.7,
    `rgb(${soft.closing})`,
  );
  /*
    And the middle is the check that the ramp is an edge rather than a veil.

    The failure it is for is a ramp that never finishes. A fade written over
    the whole length of the cutaway instead of over its first sixth leaves the
    picture half transparent for its entire life, which is not a dissolve into
    b-roll, it is a b-roll nobody can see. Measured by doing it: the middle
    read 32 against the 129 below, while "arriving softly" and "leaving softly"
    both still passed, because a veil is soft at both ends too.
  */
  check(
    "and is fully the cutaway in between, not a veil over the whole of it",
    greenness(soft.middle) > 0.7,
    `rgb(${soft.middle})`,
  );
  check("the source is back afterwards", greenness(soft.after) < 0.2, `rgb(${soft.after})`);
  check(
    "and the note says which of the two it did",
    hard.notes.some((n) => /cut to b-roll/.test(n)) &&
      soft.notes.some((n) => /dissolved into b-roll/.test(n)),
    JSON.stringify([hard.notes, soft.notes]),
  );
}

/*
  A box, which is the difference between a cutaway and an inset.

  `position` + `scale` place a logo on a nine-point grid. They cannot say "the
  lower 40% of the frame, full width" — which is where a screen recording sits
  in four of the six references Osama sent, and what a split composition is
  made of. So both overlay operations now take an explicit rectangle.

  The checks below are regions rather than whole-frame averages on purpose: an
  inset dropped in the wrong half of the frame produces exactly the same
  average as one in the right half, so the check that reads the average is a
  check that cannot tell the two apart.
*/
const blue = path.join(work, "blue.mp4");
run(["-f", "lavfi", "-i", "color=c=blue:s=640x360:d=8:r=25",
     "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
     "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", blue]);

const isGreen = (c) => c && c[1] > 90 && c[0] < 80 && c[2] < 80;
const isBlue  = (c) => c && c[2] > 90 && c[1] < 80;
const isMagenta = (c) => c && c[0] > 90 && c[2] > 90 && c[1] < 80;

console.log("\nB-roll in a box is an inset, not a cutaway");
{
  const ctx = {
    workDir: await mkdtemp(path.join(tmpdir(), "editly-box-run-")),
    assets: new Map([["asset-broll", { file: broll, kind: "video" }]]),
  };
  const plan = {
    version: 1,
    operations: [
      { type: "insertBRoll", assetId: "asset-broll", at: 2, durationSeconds: 2,
        fit: "cover", keepSourceAudio: true,
        box: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 } },
    ],
  };
  const result = await renderPlan(blue, plan, ctx);

  const inBox  = averageColourIn(result.output, 3, { x: 0.55, y: 0.55, w: 0.4, h: 0.4 });
  const outBox = averageColourIn(result.output, 3, { x: 0.05, y: 0.05, w: 0.4, h: 0.4 });

  check("the clip is inside its box", isGreen(inBox), inBox ? `rgb(${inBox})` : "no frame");
  // The half of the check that matters: without it, a "box" that quietly
  // covered the whole frame — which is what the old code did with any box —
  // would pass.
  check("and the picture is still there outside it", isBlue(outBox), outBox ? `rgb(${outBox})` : "no frame");

  const before = averageColourIn(result.output, 1, { x: 0.55, y: 0.55, w: 0.4, h: 0.4 });
  check("and the box is empty before its moment", isBlue(before), before ? `rgb(${before})` : "no frame");
  await rm(ctx.workDir, { recursive: true, force: true });
}

console.log("\nAn image in a box takes the band it was given");
{
  const ctx = {
    workDir: await mkdtemp(path.join(tmpdir(), "editly-imgbox-run-")),
    assets: new Map([["asset-image", { file: image, kind: "image" }]]),
  };
  const plan = {
    version: 1,
    operations: [
      // Full width, lower 40% — the shape `position` and `scale` cannot say.
      { type: "overlayImage", assetId: "asset-image", at: 1, durationSeconds: 3,
        position: "center", scale: 0.4, opacity: 1, fit: "cover",
        box: { x: 0, y: 0.6, w: 1, h: 0.4 } },
    ],
  };
  const result = await renderPlan(blue, plan, ctx);

  /*
    Read at the band's far edge, not its middle.

    The first spelling of this probed the centre of the band — and a centred
    40%-wide image, which is what `scale` alone produces, *also* reaches there.
    So the check passed when the box was ignored entirely, which is the one
    thing it was written to catch. Found by breaking it on purpose.

    The left edge is the discriminating place: a full-width box covers it, a
    centred square cannot reach it at any scale below 1.
  */
  const edge  = averageColourIn(result.output, 2, { x: 0.02, y: 0.68, w: 0.14, h: 0.26 });
  const band  = averageColourIn(result.output, 2, { x: 0.4, y: 0.68, w: 0.2, h: 0.26 });
  const above = averageColourIn(result.output, 2, { x: 0.1, y: 0.1, w: 0.8, h: 0.3 });

  check("the image reaches the far edge of its band", isMagenta(edge), edge ? `rgb(${edge})` : "no frame");
  check("and fills its middle", isMagenta(band), band ? `rgb(${band})` : "no frame");
  check("and nothing above it", isBlue(above), above ? `rgb(${above})` : "no frame");
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
