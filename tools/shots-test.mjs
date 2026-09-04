/**
 * Does the frame actually change size, and does it refuse when it should?
 *
 * `alternateFraming` is the operation that makes one camera read as two: the
 * cuts alternate between a wide and a tight version of the same window. It is
 * the most *deniable* feature in this repository, because everything about it
 * can be right in the source and absent from the video. The zoom expression can
 * carry a term that never fires. The term can fire and the picture not change,
 * because `zoompan` clamps a zoom below 1 and says nothing. The sizes can
 * alternate on a clip with two pieces in it, which is not coverage, it is an
 * export that looks broken.
 *
 * So the second half of this file does not read the filter graph. It renders a
 * real clip through the real `renderPlan`, decodes one row of every frame, and
 * measures the width of a white bar that was 128 pixels wide in the source.
 * Every claim this operation makes is a claim about that number:
 *
 *   - two sizes appear and only two,
 *   - the wider of them is the *whole* source frame, which is what "it costs
 *     nothing" means — the wide shot is the overscan margin the renderer was
 *     already cropping away and throwing out,
 *   - the tighter one is 1.15 times it, which is the frame a motion render
 *     delivers today,
 *   - the video opens on the wide one,
 *   - and the change happens between two frames, with nothing in between.
 *
 * That last one is the check worth having. A ramp here would look fine, pass
 * every source-level assertion, and be the exact amateur move the operation
 * exists to replace: one camera zooming across a cut. The only way to catch it
 * is to look for an intermediate width in the pixels, and there must not be one.
 *
 * Usage: node tools/shots-test.mjs
 * Requires: ffmpeg. No keys, no network, no database.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-shots-build-"));

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

const {
  shotsFrom,
  alternateShots,
  takesFrom,
  overscanFor,
  scaleFor,
  MIN_SHOT_SECONDS,
  MIN_SIZE_HOLD_SECONDS,
  MIN_SHOTS,
  TIGHT_CEILING,
} = await import(bundle("artifacts/worker/src/shots.ts", "shots.mjs"));

const { renderPlan, probeSource, zoomExpression, MOTION_OVERSCAN } = await import(
  bundle("artifacts/worker/src/ffmpeg.ts", "ffmpeg.mjs")
);

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

const scratch = () => mkdtemp(path.join(tmpdir(), "editly-shots-"));
const seconds = (n) => Array.from({ length: n });

/** Shots of equal length, which is the shape most of the rules are about. */
const evenShots = (count, length) =>
  seconds(count).map((_, i) => ({ start: i * length, end: (i + 1) * length }));

// ── Where the joins are ─────────────────────────────────────────────────────

console.log("\nThe cut, on the clock the viewer is watching");
{
  const kept = [
    { start: 0, end: 4 },
    { start: 10, end: 13 },
    { start: 20, end: 25 },
  ];
  const shots = shotsFrom(kept, 0, 12);
  check("one shot per kept piece", shots.length === 3, JSON.stringify(shots));
  check(
    "the joins are where the pieces land in the edit, not in the recording",
    shots[1].start === 4 && shots[2].start === 7,
    JSON.stringify(shots.map((s) => s.start)),
  );
  check("the last shot runs to the end of the output", shots[2].end === 12, String(shots[2].end));

  /*
    A dissolve eats time at every join, and the joins after it move earlier by
    the whole amount eaten so far. Getting this wrong is not visible: the sizes
    would still alternate, each change would land a fraction of a second off its
    cut, and the only symptom is that the edit feels slightly wrong.
  */
  const dissolved = shotsFrom(kept, 0.5, 12 - 2 * 0.5);
  check(
    "an overlapping join pulls everything after it earlier",
    Math.abs(dissolved[1].start - 3.5) < 1e-9 && Math.abs(dissolved[2].start - 6) < 1e-9,
    JSON.stringify(dissolved.map((s) => s.start)),
  );

  check("nothing cut means one shot", shotsFrom(null, 0, 30).length === 1, "");
  check("a zero-length output has no shots", shotsFrom(null, 0, 0).length === 0, "");
}

