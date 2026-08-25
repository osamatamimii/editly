/**
 * Renders operations *together*, because separately they already work.
 *
 * Every other suite here tests one operation at a time, and every one of them
 * passed on the day two real crashes were sitting in the overlay path: an
 * ffmpeg stream index derived from an argument count that is only right for
 * one kind of input, and graph labels numbered from a link count that grows
 * twice per stage. Neither is reachable with a single overlay. Both would have
 * failed a render the customer had already paid minutes for.
 *
 * So this file is a matrix rather than a list. On one axis, everything that
 * changes the output *clock* — cutting silence, keeping a range, pulling a
 * highlight, moving a hook to the front, overlapping the joins. On the other,
 * everything *placed against* that clock — a punch, a push, an image, a
 * cutaway, a bed, captions, a fade, a watermark, a reframe.
 *
 * Three properties are asserted for every pair, and each one is a bug we would
 * otherwise learn about from a customer:
 *
 *   1. It renders at all. A filtergraph that will not initialise is not a bad
 *      edit, it is a failed job.
 *   2. The file is as long as the renderer said it would be. That number is
 *      arithmetic over the cut map, and it is the *same* arithmetic that places
 *      every caption, punch, overlay and title. If it disagrees with the file,
 *      it disagrees with all of them, and the edit is wrong everywhere at once
 *      in a way nothing else here would notice.
 *   3. The sound survives. An audio stream that quietly vanishes when two
 *      operations meet is the kind of fault people describe as "it broke" and
 *      cannot reproduce.
 *
 * Usage: node tools/combination-test.mjs
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
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-combo-build-"));
const modulePath = path.join(buildDir, "ffmpeg.mjs");

const built = spawnSync(
  require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/worker"] }),
  [
    path.join(repoRoot, "artifacts/worker/src/ffmpeg.ts"),
    "--bundle", "--platform=node", "--format=esm", "--target=node22",
    `--outfile=${modulePath}`, "--log-level=error",
  ],
  { stdio: "inherit" },
);
if (built.status !== 0) {
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

const scratch = () => mkdtemp(path.join(tmpdir(), "editly-c-"));

/**
 * A render that hangs must fail this file, not stall it.
 *
 * The fault this suite was extended to catch is a *deadlock*, and a check that
 * waits for a deadlock is not a check — it is a CI job that eventually times
 * out with no idea which line it was on. So the one case that can deadlock is
 * run against a clock, and blowing the clock is reported and exits, taking the
 * stuck ffmpeg down with the process.
 */
async function withDeadline(promise, ms, label) {
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`did not finish within ${ms / 1000}s — ${label}`)), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
const workDir = await scratch();

function ffprobe(file, entries, extra = []) {
  const r = spawnSync(
    "ffprobe",
    ["-v", "error", ...extra, "-show_entries", entries, "-of", "default=nw=1:nk=1", file],
    { encoding: "utf8" },
  );
  return r.stdout.trim().split("\n").filter(Boolean);
}

// ── The material ────────────────────────────────────────────────────────────
//
// Twelve seconds, audible in three bursts with real silence between them, so
// removeSilence has something to remove and the highlight has somewhere to
// land. Small frame and low rate: this file is rendered several dozen times.
const source = path.join(workDir, "source.mp4");
{
  const gen = spawnSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc=size=320x240:rate=24:duration=12",
    "-f", "lavfi", "-i", "sine=frequency=320:duration=12",
    "-filter_complex",
    "[1:a]volume='if(between(t,0,2.5)+between(t,4.5,7)+between(t,9,11.5),1,0)':eval=frame[a]",
    "-map", "0:v", "-map", "[a]",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source,
  ]);
  if (gen.status !== 0) {
    console.error("could not generate the test clip");
    process.exit(1);
  }
}

const still = path.join(workDir, "still.png");
spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:size=80x80", "-frames:v", "1", still]);
const cutaway = path.join(workDir, "cutaway.mp4");
spawnSync("ffmpeg", [
  "-y", "-loglevel", "error",
  "-f", "lavfi", "-i", "color=c=green:size=320x240:rate=24:duration=4",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", cutaway,
]);
const track = path.join(workDir, "track.m4a");
spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=880:duration=2", "-c:a", "aac", track]);

const assets = new Map([
  ["still", { file: still, kind: "image" }],
  ["cutaway", { file: cutaway, kind: "video" }],
  ["track", { file: track, kind: "audio" }],
]);

