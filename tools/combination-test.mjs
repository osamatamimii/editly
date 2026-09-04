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
const { renderPlan, maxOverlappedPieces } = await import(pathToFileURL(modulePath).href);

// The templates are plans we wrote and ship, and until now nothing rendered
// one. They are also the first thing a new customer clicks, which makes them
// the worst place in the product for a plan that does not execute.
const templatesPath = path.join(buildDir, "templates.mjs");
spawnSync(
  require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/api-server"] }),
  [
    path.join(repoRoot, "artifacts/api-server/src/lib/templates.ts"),
    "--bundle", "--platform=node", "--format=esm", "--target=node22",
    `--outfile=${templatesPath}`, "--log-level=error",
  ],
  { stdio: "inherit" },
);
const { TEMPLATES, findTemplate, templatePreflight } = await import(pathToFileURL(templatesPath).href);

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

/** Mean volume of a whole file, in dB. NaN if ffmpeg could not measure it. */
function meanVolume(file) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-i", file, "-af", "volumedetect", "-f", "null", "-"], {
    encoding: "utf8",
  });
  const m = r.stderr.match(/mean_volume: ([-\d.]+) dB/);
  return m ? Number(m[1]) : NaN;
}

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
// Every piece of an edit is normally a `trim` branch off one decode, and
// ffmpeg feeds those branches in the order the decoder produces frames. A cold
// open breaks that: the hook comes from the middle of the file and plays
// first. Chained `acrossfade` over branches that read the file backwards does
// not come out wrong, it deadlocks — measured, not theorised: this exact plan
// once ran for over two hundred seconds on a twelve-second clip and had
// produced nothing, and two out-of-order pieces produced a file with almost no
// audio in it.
//
// Seeking each piece on its own input removes the shared decoder and with it
// the ordering constraint. What is checked here is that the fix holds on all
// three fronts the bug had: that it finishes quickly, that both halves of the
// ask actually happen, and — the quiet one — that the sound is still *there*.
// A near-silent file is the failure mode that would otherwise pass every other
// check in this suite.
console.log("\nA cold open with a transition, which used to deadlock");
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
      "the hook is moved to the front",
      out.notes.some((n) => /opens on|hook/.test(n)),
      JSON.stringify(out.notes),
    );
    check(
      "and the cuts are dissolved rather than the join being dropped",
      out.notes.some((n) => /dissolved between the cuts/.test(n)),
      JSON.stringify(out.notes),
    );

    const measured = Number(ffprobe(out.output, "format=duration")[0]);
    check(
      "the file is one overlap per join shorter, which is what a dissolve costs",
      Math.abs(measured - out.estimatedSeconds) <= TOLERANCE,
      `said ${out.estimatedSeconds.toFixed(2)}s, measured ${measured}`,
    );

    // The bug's other face. Two out-of-order pieces did not hang, they wrote a
    // file with an audio stream in it and nothing audible inside — which every
    // stream-shaped check here would have called a pass.
    const audioSeconds = Number(ffprobe(out.output, "stream=duration", ["-select_streams", "a:0"])[0]);
    check(
      "its audio runs the whole length rather than stopping short",
      Number.isFinite(audioSeconds) && Math.abs(audioSeconds - measured) <= 0.35,
      `audio ${audioSeconds}s of ${measured}s`,
    );

    const level = meanVolume(out.output);
    const plain = await renderPlan(
      source,
      { version: 1, operations: [{ type: "coldOpen", seconds: 2 }] },
      { workDir: await scratch(), assets },
    );
    rendered += 1;
    const plainLevel = meanVolume(plain.output);
    check(
      "and is as loud as the same edit without the dissolve — not a silent file with an audio stream",
      Number.isFinite(level) && level > plainLevel - 3,
      `${level} dB against ${plainLevel} dB`,
    );
  }
}

