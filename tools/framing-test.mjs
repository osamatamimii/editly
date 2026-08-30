/**
 * Does the window go where the person is, and does it stay still when it should?
 *
 * Reframing a landscape take to 9:16 throws away most of the width. Which part
 * it throws away is the single most recognisable tell of an automatic edit —
 * a centre crop on an interview delivers a shoulder — so this is not a
 * cosmetic feature, and it has two failure modes that pull against each other.
 *
 * Framing the wrong thing is the obvious one. The less obvious one, and the one
 * that actually makes an edit look amateur, is a frame that *follows* — a crop
 * chasing every head movement reads as a camera operator who has had too much
 * coffee, and is worse than a slightly off crop that holds still. So most of
 * the checks below are about the frame refusing to move.
 *
 * The end of this file renders a real clip of a face crossing the frame and
 * measures where the person ended up in the output, because every claim above
 * is a claim about a video file and not about a data structure.
 *
 * Usage: node tools/framing-test.mjs
 * Requires: ffmpeg. Python and OpenCV for the tracking section, which skips
 * itself with a loud line rather than failing when they are absent.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-framing-build-"));

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

const { subjectPath, cropExpression, MIN_SUBJECT_COVERAGE } = await import(
  bundle("artifacts/worker/src/framing.ts", "framing.mjs")
);
const { trackSubject, trackNote } = await import(bundle("artifacts/worker/src/subject.ts", "subject.mjs"));
const { renderPlan } = await import(bundle("artifacts/worker/src/ffmpeg.ts", "ffmpeg.mjs"));

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
const section = (title) => console.log(`\n${title}`);
const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance;

/** A 9:16 window out of a 16:9 frame covers just under a third of the width. */
const WINDOW = 0.32;
const at = (seconds, x) => ({ t: seconds, x });
/** `n` samples at 4fps, x from a function of index. */
const track = (n, fn) => Array.from({ length: n }, (_, i) => at(i / 4, fn(i)));

// ─── The frame holding still ─────────────────────────────────────────────────

section("A subject who stays put gets a frame that never moves");
{
  const path = subjectPath(track(240, () => 0.3), WINDOW);
  check("one keyframe, which is a held frame", path.keyframes.length === 1, JSON.stringify(path.keyframes));
  check("it does not report moving", path.moves === false);
  check("and it is on the subject, not the centre", near(path.keyframes[0].x, 0.3, 0.01), String(path.keyframes[0].x));
}

section("Small movement is not movement");
{
  // Drifting within a fifth of the window is a person shifting in their chair.
  const wobble = subjectPath(track(240, (i) => 0.5 + Math.sin(i / 3) * 0.05), WINDOW);
  check("a shifting speaker does not move the frame", wobble.moves === false, JSON.stringify(wobble.keyframes));

  // Single-frame false positives on the far side of the frame.
  const spikes = subjectPath(
    track(240, (i) => (i % 40 === 0 ? 0.95 : 0.3)),
    WINDOW,
  );
  check("nor do isolated false positives", spikes.moves === false, JSON.stringify(spikes.keyframes));
  check("the frame stays on the real subject", near(spikes.keyframes[0].x, 0.3, 0.02), String(spikes.keyframes[0].x));
}

section("A subject who genuinely moves is followed, slowly");
{
  // Sitting left for 15s, then right for 45s.
  const path = subjectPath(track(240, (i) => (i < 60 ? 0.25 : 0.75)), WINDOW);
  check("the frame moves", path.moves === true);
  check("it starts where they started", near(path.keyframes[0].x, 0.25, 0.02), String(path.keyframes[0].x));
  check("and ends where they ended", near(path.keyframes[path.keyframes.length - 1].x, 0.75, 0.02));

  // Every move is a pair: hold to here, then arrive there.
  const moves = (path.keyframes.length - 1) / 2;
  check("in one move, not a chase", moves === 1, `${moves} moves`);

  const [, holdAt, arriveAt] = path.keyframes;
  check("the move takes long enough to read as intentional", arriveAt.t - holdAt.t >= 0.5, String(arriveAt.t - holdAt.t));
  check("and not so long it lags the subject out of frame", arriveAt.t - holdAt.t <= 1.5);
  check("it begins roughly when they moved", near(holdAt.t, 15, 1.5), String(holdAt.t));
}