// ── The two axes ────────────────────────────────────────────────────────────
//
// `clocks` change how long the output is and where its moments land. `placed`
// are pinned to moments and must survive whatever the clock did to them.
const clocks = [
  { name: "uncut", ops: [] },
  { name: "silence cut", ops: [{ type: "removeSilence", thresholdDb: -32, minSilenceMs: 400, paddingMs: 60 }] },
  { name: "a named range", ops: [{ type: "extractRange", startSeconds: 1, endSeconds: 8 }] },
  { name: "the highlight", ops: [{ type: "extractHighlight", targetSeconds: 6 }] },
  { name: "a cold open", ops: [{ type: "coldOpen", seconds: 2 }] },
  {
    name: "cut and dissolved",
    ops: [
      { type: "removeSilence", thresholdDb: -32, minSilenceMs: 400, paddingMs: 60 },
      { type: "transition", style: "dissolve", durationMs: 200 },
    ],
  },
];

const placed = [
  { name: "a punch", ops: [{ type: "zoomPunch", at: [1, 5], amount: 0.12, holdMs: 800 }] },
  { name: "a push", ops: [{ type: "kenBurns", to: 1.08 }] },
  { name: "an image", ops: [{ type: "overlayImage", assetId: "still", at: 1, durationSeconds: 2, position: "top-right", scale: 0.2, opacity: 1 }] },
  { name: "a cutaway", ops: [{ type: "insertBRoll", assetId: "cutaway", at: 2, durationSeconds: 2, fit: "cover", keepSourceAudio: true }] },
  {
    name: "an image and a cutaway",
    ops: [
      { type: "overlayImage", assetId: "still", at: 0.5, durationSeconds: 1.5, position: "top-left", scale: 0.2, opacity: 1 },
      { type: "insertBRoll", assetId: "cutaway", at: 3, durationSeconds: 1.5, fit: "cover", keepSourceAudio: true },
    ],
  },
  { name: "a music bed", ops: [{ type: "addMusic", assetId: "track", gainDb: -18, duck: true, fadeSeconds: 0.5, fromSeconds: 0, loop: true }] },
  {
    name: "captions",
    ops: [{
      type: "burnCaptions",
      cues: [
        { startMs: 200, endMs: 1800, text: "first line" },
        { startMs: 5000, endMs: 6500, text: "second line" },
      ],
      style: "bold-white",
      animation: "none",
    }],
  },
  { name: "a fade", ops: [{ type: "fade", durationMs: 400 }] },
  { name: "a watermark", ops: [{ type: "watermark", text: "Editly", position: "bottom-right" }] },
  { name: "a reframe", ops: [{ type: "formatForPlatform", platform: "tiktok" }] },
  { name: "levelling", ops: [{ type: "normalizeLoudness", targetLufs: -14 }] },
];

// A frame at 24fps is 42ms; a container rounds to a keyframe boundary and an
// encoder pads the last frame. Two frames of slack is generous for rounding and
// still far tighter than any real drift, which shows up in whole seconds.
const TOLERANCE = 0.25;

console.log("\nEvery clock against everything placed on it");
let rendered = 0;
for (const clock of clocks) {
  const results = [];
  for (const thing of placed) {
    const plan = { version: 1, operations: [...clock.ops, ...thing.ops] };
    let out = null;
    let error = null;
    try {
      out = await renderPlan(source, plan, { workDir: await scratch(), assets });
    } catch (e) {
      error = e;
    }
    rendered += 1;
    results.push({ thing, out, error });
  }

  const broke = results.filter((r) => r.error);
  check(
    `${clock.name}: every one of the ${placed.length} renders finished`,
    broke.length === 0,
    broke.map((r) => `${r.thing.name}: ${String(r.error?.message ?? r.error).slice(0, 160)}`).join(" | "),
  );

  const drifted = results
    .filter((r) => r.out)
    .map((r) => {
      const measured = Number(ffprobe(r.out.output, "format=duration")[0]);
      return { name: r.thing.name, measured, said: r.out.estimatedSeconds };
    })
    .filter((d) => !Number.isFinite(d.measured) || Math.abs(d.measured - d.said) > TOLERANCE);
  check(
    `${clock.name}: the file is as long as the renderer said it would be`,
    drifted.length === 0,
    drifted.map((d) => `${d.name}: said ${d.said?.toFixed?.(2)}s, measured ${d.measured}`).join(" | "),
  );

  const mute = results
    .filter((r) => r.out)
    .filter((r) => !ffprobe(r.out.output, "stream=codec_type").includes("audio"));
  check(
    `${clock.name}: the sound survives every one of them`,
    mute.length === 0,
    mute.map((r) => r.thing.name).join(", "),
  );
}