// ── How many pieces an overlapped edit is allowed to hold open ─────────────
//
// A dissolve costs one open stream per piece, and `xfade` holds them all in
// lockstep: measured against a 1080p source, four pieces peak at 505 MB of
// resident memory and eight at 1633 MB, against a worker with 1 GB. Past what
// fits, the join is dropped rather than the render, because an OOM kill takes
// the whole job with it and says nothing.
//
// What fits depends on the frame, because the memory does — 62 bytes per pixel
// per piece — and the cap was a bare 4 for every source. That refused a
// dissolve to a 320x240 edit whose pieces cost a twenty-seventh of a 1080p
// one, and allowed a 1080p *in-order* edit any number of them, which was the
// expensive half and the one over the box.
console.log("\nAn overlapped edit only holds so many pieces open");
{
  // Under the cap: a hook, what came before it, what came after.
  const few = await renderPlan(
    source,
    {
      version: 1,
      operations: [
        { type: "coldOpen", seconds: 2 },
        { type: "transition", style: "dissolve", durationMs: 200 },
      ],
    },
    { workDir: await scratch(), assets },
  );
  rendered += 1;
  check(
    "three pieces are dissolved, because three decoders fit",
    few.notes.some((n) => /dissolved between the cuts/.test(n)),
    JSON.stringify(few.notes),
  );

  // Over it. This needs its own clip: on the twelve-second one the cold open
  // leaves a sliver of a piece and the transition is refused for being too
  // short to cross, which is a different guard and would make this check pass
  // for the wrong reason. Long, evenly spaced bursts leave nine real pieces.
  const spaced = path.join(workDir, "spaced.mp4");
  {
    const windows = [];
    for (let t = 0; t < 48; t += 6) windows.push(`between(t,${t},${t + 4})`);
    spawnSync("ffmpeg", [
      "-y", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc=size=320x240:rate=24:duration=48",
      "-f", "lavfi", "-i", "sine=frequency=320:duration=48",
      "-filter_complex", `[1:a]volume='if(${windows.join("+")},1,0)':eval=frame[a]`,
      "-map", "0:v", "-map", "[a]",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", spaced,
    ]);
  }

  const many = await renderPlan(
    spaced,
    {
      version: 1,
      operations: [
        { type: "removeSilence", thresholdDb: -32, minSilenceMs: 400, paddingMs: 60 },
        { type: "coldOpen", seconds: 3 },
        { type: "transition", style: "dissolve", durationMs: 200 },
      ],
    },
    { workDir: await scratch(), assets },
  );
  rendered += 1;
  check(
    "nine pieces of a small frame still get their dissolve, because they fit",
    many.notes.some((n) => /dissolved between the cuts/.test(n)),
    JSON.stringify(many.notes),
  );

  /*
    And the cap itself, checked as arithmetic rather than by rendering 1080p
    nine times. Both ends matter: the number for a full-size frame is the one
    the measurement above produced, and it has to fall as the frame grows.
  */
  check("a 1080p frame holds four pieces open", maxOverlappedPieces(1920, 1080) === 4, String(maxOverlappedPieces(1920, 1080)));
  check("a 4K frame holds fewer", maxOverlappedPieces(3840, 2160) < maxOverlappedPieces(1920, 1080));
  check(
    "and a small one holds more, up to the limit on the graph itself",
    maxOverlappedPieces(320, 240) === 12,
    String(maxOverlappedPieces(320, 240)),
  );
  const measured = Number(ffprobe(many.output, "format=duration")[0]);
  check(
    "and it is still the length the renderer said",
    Math.abs(measured - many.estimatedSeconds) <= TOLERANCE,
    `said ${many.estimatedSeconds.toFixed(2)}s, measured ${measured}`,
  );
}

