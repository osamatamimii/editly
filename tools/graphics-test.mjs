/**
 * What a reference draws, and how it arrived.
 *
 * Two halves, and the split is the point. The first builds grids by hand — a
 * frame here is nine lines of code and the expected answer is not in doubt —
 * and checks every threshold in `graphics.ts` against the case it exists to
 * refuse. The second renders four small videos with ffmpeg and reads them the
 * way the worker will, because a threshold that is right on a grid somebody
 * wrote and wrong on a picture a codec produced is not right.
 *
 * Requires: ffmpeg on PATH for the second half; it is skipped, not failed,
 * without one.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-graphics-test-"));
const modulePath = path.join(buildDir, "graphics.mjs");
const esbuild = spawnSync(
  require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/worker"] }),
  [
    path.join(repoRoot, "artifacts/worker/src/graphics.ts"),
    "--bundle", "--platform=node", "--format=esm", "--target=node22",
    `--outfile=${modulePath}`, "--log-level=error",
  ],
  { stdio: "inherit" },
);
if (esbuild.status !== 0) process.exit(1);

const { GRID, SAMPLE_FPS, momentsFrom, readEntrance, boxOf, readGraphics } =
  await import(pathToFileURL(modulePath).href);

let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failed += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};
const section = (name) => console.log(`\n${name}`);

/* ── Frames built by hand ───────────────────────────────────────────────── */

const CELLS = GRID * GRID;

/** A flat grid at one value. */
const flat = (value) => new Uint8Array(CELLS).fill(value);

/** A grid with a rectangle painted on it, in cell coordinates. */
function withRect(base, { x, y, w, h }, value) {
  const out = Uint8Array.from(base);
  for (let row = y; row < y + h; row += 1) {
    for (let col = x; col < x + w; col += 1) {
      if (row < 0 || row >= GRID || col < 0 || col >= GRID) continue;
      out[row * GRID + col] = value;
    }
  }
  return out;
}

/** The share of cells that differ by more than the module's own noise floor. */
function changedShare(a, b) {
  let n = 0;
  for (let i = 0; i < CELLS; i += 1) if (Math.abs((b[i] ?? 0) - (a[i] ?? 0)) > 10) n += 1;
  return n / CELLS;
}

const GROUND = 40;
const INK = 220;
/** Long enough to clear MIN_HOLD_SECONDS at the sample rate, with room over. */
const HOLD = Math.round(1.2 * SAMPLE_FPS);

section("A card that comes up from below is read as a rise");
{
  // Six samples of travel: a band 12 cells tall climbing from off the bottom
  // to y=30, then holding.
  const frames = [flat(GROUND), flat(GROUND)];
  for (const y of [38, 34, 30, 27, 25, 24]) {
    frames.push(withRect(flat(GROUND), { x: 6, y, w: 36, h: 10 }, INK));
  }
  for (let i = 0; i < HOLD; i += 1) {
    frames.push(withRect(flat(GROUND), { x: 6, y: 24, w: 36, h: 10 }, INK));
  }

  const moments = momentsFrom(frames);
  check("one thing was drawn", moments.length === 1, `${moments.length} found`);
  const m = moments[0];
  if (m) {
    check("and it came up", m.enter === "rise", m.enter);
    /*
      Centre to centre, which is the thing a `travel` replays.

      The band is the same height throughout, so its centre moves exactly as
      far as its top edge does — 14 cells. Both rectangles are wholly on the
      frame on purpose: a band that starts half off the bottom has a *visible*
      centre that is not its real one, and an expectation written against its
      top edge would be wrong by half a band while the measurement was right.
    */
    check("and the travel is roughly what it travelled",
      Math.abs(m.travel - (38 - 24) / GRID) < 2 / GRID, m.travel.toFixed(3));
    /*
      The settled box, not the box of whatever was still moving.

      This is the check that caught the first spelling, which measured each
      frame of the burst against the one before it: a card that has finished
      moving stops differing from its predecessor, so the region collapsed to
      the last few pixels in motion and every box came back a sliver. Every
      box in the burst is measured against the frame before the arrival
      started, which is the picture with nothing drawn on it.
    */
    check("and it sits where it settled, not where it was last moving",
      Math.abs(m.box.y - 24 / GRID) < 2 / GRID && Math.abs(m.box.h - 10 / GRID) < 2 / GRID,
      `y=${m.box.y.toFixed(3)} h=${m.box.h.toFixed(3)}`);
    check("and it is still there at the end of the window", m.leavesAt === null, String(m.leavesAt));
  }
}