// ── Every rule points at doing nothing ──────────────────────────────────────

console.log("\nWhen the material does not support it, nothing happens");
{
  check(
    `${MIN_SHOTS - 1} pieces is one join, and one size change is not a pattern`,
    alternateShots(evenShots(2, 5)).length === 0,
    "",
  );
  check("an uncut clip is left alone", takesFrom(null, 0, 60).length === 0, "");

  // Twelve quick cuts, none of them long enough to be a shot. Under the
  // inheritance rule every one of them keeps the opening size, so the whole
  // video comes out at one size — which is not an alternation and must produce
  // nothing at all rather than a permanent crop.
  const rapid = alternateShots(evenShots(12, MIN_SHOT_SECONDS - 0.3));
  check("a machine-gun cut is left alone rather than cropped", rapid.length === 0, JSON.stringify(rapid));
}

console.log("\nThe thresholds, one at a time");
{
  const takes = alternateShots(evenShots(4, 4));
  check("four long shots alternate", takes.length === 4, JSON.stringify(takes));
  check("the video opens wide", takes[0].size === "wide", takes[0]?.size);
  check(
    "and then alternates",
    takes.map((t) => t.size).join(",") === "wide,tight,wide,tight",
    takes.map((t) => t.size).join(","),
  );

  /*
    A glimpse inherits rather than being skipped.

    Skipping it is the tempting fix and it is the bug: the size would change
    going into the glimpse and change back coming out of it, which is a flicker
    inside a shot too short to read — the exact flutter the minimum length was
    written to prevent, reintroduced by the thing meant to prevent it.
  */
  const withGlimpse = alternateShots([
    { start: 0, end: 4 },
    { start: 4, end: 4.6 },
    { start: 4.6, end: 9 },
  ]);
  const sizeAt = (t) => withGlimpse.find((take) => t >= take.from && t < take.to)?.size;
  check("a glimpse keeps the size of the shot before it", sizeAt(4.2) === sizeAt(3), `${sizeAt(3)} then ${sizeAt(4.2)}`);
  check("and the shot after it is the one that changes", sizeAt(5) !== sizeAt(4.2), `${sizeAt(4.2)} then ${sizeAt(5)}`);

  /*
    Two changes closer together than the hold are one change with a stutter in
    it. Six shots of a second and a half each are all long enough to be shots,
    so only the hold can stop this — and without it the frame would change size
    six times in nine seconds.
  */
  const quick = alternateShots(evenShots(6, 1.5));
  const changes = quick.length - 1;
  const gaps = quick.slice(1).map((take, i) => take.from - quick[i].from);
  check(
    `no two changes closer than ${MIN_SIZE_HOLD_SECONDS}s`,
    gaps.every((gap) => gap >= MIN_SIZE_HOLD_SECONDS - 1e-9),
    JSON.stringify(gaps),
  );
  check("so six quick shots become fewer sizes than shots", changes < 5, `${changes} changes`);
}