// ── One plan carrying nearly everything ─────────────────────────────────────
//
// The matrix above is pairwise, which finds the faults that need exactly two
// operations to meet. This is the other shape of the same worry: a plan near
// the twelve-operation ceiling, where a label or an input index that drifts by
// one per stage has had enough stages to drift somewhere impossible.
console.log("\nOne plan carrying nearly everything");
{
  const plan = {
    version: 1,
    operations: [
      { type: "removeSilence", thresholdDb: -32, minSilenceMs: 400, paddingMs: 60 },
      { type: "transition", style: "wipeLeft", durationMs: 200 },
      { type: "formatForPlatform", platform: "tiktok" },
      { type: "overlayImage", assetId: "still", at: 0.5, durationSeconds: 1.5, position: "top-left", scale: 0.2, opacity: 1 },
      { type: "insertBRoll", assetId: "cutaway", at: 4, durationSeconds: 1.5, fit: "cover", keepSourceAudio: true },
      { type: "overlayImage", assetId: "still", at: 6, durationSeconds: 1.5, position: "bottom-right", scale: 0.15, opacity: 0.8 },
      { type: "zoomPunch", at: [1, 5], amount: 0.12, holdMs: 800 },
      { type: "addMusic", assetId: "track", gainDb: -20, duck: true, fadeSeconds: 0.5, fromSeconds: 0, loop: true },
      { type: "watermark", text: "Editly", position: "bottom-right" },
      { type: "normalizeLoudness", targetLufs: -14 },
      { type: "fade", durationMs: 300 },
    ],
  };
  let out = null;
  let error = null;
  try {
    out = await renderPlan(source, plan, { workDir: await scratch(), assets });
  } catch (e) {
    error = e;
  }
  rendered += 1;
  check("eleven operations render as one encode", error === null, String(error?.message ?? "").slice(0, 300));

  if (out) {
    const measured = Number(ffprobe(out.output, "format=duration")[0]);
    check(
      "and the file is the length the renderer said",
      Math.abs(measured - out.estimatedSeconds) <= TOLERANCE,
      `said ${out.estimatedSeconds.toFixed(2)}s, measured ${measured}`,
    );
    // 1080x1920 rather than something scaled to this tiny source on purpose:
    // the reframe clamps a request *down* to what the footage can fill, but
    // never below the platform's own default, because a 240p vertical is not
    // an export anyone wants delivered to TikTok.
    const shape = ffprobe(out.output, "stream=width,height", ["-select_streams", "v:0"]).join("x");
    check("reframed to the platform's vertical shape", shape === "1080x1920", shape);
    check("with sound", ffprobe(out.output, "stream=codec_type").includes("audio"), "");
    // Three overlays plus the picture: every stage has to have found its input.
    check(
      "and every overlay stage reached the frame",
      out.notes.filter((n) => /laid an image over the frame/.test(n)).length === 2 &&
        out.notes.some((n) => /cut to b-roll/.test(n)),
      JSON.stringify(out.notes),
    );
  }
}

// ── Clocks against each other ───────────────────────────────────────────────
//
// The matrix above pairs one clock with one thing placed on it. It never pairs
// two clocks, and a person asking for an edit in one sentence does exactly
// that: "cut the silences, keep the middle minute, and start on the best bit"
// is three of them. Every pair is rendered here for the same three properties.
console.log("\nEvery clock against every other clock");
{
  const pairs = [];
  for (let i = 0; i < clocks.length; i += 1) {
    for (let j = i + 1; j < clocks.length; j += 1) pairs.push([clocks[i], clocks[j]]);
  }

  const broke = [];
  const drifted = [];
  const mute = [];
  for (const [a, b] of pairs) {
    const plan = { version: 1, operations: [...a.ops, ...b.ops] };
    let out = null;
    try {
      out = await renderPlan(source, plan, { workDir: await scratch(), assets });
    } catch (e) {
      broke.push(`${a.name}+${b.name}: ${String(e?.message ?? e).slice(0, 140)}`);
      continue;
    }
    rendered += 1;
    const measured = Number(ffprobe(out.output, "format=duration")[0]);
    if (!Number.isFinite(measured) || Math.abs(measured - out.estimatedSeconds) > TOLERANCE) {
      drifted.push(`${a.name}+${b.name}: said ${out.estimatedSeconds?.toFixed?.(2)}s, measured ${measured}`);
    }
    if (!ffprobe(out.output, "stream=codec_type").includes("audio")) mute.push(`${a.name}+${b.name}`);
  }

  check(`all ${pairs.length} pairs of clocks render`, broke.length === 0, broke.join(" | "));
  check("each is as long as the renderer said", drifted.length === 0, drifted.join(" | "));
  check("and none of them loses the sound", mute.length === 0, mute.join(", "));
}