section("A card that comes down is a drop, and one that grows is a settle");
{
  const down = [flat(GROUND), flat(GROUND)];
  for (const y of [2, 6, 11, 15, 17, 18]) down.push(withRect(flat(GROUND), { x: 6, y, w: 36, h: 10 }, INK));
  for (let i = 0; i < HOLD; i += 1) down.push(withRect(flat(GROUND), { x: 6, y: 18, w: 36, h: 10 }, INK));
  check("a band arriving from above is a drop", momentsFrom(down)[0]?.enter === "drop", momentsFrom(down)[0]?.enter);

  const grow = [flat(GROUND), flat(GROUND)];
  for (const s of [4, 8, 14, 18, 20]) {
    grow.push(withRect(flat(GROUND), { x: 24 - s, y: 24 - Math.round(s / 2), w: s * 2, h: s }, INK));
  }
  for (let i = 0; i < HOLD; i += 1) grow.push(withRect(flat(GROUND), { x: 4, y: 14, w: 40, h: 20 }, INK));
  const settle = momentsFrom(grow)[0];
  check("a shape growing on the spot is a settle", settle?.enter === "settle", settle?.enter);
  check("and a settle reports no travel", settle?.travel === 0, String(settle?.travel));
}

section("A cut is not a drawing");
{
  // The whole frame replaced in one sample, then held. Every cell changed.
  const frames = [flat(GROUND), flat(GROUND), flat(200), flat(200)];
  for (let i = 0; i < HOLD; i += 1) frames.push(flat(200));
  check("a whole frame replaced at once draws nothing",
    momentsFrom(frames).length === 0, JSON.stringify(momentsFrom(frames).map((m) => m.box)));
}

section("A picture that never stops is not a picture being drawn on");
{
  /*
    The case a timeout used to invent a composition out of.

    A plate whose luma drifts — a camera that will not sit still, a background
    loop, a slow push — changes a large part of the frame on every sample and
    never comes to rest. Read with a settle-by-timeout, this produced one
    moment boxed over the whole frame with an entrance of `fade`: a
    composition assembled out of a camera move.

    The fixture's own numbers are asserted first. A drift that quietly fell
    under the cell threshold, or over the cut share, would leave this passing
    for a reason that has nothing to do with the rule it is here to check.
  */
  const drift = (f) => {
    const a = new Uint8Array(CELLS);
    for (let i = 0; i < CELLS; i += 1) {
      const col = i % GRID;
      a[i] = Math.max(0, Math.min(255,
        Math.round(90 + 45 * Math.sin(2 * Math.PI * (col / 10 + f / 20)) + f * 1.6)));
    }
    return a;
  };
  const frames = [];
  for (let f = 0; f < 40; f += 1) frames.push(drift(f));

  const share = changedShare(frames[5], frames[6]);
  check("the fixture drifts enough to be seen", share > 0.2, share.toFixed(3));
  check("and not so much that it would read as a cut", share < 0.9, share.toFixed(3));
  check("a picture that never settles draws nothing",
    momentsFrom(frames).length === 0, JSON.stringify(momentsFrom(frames).map((m) => m.box)));
}