console.log("\nWhen the close size stops being an accent");
{
  /*
    Alternating strictly, a long tight shot between two short wide ones can hold
    most of the running time. At that point the tight size is not emphasis, it
    is the frame — and the wide moments read as the video pulling back, which is
    a different edit than the one asked for. So the sizes swap.
  */
  const lopsided = [
    { start: 0, end: 2 },
    { start: 2, end: 22 },
    { start: 22, end: 24 },
    { start: 24, end: 44 },
  ];
  const straight = alternateShots(evenShots(4, 4));
  const tightShare = (takes) => {
    const total = takes[takes.length - 1].to - takes[0].from;
    return takes.reduce((sum, t) => sum + (t.size === "tight" ? t.to - t.from : 0), 0) / total;
  };
  check("an even cut needs no correction", tightShare(straight) <= TIGHT_CEILING, tightShare(straight).toFixed(2));

  const corrected = alternateShots(lopsided);
  check(
    `a lopsided cut is swapped back under ${Math.round(TIGHT_CEILING * 100)}%`,
    tightShare(corrected) <= TIGHT_CEILING,
    tightShare(corrected).toFixed(2),
  );
  // The swap lands the video on its accent; the opening is put back out, which
  // can only reduce the tight share further and so cannot undo the correction.
  check("and it still opens wide", corrected[0].size === "wide", corrected[0].size);

  // Swapping can flatten a three-shot alternation into one size. That is a
  // no-op, and a no-op has to come back empty rather than as a single take.
  const flattened = alternateShots([
    { start: 0, end: 2 },
    { start: 2, end: 30 },
    { start: 30, end: 32 },
  ]);
  check(
    "a swap that leaves one size produces no takes at all",
    flattened.length === 0 || new Set(flattened.map((t) => t.size)).size === 2,
    JSON.stringify(flattened),
  );

  const merged = alternateShots(evenShots(4, 4));
  check(
    "neighbouring shots at one size are one take",
    merged.every((take, i) => i === 0 || take.size !== merged[i - 1].size),
    JSON.stringify(merged.map((t) => t.size)),
  );
}

// ── The arithmetic that keeps it free ───────────────────────────────────────

console.log("\nNeither size upscales");
{
  check("the close size is the frame that was asked for", scaleFor("tight", 0.15) === 1, "");
  check("the wide size only ever pulls back", scaleFor("wide", 0.15) < 1, String(scaleFor("wide", 0.15)));

  // The whole claim, as one inequality: the crop is wide enough to hold the
  // wide size. `zoompan` clamps a zoom below 1 and reports nothing, so if this
  // were ever false the wide shots would silently be the tight ones.
  for (const amount of [0.05, 0.12, 0.15, 0.2, 0.3]) {
    const overscan = overscanFor(MOTION_OVERSCAN, amount);
    const z = overscan * scaleFor("wide", amount);
    check(
      `at ${amount} the wide zoom stays at or above 1`,
      z >= 1 - 1e-9,
      `overscan ${overscan.toFixed(3)}, z ${z.toFixed(4)}`,
    );
  }
  check(
    "the default asks for exactly the margin the renderer already took",
    overscanFor(MOTION_OVERSCAN, 0.15) === MOTION_OVERSCAN,
    String(overscanFor(MOTION_OVERSCAN, 0.15)),
  );
  check(
    "a bigger pull-back widens the crop rather than upscaling",
    overscanFor(MOTION_OVERSCAN, 0.3) > MOTION_OVERSCAN,
    String(overscanFor(MOTION_OVERSCAN, 0.3)),
  );
}