// ── The plans we ship ourselves ─────────────────────────────────────────────
//
// A template is a saved edit plan, and the one-click buttons are the first
// thing somebody does with this product. Until now the only check on them was
// that they *build* — that calling build() returns operations. Nothing
// rendered one, so a template could have named an operation the renderer
// cannot execute, or promised a length nobody measured, and the first person
// to find out would have been a customer clicking the button.
//
// This clip is deliberately unlike the one above: long, evenly spaced bursts,
// so the silence cut leaves real pieces rather than slivers. The dissolve in
// "the look" is refused on pieces too short to cross, which is correct and
// which would also have made this section pass without ever testing it.
console.log("\nEvery template we ship renders");
{
  const spoken = path.join(workDir, "template-source.mp4");
  {
    const windows = [];
    for (let t = 0; t < 36; t += 6) windows.push(`between(t,${t},${t + 4})`);
    spawnSync("ffmpeg", [
      "-y", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25:duration=36",
      "-f", "lavfi", "-i", "sine=frequency=320:duration=36",
      "-filter_complex", `[1:a]volume='if(${windows.join("+")},1,0)':eval=frame[a]`,
      "-map", "0:v", "-map", "[a]",
      "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", spoken,
    ]);
  }

  check("there are templates to render", TEMPLATES.length >= 5, String(TEMPLATES.length));

  /*
    The description is a promise, and it is the only part of a look anybody
    reads.

    Nobody opens a template to see which operations it contains. They read one
    sentence in a row of cards and press it, so that sentence is the entire
    contract — and until this check existed, three looks broke it in the two
    directions it can be broken.

    `tight-talking-head`, `high-energy` and `podcast-clip` burned no captions
    at all. Between them they are the looks built around a person talking to
    camera, which is most of what this product is pointed at, and a talking
    clip in these feeds is read with the sound off. Nothing failed: a correct
    render of something nobody can post.

    And `podcast-clip` said "clip" in its own name while cutting nothing out.
    Pointed at the ninety-minute episode its own `bestFor` invites, it returned
    ninety captioned minutes.

    So: a look that says it captions must carry a caption operation, a look
    that does not must not, and a look whose words promise a piece of the take
    must take a piece of it. Read off the description rather than from a list
    kept beside it, because a list beside it is a second thing to forget.
  */
  {
    const wrong = [];
    for (const template of TEMPLATES) {
      const said = `${template.name} ${template.description}`.toLowerCase();
      const operations = template.build({
        platform: "tiktok", durationSeconds: 36, watermark: false, musicAssetId: "track",
      });
      const kinds = operations.map((o) => o.type);
      const hasCaptions = kinds.includes("autoCaptions") || kinds.includes("burnCaptions");
      const promisesCaptions = /caption/.test(said);
      const cuts = kinds.includes("extractClips") || kinds.includes("extractHighlight");
      // "clip" as a noun for what comes out — not "clips every pause", which
      // is a different verb about a different thing.
      const promisesAPiece = /\bclips?\b|best \d+ seconds|strongest \d+ seconds/.test(said);

      if (promisesCaptions !== hasCaptions) {
        wrong.push(
          `${template.id}: says ${promisesCaptions ? "" : "nothing about "}captions and ${hasCaptions ? "burns" : "burns none"}`,
        );
      }
      if (promisesAPiece && !cuts) {
        wrong.push(`${template.id}: its own words promise a piece of the take, and it returns all of it`);
      }
    }
    check("every look does what its own sentence says", wrong.length === 0, wrong.join(" | "));
  }

  const results = new Map();
  const broke = [];
  const drifted = [];
  const mute = [];
  for (const template of TEMPLATES) {
    // Watermarked, because that is what a free account gets and it is the
    // variant with the most operations in it.
    // `musicAssetId` is only read by the one look that declares it needs a
    // track, and the route refuses that look before building it when the
    // project has none — so here it is always the fixture track, which is what
    // a project that passed that check would have.
    const operations = template.build({
      platform: "tiktok",
      durationSeconds: 36,
      watermark: true,
      musicAssetId: "track",
    });
    let out = null;
    try {
      out = await renderPlan(spoken, { version: 1, operations }, { workDir: await scratch(), assets });
    } catch (e) {
      broke.push(`${template.id}: ${String(e?.message ?? e).slice(0, 140)}`);
      continue;
    }
    rendered += 1;
    results.set(template.id, out);
    const measured = Number(ffprobe(out.output, "format=duration")[0]);
    if (!Number.isFinite(measured) || Math.abs(measured - out.estimatedSeconds) > TOLERANCE) {
      drifted.push(`${template.id}: said ${out.estimatedSeconds?.toFixed?.(2)}s, measured ${measured}`);
    }
    if (!ffprobe(out.output, "stream=codec_type").includes("audio")) mute.push(template.id);
  }

  check(`all ${TEMPLATES.length} of them render`, broke.length === 0, broke.join(" | "));
  check("each is the length the renderer said", drifted.length === 0, drifted.join(" | "));
  check("and none of them loses the sound", mute.length === 0, mute.join(", "));

  // Every template carries the mark on a free account, and that is the one
  // promise made to us rather than to the customer.
  const unmarked = [...results.entries()].filter(([, out]) => !out.notes.some((n) => /watermarked/.test(n)));
  check("and every one of them carries the mark", unmarked.length === 0, unmarked.map(([id]) => id).join(", "));

  // "The look" is the only template whose name is a claim about the picture,
  // so it is the only one whose notes are read: the dissolve and the grade are
  // what the button says it does.
  const look = results.get("the-look");
  check(
    "the look dissolves between the cuts, which is half of what it promises",
    look?.notes.some((n) => /dissolved between the cuts/.test(n)),
    JSON.stringify(look?.notes),
  );
  check(
    "and grades the picture, which is the other half",
    look?.notes.some((n) => /graded it cinematic/.test(n)),
    JSON.stringify(look?.notes),
  );
  check(
    "and is shorter than the same cut without the dissolve, because an overlap costs length",
    look && results.get("clean-cut") && look.estimatedSeconds < results.get("clean-cut").estimatedSeconds - 0.1,
    `${look?.estimatedSeconds?.toFixed(2)}s against ${results.get("clean-cut")?.estimatedSeconds?.toFixed(2)}s`,
  );
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

console.log("\nA look that cannot deliver its promise is refused before it is queued");
{
  /*
    Both refusals a template can raise are decided here, before a job is queued
    or billed: a beat-cut look with no track to cut to, and a clip look on a
    recording too short to lift a clip out of. `three-clips` on a 20s upload
    used to queue a render and then fail deep in the worker with an empty plan,
    after the person was charged; `the-highlight` and `podcast-clip` on a short
    clip quietly returned the whole file captioned. Now they are stopped at the
    door with a message that says which look and why.
  */
  // Guarded so a revert that removes the helper fails these checks cleanly
  // rather than throwing: with no preflight there is no refusal, which is
  // exactly the bug — the job would be queued.
  const pre = (id, durationSeconds, hasMusic) =>
    typeof templatePreflight === "function"
      ? templatePreflight(findTemplate(id), { durationSeconds, hasMusic })
      : { ok: true };

  check(
    "three-clips is refused on a source too short for three clips",
    pre("three-clips", 20, false).ok === false,
    JSON.stringify(pre("three-clips", 20, false)),
  );
  check(
    "the-highlight is refused on a clip shorter than the window it extracts",
    pre("the-highlight", 25, false).ok === false,
  );
  check(
    "podcast-clip is refused on a clip that would come back whole",
    pre("podcast-clip", 40, false).ok === false,
  );
  check(
    "and the refusal names the look and the length in both languages",
    (() => {
      const r = pre("three-clips", 20, false);
      return !r.ok && /three/i.test(r.reason) && /20/.test(r.reason) && /90/.test(r.reason) && /[؀-ۿ]/.test(r.reasonAr);
    })(),
  );

  check(
    "a long enough recording passes",
    pre("three-clips", 300, false).ok === true,
    JSON.stringify(pre("three-clips", 300, false)),
  );
  check(
    "an unmeasured source is not refused as too short — that is a false refusal",
    pre("three-clips", null, false).ok === true,
  );
  // The music refusal still lives here too.
  check(
    "the beat look is still refused with no track",
    pre("on-the-beat", 300, false).ok === false,
  );
  check(
    "and passes with one",
    pre("on-the-beat", 300, true).ok === true,
  );
  // A look with no length requirement works at any length.
  check(
    "a look built for any length is not gated on duration",
    pre("tight-talking-head", 8, false).ok === true,
  );
}

await rm(workDir, { recursive: true, force: true });
await rm(buildDir, { recursive: true, force: true });

console.log(`\n${rendered} renders, ${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("Operations that work alone also work together.");