section("A cut between two shots that resemble each other is still a cut");
{
  /*
    The hole the share test leaves.

    Two shots similar enough to leave a tenth of the frame alone change less
    than the cut share, come to rest immediately, and hold for the rest of the
    video — every test a graphic passes except the one about how long it took
    to arrive.
  */
  const before = flat(GROUND);
  const after = withRect(flat(180), { x: 0, y: 0, w: GRID, h: 5 }, GROUND);
  const frames = [before, before, after];
  for (let i = 0; i < HOLD; i += 1) frames.push(after);

  const share = changedShare(before, after);
  check("the two shots do share some of the frame", share > 0.5 && share < 0.9, share.toFixed(3));
  check("and the change from one to the other is still not a drawing",
    momentsFrom(frames).length === 0, JSON.stringify(momentsFrom(frames).map((m) => m.box)));
}

section("A dissolve replaces the picture, however slowly it does it");
{
  /*
    The case the arrival-length rule cannot reach.

    A cross dissolve changes every cell, takes half a second to do it, and then
    holds — so it arrives like a graphic, rests like a graphic and holds like
    one. The only thing that says it is not one is that there is no picture
    left underneath it, which is what the share test measures.
  */
  const frames = [flat(GROUND), flat(GROUND)];
  for (const v of [66, 92, 118, 144, 170, 196]) frames.push(flat(v));
  for (let i = 0; i < HOLD; i += 1) frames.push(flat(196));

  check("each step of the dissolve really does touch the whole frame",
    changedShare(frames[3], frames[4]) > 0.95, changedShare(frames[3], frames[4]).toFixed(3));
  check("and a dissolve draws nothing",
    momentsFrom(frames).length === 0, JSON.stringify(momentsFrom(frames).map((m) => m.box)));
}

section("A graphic that animates out is not a second graphic arriving");
{
  /*
    Read forwards only, every graphic is found twice.

    A card that *cuts* out is refused by the arrival-length rule — its
    departure takes one sample. A card that animates out does not: it slides
    away over five samples, comes to rest on the empty plate and holds there
    for the rest of the video, which is every test an arrival passes. What
    refuses it is memory — the plate it settles onto is the picture as it stood
    before the card arrived.
  */
  const frames = [flat(GROUND), flat(GROUND)];
  for (const y of [38, 34, 30, 27, 25, 24]) frames.push(withRect(flat(GROUND), { x: 6, y, w: 36, h: 10 }, INK));
  for (let i = 0; i < HOLD; i += 1) frames.push(withRect(flat(GROUND), { x: 6, y: 24, w: 36, h: 10 }, INK));
  for (const y of [27, 31, 36, 41, 46]) frames.push(withRect(flat(GROUND), { x: 6, y, w: 36, h: 10 }, INK));
  for (let i = 0; i < HOLD; i += 1) frames.push(flat(GROUND));

  const moments = momentsFrom(frames);
  check("the card is found once, not twice", moments.length === 1,
    JSON.stringify(moments.map((m) => [m.at.toFixed(2), m.enter])));
  check("and it is the arrival that was kept", moments[0]?.enter === "rise", moments[0]?.enter);
}

section("A flash is not a graphic");
{
  /*
    With an entrance of its own, so that the hold rule is what refuses it.

    The first spelling of this flashed a rectangle on for two samples with no
    entrance at all — and was refused by the arrival-length rule instead, which
    made it a second copy of the cut test rather than a test of holding.
  */
  const frames = [flat(GROUND), flat(GROUND)];
  for (const y of [38, 33, 28, 24]) frames.push(withRect(flat(GROUND), { x: 6, y, w: 36, h: 10 }, INK));
  // Three samples of holding: enough that the hold rule is the thing measuring
  // it, rather than the region having vanished before there was anything to
  // count. A tenth of a second on screen, against a floor of four tenths.
  for (let i = 0; i < 3; i += 1) frames.push(withRect(flat(GROUND), { x: 6, y: 24, w: 36, h: 10 }, INK));
  for (let i = 0; i < HOLD; i += 1) frames.push(flat(GROUND));
  const moments = momentsFrom(frames);
  check("something that arrives properly and then goes straight back out is dropped",
    moments.length === 0, JSON.stringify(moments.map((m) => [m.at, m.enter])));
}