console.log("\nThe zoom expression");
{
  const plain = zoomExpression({ base: 1.15, fps: 25, totalFrames: 100 });
  check("no takes leaves the expression exactly as it was", plain === "1.15", plain);

  const withTakes = zoomExpression({
    base: 1.15,
    fps: 25,
    totalFrames: 100,
    takes: [
      { from: 0, to: 2, scale: scaleFor("wide", 0.15) },
      { from: 2, to: 4, scale: scaleFor("tight", 0.15) },
    ],
  });
  check("a tight take adds nothing, because it is the base", withTakes.split("between").length === 2, withTakes);
  check(
    "a wide take's term is negative and parenthesised, so the sum parses",
    withTakes.includes("+(-"),
    withTakes,
  );
  check("and there is no ramp anywhere in it", !/min\(max\(/.test(withTakes.split("between")[0].slice(-40)), withTakes);
}

// ── In pixels ───────────────────────────────────────────────────────────────

const workDir = await scratch();
const source = path.join(workDir, "source.mp4");

/*
  A bar of a size we know, on a clip that will be cut into four pieces.

  Audible during 0-4, 6-10, 12-16 and 18-22, so silence removal leaves four
  pieces and therefore four shots. The picture is black with a white bar 128
  pixels wide down the middle, because the one thing this whole file is trying
  to measure is how wide something is.
*/
const BAR = 128;
const gen = spawnSync("ffmpeg", [
  "-y", "-loglevel", "error",
  "-f", "lavfi", "-i", `color=c=black:size=640x360:rate=25:duration=24`,
  "-f", "lavfi", "-i", "sine=frequency=300:duration=24",
  "-filter_complex",
  `[0:v]drawbox=x=${(640 - BAR) / 2}:y=0:w=${BAR}:h=360:color=white:t=fill[v];` +
    "[1:a]volume='if(between(t,0,4)+between(t,6,10)+between(t,12,16)+between(t,18,22),1,0)':eval=frame[a]",
  "-map", "[v]", "-map", "[a]",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
  source,
]);
if (gen.status !== 0) {
  console.error("could not generate the test clip");
  process.exit(1);
}

/**
 * The width of the bar in every frame of a file.
 *
 * One row of greyscale per frame, thresholded at half. Half-intensity is where
 * a resampled edge sits, so this measures the bar's true width to about a pixel
 * whichever way it was scaled — which matters, because the numbers being
 * compared are 128 and 147.
 */
function barWidths(file) {
  const r = spawnSync(
    "ffmpeg",
    [
      "-hide_banner", "-loglevel", "error",
      "-i", file,
      "-vf", "format=gray,crop=iw:1:0:ih/2",
      "-f", "rawvideo", "-pix_fmt", "gray", "-",
    ],
    { maxBuffer: 1 << 28 },
  );
  const raw = r.stdout;
  const width = 640;
  const widths = [];
  for (let f = 0; f + width <= raw.length; f += width) {
    let count = 0;
    for (let x = 0; x < width; x += 1) if (raw[f + x] > 128) count += 1;
    widths.push(count);
  }
  return widths;
}

/** The distinct widths in a run, with the near-identical ones collapsed. */
function levels(widths) {
  const found = [];
  for (const w of widths) {
    const near = found.find((level) => Math.abs(level.value - w) <= 2);
    if (near) near.count += 1;
    else found.push({ value: w, count: 1 });
  }
  // A single frame at an odd width is a resampling artefact, not a shot size.
  return found.filter((level) => level.count > 2).sort((a, b) => a.value - b.value);
}

const cut = { type: "removeSilence", thresholdDb: -32, minSilenceMs: 500, paddingMs: 80 };

console.log("\nThe picture really changes size");
let wide = NaN;
let tight = NaN;
{
  const { output, notes } = await renderPlan(
    source,
    { version: 1, operations: [cut, { type: "alternateFraming", amount: 0.15 }] },
    { workDir: await scratch() },
  );
  const widths = barWidths(output);
  const found = levels(widths);

  check("the render produced frames to measure", widths.length > 100, `${widths.length} frames`);
  check("two sizes, and only two", found.length === 2, JSON.stringify(found.map((l) => l.value)));

  if (found.length === 2) {
    wide = found[0].value;
    tight = found[1].value;

    /*
      The claim that it costs nothing, in pixels.

      The wide size is the whole source frame: a bar that was 128 wide is still
      128 wide. Every render with motion in it already crops to the overscan and
      throws that margin away — this spends it instead, which is why neither
      size is an upscale of anything.
    */
    check("the wide size is the whole frame the camera saw", Math.abs(wide - BAR) <= 2, `${wide}px, source ${BAR}px`);
    check(
      "the close size is the frame a motion render already delivers",
      Math.abs(tight - BAR * MOTION_OVERSCAN) <= 3,
      `${tight}px, expected ${(BAR * MOTION_OVERSCAN).toFixed(1)}px`,
    );
    check(
      "so the two sizes sit exactly one pull-back apart",
      Math.abs(tight / wide - 1.15) < 0.03,
      (tight / wide).toFixed(3),
    );
    check("and the video opens on the wide one", Math.abs(widths[0] - wide) <= 2, `${widths[0]}px`);

    /*
      A step, not a ramp — and this is the only place it can be proved.

      A quarter-second ease at 25fps would put six frames at widths between the
      two sizes. Nothing about that fails: the file plays, the sizes are right
      either side, and the edit simply looks like one camera zooming across a
      cut, which is the thing this operation exists to replace. So the check is
      for the absence of an in-between frame.
    */
    const between = widths.filter((w) => w > wide + 3 && w < tight - 3);
    check("nothing travels between the two sizes", between.length <= 2, `${between.length} frames in between`);

    const transitions = widths.filter(
      (w, i) => i > 0 && Math.abs(w - widths[i - 1]) > 3,
    ).length;
    check("and it changes size more than once", transitions >= 2, `${transitions} changes`);
  }

  check(
    "the worker says what it did, in both languages",
    notes.some((n) => /wide and a tight/.test(n) || /واسعة وأخرى ضيّقة/.test(n)),
    JSON.stringify(notes),
  );
  check(
    "and the edit is not made longer or shorter by it",
    Math.abs((await probeSource(output)).duration - 16.6) < 1.5,
    `${(await probeSource(output)).duration.toFixed(2)}s`,
  );
}

console.log("\nA push on its own does not enlarge anything");
{
  /*
    The overscan is what lets a wide take exist: the reframe crops a window
    larger than the target, and pulling back shows the margin. A push has no
    use for it — and without a reframe there is no margin to take, so the same
    number scaled the frame up by 1.15 and cropped straight back. Measured on a
    1920x1080 render, "a slow push" put 1671 of the 1920 columns on screen:
    thirteen per cent of the picture thrown away and every frame softened,
    before the push started, with nothing said about either.

    At the first frame a Ken Burns is still at its base, so the bar there is
    the bar the source has.
  */
  const { output } = await renderPlan(
    source,
    { version: 1, operations: [cut, { type: "kenBurns", to: 1.02 }] },
    { workDir: await scratch() },
  );
  const widths = barWidths(output);
  check(
    "a push opens on the picture as it was uploaded",
    Math.abs(widths[0] - BAR) <= 3,
    `${widths[0]}px against ${BAR}px`,
  );
  check(
    "which is smaller than the enlargement alternateFraming has to make",
    Number.isFinite(tight) && tight > widths[0] + 3,
    `${widths[0]}px against ${tight}px`,
  );
}

console.log("\nToo few cuts, and it says so instead of doing it anyway");
{
  const short = path.join(workDir, "short.mp4");
  spawnSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=black:size=640x360:rate=25:duration=6",
    "-f", "lavfi", "-i", "sine=frequency=300:duration=6",
    "-filter_complex",
    `[0:v]drawbox=x=${(640 - BAR) / 2}:y=0:w=${BAR}:h=360:color=white:t=fill[v]`,
    "-map", "[v]", "-map", "1:a",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    short,
  ]);

  const { output, notes } = await renderPlan(
    short,
    { version: 1, operations: [{ type: "alternateFraming", amount: 0.15 }] },
    { workDir: await scratch() },
  );
  const widths = barWidths(output);
  check(
    "an uncut clip comes out at one size",
    levels(widths).length === 1,
    JSON.stringify(levels(widths).map((l) => l.value)),
  );
  check(
    "at the size the camera saw, so nothing was cropped for an edit that did not happen",
    Math.abs(widths[0] - BAR) <= 2,
    `${widths[0]}px`,
  );
  check(
    "and the reason is in the notes rather than silent",
    notes.some((n) => /too few cuts/.test(n) || /قصّات أقلّ/.test(n)),
    JSON.stringify(notes),
  );
}

await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("One camera, two shot sizes, and every rule pointing at doing nothing.");