// ── The cold open is the one edit that plays out of order ───────────────────
//
// And that is not a detail. Every piece of an edit is a `trim` branch off one
// decode, and ffmpeg feeds those branches in the order the decoder produces
// frames. A chained `acrossfade` over branches that want the file out of order
// deadlocks — measured, not theorised: before this was caught, this exact plan
// ran for over two hundred seconds on a twelve-second clip and had produced
// nothing. In production that is a job that burns to the worker's timeout with
// the customer's minute already spent.
//
// So the join is refused and the hook kept. What this checks is both halves:
// that it finishes quickly, and that it says which of the two it dropped —
// a silent refusal would leave someone waiting for a dissolve that was never
// coming and no way to find out why.
console.log("\nA cold open with a transition asked for");
{
  const started = Date.now();
  let out = null;
  let error = null;
  try {
    out = await withDeadline(
      renderPlan(
        source,
        {
          version: 1,
          operations: [
            { type: "coldOpen", seconds: 2 },
            { type: "transition", style: "dissolve", durationMs: 200 },
          ],
        },
        { workDir: await scratch(), assets },
      ),
      90_000,
      "a cold open with a transition deadlocks the audio crossfade",
    );
  } catch (e) {
    error = e;
  }
  rendered += 1;
  const seconds = (Date.now() - started) / 1000;

  check("it finishes at all", error === null, String(error?.message ?? "").slice(0, 200));
  if (error && /did not finish within/.test(String(error.message))) {
    console.log("\nSTOPPING: the render is stuck, and every check after this one would wait on the same fault.");
    console.log(`\n${rendered} renders, ${checks - failures}/${checks} checks passed`);
    console.log(`${failures} FAILED`);
    process.exit(1);
  }
  check("and quickly, rather than deadlocking on the audio", seconds < 60, `${seconds.toFixed(1)}s`);
  if (out) {
    check(
      "the hook is kept, because that is what was actually asked for",
      out.notes.some((n) => /opens on|hook/.test(n)),
      JSON.stringify(out.notes),
    );
    check(
      "and the dropped join is said out loud rather than silently skipped",
      out.notes.some((n) => /plays out of order/.test(n) && /cuts stay hard/.test(n)),
      JSON.stringify(out.notes),
    );
    const measured = Number(ffprobe(out.output, "format=duration")[0]);
    check(
      "the file is the length of a hard-cut edit",
      Math.abs(measured - out.estimatedSeconds) <= TOLERANCE,
      `said ${out.estimatedSeconds.toFixed(2)}s, measured ${measured}`,
    );
    check("with its sound", ffprobe(out.output, "stream=codec_type").includes("audio"), "");
  }
}

// ── The title layer, which is an overlay too ────────────────────────────────
//
// A motion title is rendered in a browser and then composited like any other
// overlay, through the same stage numbering the two faults above lived in. It
// is kept out of the matrix because it costs a browser launch per render, but
// it has to meet at least one other overlay somewhere, and this is that place.
// The whole thing degrades to a note by design, so a missing Chromium must not
// fail this file — what is asserted is that the *render* survives, and that if
// the title did paint, the image beside it painted too.
console.log("\nA title beside an overlay");
{
  const plan = {
    version: 1,
    operations: [
      { type: "removeSilence", thresholdDb: -32, minSilenceMs: 400, paddingMs: 60 },
      { type: "overlayImage", assetId: "still", at: 0.5, durationSeconds: 1.5, position: "top-left", scale: 0.2, opacity: 1 },
      { type: "motionTitle", text: "Hello", at: 1, durationSeconds: 1.5, style: "card", position: "center" },
    ],
  };
  let out = null;
  let error = null;
  try {
    out = await renderPlan(source, plan, { workDir: await scratch(), assets });
  } catch (e) {
    error = e;
  }
  rendered += 1;
  check("a title over an image renders", error === null, String(error?.message ?? "").slice(0, 300));
  if (out) {
    const measured = Number(ffprobe(out.output, "format=duration")[0]);
    check(
      "and is the length the renderer said",
      Math.abs(measured - out.estimatedSeconds) <= TOLERANCE,
      `said ${out.estimatedSeconds.toFixed(2)}s, measured ${measured}`,
    );
    check(
      "the image is on the frame either way",
      out.notes.some((n) => /laid an image over the frame/.test(n)),
      JSON.stringify(out.notes),
    );
  }
}

await rm(workDir, { recursive: true, force: true });
await rm(buildDir, { recursive: true, force: true });

console.log(`\n${rendered} renders, ${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("Operations that work alone also work together.");