section("A subject who paces is not chased");
{
  // Crossing the whole frame every two seconds for a minute. Following this
  // literally would be 30 moves and unwatchable.
  const path = subjectPath(track(240, (i) => (Math.floor(i / 8) % 2 === 0 ? 0.2 : 0.8)), WINDOW);
  const moves = (path.keyframes.length - 1) / 2;
  check("the frame does not move once per pace", moves < 30, `${moves} moves`);
  check("it moves at most once every couple of seconds", moves <= 25, `${moves} moves`);
  for (let i = 3; i < path.keyframes.length; i += 2) {
    const gap = path.keyframes[i].t - path.keyframes[i - 1].t;
    if (gap < 2) {
      check("consecutive moves are spaced", false, `${gap.toFixed(2)}s between moves`);
      break;
    }
  }
  check("consecutive moves are spaced", true);
}

section("The window never leaves the picture");
{
  const path = subjectPath(track(240, (i) => (i < 60 ? 0.02 : 0.98)), WINDOW);
  const half = WINDOW / 2;
  check(
    "a subject at the very edge does not push the window off it",
    path.keyframes.every((k) => k.x >= half - 0.001 && k.x <= 1 - half + 0.001),
    JSON.stringify(path.keyframes),
  );
}

section("Nothing to follow is not a reason to guess");
{
  const none = subjectPath(track(240, () => null), WINDOW);
  check("no readings, no keyframes", none.keyframes.length === 0);
  check("and no claim of movement", none.moves === false);
  check("coverage says so", none.coverage === 0);

  const empty = subjectPath([], WINDOW);
  check("an empty track is handled", empty.keyframes.length === 0 && empty.coverage === 0);
}

section("A gap in the readings holds the frame, it does not interpolate through it");
{
  // Visible on the left, gone for ten seconds, back on the left.
  const samples = track(240, (i) => (i >= 60 && i < 100 ? null : 0.25));
  const path = subjectPath(samples, WINDOW);
  check("someone turning away does not move the frame", path.moves === false, JSON.stringify(path.keyframes));
  check("coverage reports the gap honestly", near(path.coverage, 200 / 240, 0.01), String(path.coverage));
}

// ─── The expression ffmpeg has to evaluate ───────────────────────────────────

section("The path becomes something ffmpeg can evaluate per frame");
{
  const held = cropExpression([{ t: 0, x: 0.5 }], 1920, 608);
  check("a held frame is a plain number, not an expression", /^\d+$/.test(held), held);
  check("centred on the subject", near(Number(held), 1920 * 0.5 - 304, 2), held);

  const moving = cropExpression(
    [{ t: 0, x: 0.25 }, { t: 10, x: 0.25 }, { t: 10.8, x: 0.75 }],
    1920,
    608,
  );
  check("a moving frame is an expression in t", moving.includes("t"), moving.slice(0, 80));
  check("it is bracketed to an even pixel", moving.startsWith("2*floor("), moving.slice(0, 20));
  check("every conditional is closed", (moving.match(/\(/g) || []).length === (moving.match(/\)/g) || []).length);
  check("it stays within a few kilobytes", moving.length < 4096, `${moving.length} chars`);

  // Whether ffmpeg agrees is not something to reimplement here — the render at
  // the bottom of this file puts the expression through the real filter and
  // then looks for the face in the output, which is the only version of this
  // question that matters.

  const wide = cropExpression([{ t: 0, x: 0.5 }], 1920, 1920);
  check("a window as wide as the frame cannot be offset", Number(wide) === 0, wide);
}

section("The offset never runs past the edge of the image");
{
  const left = cropExpression([{ t: 0, x: 0 }], 1920, 608);
  const right = cropExpression([{ t: 0, x: 1 }], 1920, 608);
  check("a subject at the far left clamps to zero", Number(left) === 0, left);
  check("a subject at the far right clamps to the edge", Number(right) === 1920 - 608, right);
  check("and both are even", Number(left) % 2 === 0 && Number(right) % 2 === 0);
}

// ─── What the tracker refuses to be believed about ───────────────────────────

section("A track too sparse to be a track is not used");
{
  check("the threshold is a real fraction", MIN_SUBJECT_COVERAGE > 0 && MIN_SUBJECT_COVERAGE < 1);
  // Both halves, because `say.ts` requires both of every note — a note that
  // returns a bare string is how English leaks into an Arabic render.
  const en = (a) => a;
  const ar = (_a, b) => b;
  check("nothing found at all is explained", /no face to follow/.test(trackNote({ samples: [], coverage: 0 }, en) ?? ""));
  check(
    "and explained in Arabic when the render is Arabic",
    /لا وجه لتتبّعه/.test(trackNote({ samples: [], coverage: 0 }, ar) ?? ""),
    trackNote({ samples: [], coverage: 0 }, ar) ?? "null",
  );
  const sparse = trackNote({ samples: [], coverage: 0.12 }, en);
  check("a sparse track is explained with its own number", /12%/.test(sparse ?? ""), sparse ?? "");
  check("a good track needs no explanation", trackNote({ samples: [], coverage: 0.9 }, en) === null);
  check("and no track at all is not an explanation either", trackNote(null) === null);
}