section("A graphic that leaves says when");
{
  const frames = [flat(GROUND), flat(GROUND)];
  for (const y of [40, 36, 33, 32]) frames.push(withRect(flat(GROUND), { x: 6, y, w: 36, h: 10 }, INK));
  for (let i = 0; i < HOLD; i += 1) frames.push(withRect(flat(GROUND), { x: 6, y: 32, w: 36, h: 10 }, INK));
  for (let i = 0; i < 10; i += 1) frames.push(flat(GROUND));
  const m = momentsFrom(frames)[0];
  check("the moment it goes is reported rather than left null",
    typeof m?.leavesAt === "number", String(m?.leavesAt));
  check("and it is after it settled", (m?.leavesAt ?? 0) > (m?.settledAt ?? 0),
    `${m?.settledAt} -> ${m?.leavesAt}`);
}

section("A mark too small to read is not a graphic");
{
  /*
    A cursor, a mouse pointer, a recording dot, a compression artefact that
    survived the noise floor by being bright. Each of these arrives, travels,
    rests and holds; the only thing wrong with them is that they are three
    cells across, and nothing drawn on a frame for a viewer to read is.
  */
  const frames = [flat(GROUND), flat(GROUND)];
  for (const y of [34, 31, 28, 26, 25]) frames.push(withRect(flat(GROUND), { x: 22, y, w: 3, h: 3 }, INK));
  for (let i = 0; i < HOLD; i += 1) frames.push(withRect(flat(GROUND), { x: 22, y: 25, w: 3, h: 3 }, INK));
  check("a three-cell mark that arrives and holds is still not reported",
    momentsFrom(frames).length === 0, JSON.stringify(momentsFrom(frames).map((m) => m.box)));
}

section("Grain is not motion");
{
  /*
    Every still picture changes a little: sensor noise, film grain, the dither
    of a gradient, the ringing around text after compression. Without a floor
    under which a cell has not changed, all of it is movement — the picture
    never comes to rest, and the card drawn on top of it is never found.
  */
  const grain = (base, f) => {
    const out = Uint8Array.from(base);
    for (let i = 0; i < CELLS; i += 1) {
      out[i] = Math.max(0, Math.min(255, (out[i] ?? 0) + (((i * 7 + f * 13) % 3) - 1) * 4));
    }
    return out;
  };
  const frames = [grain(flat(GROUND), 0), grain(flat(GROUND), 1)];
  let f = 2;
  for (const y of [38, 34, 30, 27, 25, 24]) {
    frames.push(grain(withRect(flat(GROUND), { x: 6, y, w: 36, h: 10 }, INK), f));
    f += 1;
  }
  for (let i = 0; i < HOLD; i += 1) {
    frames.push(grain(withRect(flat(GROUND), { x: 6, y: 24, w: 36, h: 10 }, INK), f));
    f += 1;
  }

  check("the grain is really there", changedShare(frames[0], frames[1]) === 0,
    "under the floor, which is the point");
  const moments = momentsFrom(frames);
  check("a card over a grainy plate is still found", moments.length === 1,
    JSON.stringify(moments.map((m) => m.enter)));
  check("and still read as a rise", moments[0]?.enter === "rise", moments[0]?.enter);
}

section("The pieces the reading is made of");
{
  const mask = withRect(new Uint8Array(CELLS), { x: 8, y: 12, w: 16, h: 8 }, 1);
  const box = boxOf(mask);
  check("a box is the smallest rectangle holding the marked cells",
    Math.abs(box.x - 8 / GRID) < 1e-9 && Math.abs(box.w - 16 / GRID) < 1e-9, JSON.stringify(box));
  check("and an empty mask has no box", boxOf(new Uint8Array(CELLS)) === null);

  /*
    One sample is not a direction.

    A burst of a single box could be read as a travel of zero and called a
    fade, which it is — but the reason matters: `readEntrance` must not index
    past the end of a one-element list and report the entrance of `undefined`.
  */
  check("a single sample reads as a fade rather than as an error",
    readEntrance([{ x: 0, y: 0, w: 1, h: 1 }]).enter === "fade");
  check("and a movement under one cell is not a travel",
    readEntrance([
      { x: 0.2, y: 0.5, w: 0.4, h: 0.1 },
      { x: 0.2, y: 0.5 + 0.4 / GRID, w: 0.4, h: 0.1 },
    ]).travel === 0);
}