section("The tracker never throws, whatever is wrong with the machine");
{
  const missing = await trackSubject("/nonexistent/clip.mp4", 1280, 720);
  check("a file that is not there comes back null", missing === null);

  const noPython = await trackSubject("/nonexistent/clip.mp4", 1280, 720, { python: "definitely-not-a-binary" });
  check("a missing interpreter comes back null", noPython === null);
}

// ─── The real thing ──────────────────────────────────────────────────────────

const workDir = await mkdtemp(path.join(tmpdir(), "editly-framing-"));
const ff = (args) => spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...args], { stdio: "inherit" }).status === 0;

// A real photograph of a face, from matplotlib's sample data — synthesising one
// would test the drawing, not the detector.
const facePath = path.join(workDir, "face.jpg");
const copied = spawnSync("python3", [
  "-c",
  `import matplotlib, os, shutil; shutil.copy(os.path.join(os.path.dirname(matplotlib.__file__),'mpl-data','sample_data','grace_hopper.jpg'), ${JSON.stringify(facePath)})`,
]);

const haveVision =
  copied.status === 0 &&
  spawnSync("python3", ["-c", "import cv2, numpy"]).status === 0;

if (!haveVision) {
  console.log("\n! Skipping the tracking section: python3 with opencv and numpy is not on this machine.");
  console.log("  The renderer degrades to the static measurement in exactly this case, which is the point.");
} else {
  section("A face crossing the frame is found, and followed");
  const clip = path.join(workDir, "walking.mp4");
  // 16 seconds, the face travelling from the left third to the right third.
  const built = ff([
    "-f", "lavfi", "-i", "color=c=gray:s=1280x720:d=16:r=25",
    "-i", facePath,
    "-filter_complex",
    "[1:v]scale=-1:400[f];[0:v][f]overlay=x='140+(W-w-280)*(t/16)':y=160",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", clip,
  ]);
  check("the test clip was built", built);

  // Explicit, because the bundle under test lives in a temp directory and the
  // script does not travel with it. In the worker both are in dist/ together.
  const script = path.join(repoRoot, "artifacts/worker/scripts/track-subject.py");
  const found = await trackSubject(clip, 1280, 720, { scriptPath: script });
  check("the tracker returns a track", found !== null);
  check("with a sample per quarter second", found && found.samples.length > 50, String(found?.samples.length));
  check(
    "and finds the face in most frames",
    found && found.coverage >= MIN_SUBJECT_COVERAGE,
    `coverage ${found?.coverage.toFixed(2)}`,
  );

  const seen = found.samples.filter((s) => s.x !== null);
  check("it sees the face start on the left", seen[0].x < 0.4, String(seen[0].x));
  check("and end on the right", seen[seen.length - 1].x > 0.6, String(seen[seen.length - 1].x));

  const walked = subjectPath(found.samples, WINDOW);
  check("the frame follows", walked.moves === true, JSON.stringify(walked.keyframes));
  check("without chasing — a 16s walk is a handful of moves", (walked.keyframes.length - 1) / 2 <= 6, JSON.stringify(walked.keyframes));
  check(
    "and it ends further right than it began",
    walked.keyframes[walked.keyframes.length - 1].x > walked.keyframes[0].x + 0.1,
    JSON.stringify(walked.keyframes),
  );

  section("And the rendered file actually contains the person");
  // The renderer resolves the tracker beside its own module, and the module
  // under test is a bundle in a temp directory. This is the override the code
  // provides for exactly that, and setting it is what makes the next four
  // checks a test of the pipeline rather than of the fallback.
  process.env.SUBJECT_SCRIPT = script;
  const outDir = path.join(workDir, "out");
  await mkdir(outDir, { recursive: true });
  const { output, notes } = await renderPlan(
    clip,
    { version: 1, operations: [{ type: "formatForPlatform", platform: "tiktok" }] },
    { workDir: outDir },
  );
  await writeFile(path.join(workDir, "notes.json"), JSON.stringify(notes, null, 1));
  check("it renders", Boolean(output));
  check("the render says it followed the speaker", notes.some((n) => /followed the speaker|held there/.test(n)), JSON.stringify(notes));

  // The proof: detect the face in the *output* and check it is near the middle
  // of the frame, at the start and again at the end. A static centre crop of
  // this clip would lose the face entirely by the last second.
  const measured = await trackSubject(output, 1080, 1920, { scriptPath: script });
  check("a face is still visible in the export", measured !== null && measured.coverage > 0.3, `coverage ${measured?.coverage.toFixed(2)}`);

  const inFrame = measured.samples.filter((s) => s.x !== null);
  const first = inFrame.slice(0, 8);
  const last = inFrame.slice(-8);
  const mean = (xs) => xs.reduce((a, b) => a + b.x, 0) / xs.length;
  check("the speaker is near the middle at the start", near(mean(first), 0.5, 0.22), mean(first).toFixed(3));
  check("and still near the middle at the end", near(mean(last), 0.5, 0.22), mean(last).toFixed(3));

  // ── The crop is drawn on the edit's clock, not the recording's ────────────
  //
  // The tracker samples the *original* file, so its keyframes are seconds into
  // the recording. The crop filter runs after the trims and the concat, where
  // `t` is seconds into the *edit*. Every other thing placed in time goes
  // through `remapTime` — captions, punches, overlays, titles. The reframe did
  // not, and nothing failed: the crop was valid, the picture moved, and it
  // moved smoothly. It simply moved at the wrong moments.
  //
  // A cut render makes that a lag. This makes it total. `extractRange` keeps
  // only the last four seconds, where the face is hard right — and every
  // keyframe from the first twelve seconds now sits past the end of a
  // four-second output, so the window holds whatever the first keyframe said,
  // which is the far left. The face leaves the frame completely.
  section("A window cut out of the middle still follows the person inside it");
  {
    const cutDir = path.join(workDir, "cut");
    await mkdir(cutDir, { recursive: true });
    const late = await renderPlan(
      clip,
      {
        version: 1,
        operations: [
          { type: "extractRange", startSeconds: 12, endSeconds: 16 },
          { type: "formatForPlatform", platform: "tiktok" },
        ],
      },
      { workDir: cutDir },
    );
    check("it renders", Boolean(late.output), JSON.stringify(late.notes));

    const lateSeen = (await trackSubject(late.output, 1080, 1920, { scriptPath: script }))?.samples ?? [];
    const visible = lateSeen.filter((sample) => sample.x !== null);
    check(
      "the face is in the exported window at all",
      visible.length >= lateSeen.length * 0.3,
      `${visible.length} of ${lateSeen.length} frames`,
    );
    check(
      "and near the middle of it, rather than pushed to an edge by a stale keyframe",
      visible.length > 0 && near(mean(visible), 0.5, 0.25),
      visible.length > 0 ? mean(visible).toFixed(3) : "no face found",
    );
  }

  section("And the old framing really does lose them");
  // The same clip with the tracker unavailable, which is the code path every
  // render took until now. Without this the checks above prove the pipeline
  // runs, not that it is worth running.
  delete process.env.SUBJECT_SCRIPT;
  process.env.PYTHON_PATH = "definitely-not-a-binary";
  const staticDir = path.join(workDir, "static");
  await mkdir(staticDir, { recursive: true });
  const still = await renderPlan(
    clip,
    { version: 1, operations: [{ type: "formatForPlatform", platform: "tiktok" }] },
    { workDir: staticDir },
  );
  delete process.env.PYTHON_PATH;
  process.env.SUBJECT_SCRIPT = script;

  check(
    "it falls back rather than failing",
    still.notes.some((n) => /centre|subject rather than/.test(n)),
    JSON.stringify(still.notes),
  );

  const staticMeasured = await trackSubject(still.output, 1080, 1920, { scriptPath: script });
  const staticSeen = (staticMeasured?.samples ?? []).filter((s) => s.x !== null);
  check("a face is visible in it too, at least sometimes", staticSeen.length > 0, String(staticSeen.length));

  const drift = Math.abs(mean(staticSeen.slice(0, 8)) - 0.5) + Math.abs(mean(staticSeen.slice(-8)) - 0.5);
  const trackedDrift = Math.abs(mean(first) - 0.5) + Math.abs(mean(last) - 0.5);
  check(
    "but they sit further off centre than the tracked version",
    drift > trackedDrift,
    `static ${drift.toFixed(3)} vs tracked ${trackedDrift.toFixed(3)}`,
  );
  check(
    "which is the whole reason this exists",
    staticMeasured === null || staticMeasured.coverage <= measured.coverage + 0.05,
    `static coverage ${staticMeasured?.coverage.toFixed(2)} vs ${measured.coverage.toFixed(2)}`,
  );
}

await rm(buildDir, { recursive: true, force: true });
await rm(workDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("The window goes where the person is, and stays there.");