/* ── The same thresholds, on pictures a codec made ──────────────────────── */

const haveFfmpeg = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" }).status === 0;
section("Read off real files");
if (!haveFfmpeg) {
  check("skipped: no ffmpeg here", true);
} else {
  const work = await mkdtemp(path.join(tmpdir(), "editly-graphics-"));
  const run = (args) => spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { encoding: "utf8" });

  // A grey ground with a white band that slides up at 2s and holds.
  const rise = path.join(work, "rise.mp4");
  run([
    "-f", "lavfi", "-i", "color=c=gray:s=320x180:r=25:d=6",
    "-f", "lavfi", "-i", "color=c=white:s=240x40:d=6",
    "-filter_complex",
    "[0:v][1:v]overlay=x=40:y='if(lt(t,2),200,max(110,200-(t-2)*300))':enable='gte(t,2)'[o]",
    "-map", "[o]", "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", rise,
  ]);

  // The same ground, cut to a different one at 2s. Nothing is drawn.
  const cut = path.join(work, "cut.mp4");
  run([
    "-f", "lavfi", "-i", "color=c=gray:s=320x180:r=25:d=2",
    "-f", "lavfi", "-i", "color=c=navy:s=320x180:r=25:d=4",
    "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[o]",
    "-map", "[o]", "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", cut,
  ]);

  // A picture that is alive all over and has nothing drawn on it.
  const live = path.join(work, "live.mp4");
  run([
    "-f", "lavfi", "-i", "nullsrc=s=320x180:r=25:d=6",
    "-vf", "geq=lum='128+40*sin(2*PI*(X/60+T))':cb=128:cr=128,format=yuv420p",
    "-c:v", "libx264", "-crf", "18", live,
  ]);

  const readRise = await readGraphics(rise);
  check("the file was read at all", readRise.measured && readRise.sampledSeconds > 5,
    `${readRise.sampledSeconds.toFixed(1)}s`);
  check("a band sliding up a real file is found", readRise.moments.length === 1,
    JSON.stringify(readRise.moments.map((m) => [m.at.toFixed(2), m.enter])));
  const found = readRise.moments[0];
  if (found) {
    check("at about the second it was drawn", Math.abs(found.at - 2) < 0.35, found.at.toFixed(2));
    check("and read as a rise", found.enter === "rise", found.enter);
    /*
      The band is 240 of 320 wide and 40 of 180 tall, which on the squashed
      grid is 0.75 x 0.22. Checked because the box is the half of this reading
      the model never sees — it is told where to look, and a box that is wrong
      sends it to the wrong part of the frame with no way to notice.
    */
    check("and boxed where the band actually is",
      Math.abs(found.box.w - 0.75) < 0.1 && Math.abs(found.box.h - 0.22) < 0.12,
      `w=${found.box.w.toFixed(2)} h=${found.box.h.toFixed(2)}`);
  }

  const readCut = await readGraphics(cut);
  check("a hard cut in a real file draws nothing", readCut.moments.length === 0,
    JSON.stringify(readCut.moments.map((m) => m.box)));

  const readLive = await readGraphics(live);
  check("and a picture that is alive draws nothing", readLive.moments.length === 0,
    JSON.stringify(readLive.moments.map((m) => m.box)));
  check("but it was still read, which is a different answer from drawing nothing",
    readLive.measured, String(readLive.measured));

  const missing = await readGraphics(path.join(work, "not-a-file.mp4"));
  check("a file that is not there is reported as unread rather than as empty",
    missing.measured === false && missing.moments.length === 0, JSON.stringify(missing));

  await rm(work, { recursive: true, force: true });
}

await rm(buildDir, { recursive: true, force: true });
console.log(`\n${passed}/${passed + failed} checks passed`);
if (failed > 0) {
  console.log(`${failed} FAILED`);
  process.exit(1);
}
console.log("The reference says where it draws, and which way it came in.");
