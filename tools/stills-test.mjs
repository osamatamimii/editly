/**
 * A video made out of photographs, checked by looking at the video.
 *
 * This is the first thing in the product that *creates* footage rather than
 * editing it, which changes what a test has to prove. An edit can be checked
 * against its input — shorter by the silent part, louder at the cut. A reel has
 * no input to be checked against: if the motion expression silently did
 * nothing, every frame would still be a product photograph, the duration would
 * still be right, ffmpeg would still exit 0, and the output would be a
 * slideshow — the one thing this file exists to avoid, and the thing every
 * competitor in this category is accused of shipping.
 *
 * So the measurements below are about *change*: that a still is not the same
 * picture at the end of its hold as at the start, and that asking for no
 * movement really produces none. `colorbalance` was read correctly and did
 * nothing for weeks, and three colour looks were decoration; a zoom expression
 * that parses and does not move is the same bug wearing a new coat.
 *
 * The reels are built at 540x960 rather than 1080x1920. Every decision in
 * `stills.ts` is expressed as a ratio of the frame, so the smaller size
 * exercises the identical code four times faster — with one full-size build at
 * the end, because "it works at the size we ship" is a different claim.
 *
 * Usage: node tools/stills-test.mjs
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
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-stills-"));

function build(source, name) {
  const outfile = path.join(buildDir, name);
  const built = spawnSync(
    require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/worker"] }),
    [
      path.join(repoRoot, source),
      "--bundle", "--platform=node", "--format=esm", "--target=node22",
      `--outfile=${outfile}`, "--log-level=error",
    ],
    { stdio: "inherit" },
  );
  if (built.status !== 0) process.exit(1);
  return pathToFileURL(outfile).href;
}

const stills = await import(build("artifacts/worker/src/stills.ts", "stills.mjs"));
const zod = await import(build("lib/api-zod/src/index.ts", "zod.mjs"));
const keywords = await import(build("artifacts/api-server/src/lib/plan-from-text.ts", "plan.mjs"));

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

const scratch = () => mkdtemp(path.join(tmpdir(), "editly-reel-"));

function ffprobe(file, entries, extra = []) {
  const r = spawnSync(
    "ffprobe",
    ["-v", "error", ...extra, "-show_entries", entries, "-of", "default=nw=1:nk=1", file],
    { encoding: "utf8" },
  );
  return r.stdout.trim().split("\n").filter(Boolean);
}

/** A still, generated so the suite depends on no checked-in binary. */
function makeStill(dir, name, width, height, pattern = "testsrc2") {
  const file = path.join(dir, `${name}.png`);
  spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `${pattern}=size=${width}x${height}:d=1`,
    "-frames:v", "1", file,
  ]);
  return { file, width, height };
}

/** One frame of a video, written out so it can be measured. */
function frameAt(video, seconds, dir, name) {
  const file = path.join(dir, `${name}.png`);
  spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(seconds), "-i", video, "-frames:v", "1", file]);
  return file;
}

function statOf(image, filter = "") {
  const r = spawnSync(
    "ffprobe",
    [
      "-v", "error", "-f", "lavfi",
      "-i", `movie=${image}${filter ? `,${filter}` : ""},signalstats`,
      "-show_entries", "frame_tags=lavfi.signalstats.YAVG,lavfi.signalstats.YMIN,lavfi.signalstats.YMAX",
      "-of", "default=nw=1:nk=1",
    ],
    { encoding: "utf8" },
  );
  const [avg, min, max] = r.stdout.trim().split("\n").map(Number);
  return { avg, min, max };
}

/** How different two frames are. Zero means nothing moved. */
function difference(a, b) {
  const r = spawnSync(
    "ffprobe",
    [
      "-v", "error", "-f", "lavfi",
      "-i", `movie=${a}[x];movie=${b}[y];[x][y]blend=all_mode=difference,signalstats`,
      "-show_entries", "frame_tags=lavfi.signalstats.YAVG", "-of", "default=nw=1:nk=1",
    ],
    { encoding: "utf8" },
  );
  return Number(r.stdout.trim().split("\n")[0]);
}

// ── The arithmetic ──────────────────────────────────────────────────────────

section("An advertisement is a length before it is a number of photographs");
{
  const three = stills.reelTiming(3, 15);
  /*
    Twelve seconds, not fifteen. Three photographs cannot fill fifteen seconds
    without holding each one for five, and five seconds on a still product
    photo is where a feed viewer leaves. Coming out shorter than asked is the
    right failure; the render notes say so.
  */
  check("three photos and a fifteen-second target is four seconds each", three.secondsEach === 4 && three.seconds === 12, JSON.stringify(three));

  const many = stills.reelTiming(40, 15);
  check("forty photos fit twelve of them", many.keep === 12 && many.dropped === 28, JSON.stringify(many));
  check("and the reel is the length that was asked for", Math.abs(many.seconds - 15) < 0.05, String(many.seconds));
  check("with nothing held under the flash threshold", many.secondsEach >= stills.MIN_SECONDS_EACH, String(many.secondsEach));

  check("one photo is held at the maximum, not for the whole target", stills.reelTiming(1, 30).seconds === stills.MAX_SECONDS_EACH);
  check("and no photographs is no reel", stills.reelTiming(0, 15).keep === 0);

  // Every count, against both bounds. A timing that quietly leaves the range
  // is a reel that reads as broken and nothing that reports it.
  let outside = 0;
  for (let count = 1; count <= 60; count += 1) {
    for (const target of [3, 8, 15, 30, 60]) {
      const t = stills.reelTiming(count, target);
      if (t.secondsEach < stills.MIN_SECONDS_EACH - 1e-9 || t.secondsEach > stills.MAX_SECONDS_EACH + 1e-9) outside += 1;
      if (t.keep + t.dropped !== count) outside += 1;
    }
  }
  check("across every count and target, the pace stays inside its bounds and no photo is lost from the count", outside === 0, `${outside} cases`);
}

section("The motion alternates, so the size is continuous across every cut");
{
  const moves = [0, 1, 2, 3].map((i) => stills.motionFor(i, 0.12));
  check("the first pushes in", moves[0].from === 1 && moves[0].to > 1, JSON.stringify(moves[0]));
  check("the second pulls out", moves[1].from > 1 && moves[1].to === 1, JSON.stringify(moves[1]));
  /*
    The point of alternating. Each join is tight-against-tight or
    wide-against-wide: only the subject changes across the cut, which is what
    makes a hard join between two photographs read as an edit rather than as a
    jump. A single repeated push would break this at every join.
  */
  check(
    "so each still ends at the size the next one starts at",
    moves.slice(0, -1).every((m, i) => Math.abs(m.to - moves[i + 1].from) < 1e-9),
    JSON.stringify(moves),
  );
  const still = stills.motionFor(0, 0);
  check("asking for no movement gives none", still.from === 1 && still.to === 1);
}

section("Filling the frame, or sitting inside it");
{
  const vertical = { width: 1080, height: 1920 };
  check("a photo already the shape of the frame fills it", stills.fitFor({ width: 1080, height: 1920 }, vertical) === "cover");
  check("and so does a portrait one close enough to it", stills.fitFor({ width: 1200, height: 1600 }, vertical) === "cover");
  /*
    The case arithmetic alone gets wrong. A four-thousand-pixel square needs no
    enlargement to cover a 9:16 frame — it needs the outer 44% of its width
    removed, and a product photograph is a product framed to fill the picture,
    not a landscape with room at the edges.
  */
  check("a big square photo is not cropped in half to fill a phone screen", stills.fitFor({ width: 4000, height: 4000 }, vertical) === "pad", "");
  check("nor is a landscape one", stills.fitFor({ width: 1600, height: 900 }, vertical) === "pad");
  check("and a thumbnail is not blown up past sharpness", stills.fitFor({ width: 400, height: 400 }, vertical) === "pad");
  check("a square photo does fill a square frame", stills.fitFor({ width: 1200, height: 1200 }, { width: 1080, height: 1080 }) === "cover");
  check("and an unmeasurable one sits inside, which is the safe answer", stills.fitFor({ width: 0, height: 0 }, vertical) === "pad");
}

// ── The file ────────────────────────────────────────────────────────────────

section("The reel is exactly as long as the arithmetic says");
{
  const dir = await scratch();
  const frame = { width: 540, height: 960 };
  const source = [
    makeStill(dir, "tall", 900, 1600),
    makeStill(dir, "square", 1200, 1200),
    makeStill(dir, "wide", 1600, 900),
  ];
  const reel = await stills.buildStillsReel(source, { ...frame, fps: 30, targetSeconds: 9, motion: 0.12, workDir: dir });

  const seconds = Number(ffprobe(reel.file, "format=duration")[0]);
  const timing = stills.reelTiming(3, 9);
  /*
    To the millisecond, and this is the check that caught the bug worth having
    a suite for. A looped image decodes at ffmpeg's default 25fps whatever the
    output rate says, so every segment came out 16% short — the reel was
    shorter than the number that timed it, priced it and billed it, and nothing
    anywhere failed.
  */
  check("the finished file is the length the timing promised", Math.abs(seconds - timing.seconds) < 0.005, `${seconds}s against ${timing.seconds}s`);
  check("and the report agrees with the file", Math.abs(reel.seconds - seconds) < 0.005, `${reel.seconds}`);
  check("every photo was used", reel.used === 3 && reel.dropped === 0, JSON.stringify(reel));

  const [width, height] = ffprobe(reel.file, "stream=width,height").map(Number);
  check("at the frame it was asked for", width === frame.width && height === frame.height, `${width}x${height}`);
  check("at thirty frames a second", ffprobe(reel.file, "stream=r_frame_rate")[0] === "30/1", ffprobe(reel.file, "stream=r_frame_rate")[0]);
  /*
    No audio stream at all, which is correct and load-bearing: a reel has
    nobody talking in it. The renderer's own audio decisions already handle that —
    a bed becomes the whole soundtrack, the sound layer builds its own silent
    base — and they only work if this file is honestly silent rather than
    carrying an empty track.
  */
  check("and silent, because there is nobody in it", !ffprobe(reel.file, "stream=codec_type").includes("audio"), ffprobe(reel.file, "stream=codec_type").join(","));

  await rm(dir, { recursive: true, force: true });
}

section("And the photographs actually move");
{
  const dir = await scratch();
  const source = [makeStill(dir, "one", 900, 1600), makeStill(dir, "two", 900, 1600)];
  const frame = { width: 540, height: 960, fps: 30, workDir: dir };

  const moving = await stills.buildStillsReel(source, { ...frame, targetSeconds: 6, motion: 0.12 });
  const early = frameAt(moving.file, 0.1, dir, "m-early");
  const late = frameAt(moving.file, 2.8, dir, "m-late");
  check("the picture is a photograph and not black", statOf(early).avg > 20, String(statOf(early).avg));
  /*
    The whole point. A zoom expression that parses and does nothing produces a
    file where these two frames are identical, every other check in this suite
    passes, and the product ships a slideshow.
  */
  check("the end of a hold is not the same picture as its start", difference(early, late) > 1, String(difference(early, late)));

  const stillReel = await stills.buildStillsReel(source, { ...frame, targetSeconds: 6, motion: 0, workDir: await scratch() });
  const flatEarly = frameAt(stillReel.file, 0.1, dir, "s-early");
  const flatLate = frameAt(stillReel.file, 2.8, dir, "s-late");
  // And the other direction, which is what makes the check above mean
  // something: asking for no movement has to really produce none.
  check("and asking for none really gives none", difference(flatEarly, flatLate) < 0.4, String(difference(flatEarly, flatLate)));

  await rm(dir, { recursive: true, force: true });
}

section("A photo that cannot fill the frame sits on a blurred copy, not on bars");
{
  const dir = await scratch();
  // 16:9 into 9:16 is the worst case and the commonest one: a supplier's
  // landscape product shot on a phone screen.
  const source = [makeStill(dir, "wide", 1600, 900)];
  const reel = await stills.buildStillsReel(source, { width: 540, height: 960, fps: 30, targetSeconds: 4, motion: 0.1, workDir: dir });
  check("it was padded rather than cropped", reel.padded === 1, JSON.stringify(reel));

  const frame = frameAt(reel.file, 1.5, dir, "pad");
  // The top eighth of the frame, which in a bars layout is flat black.
  const top = statOf(frame, "crop=iw:ih/8:0:0");
  check("the top of the frame is not black bars", top.avg > 18, `YAVG ${top.avg}`);
  /*
    And not a flat colour either. A solid backdrop would pass the brightness
    check above while looking exactly like the automatically generated ad this
    is meant not to be; a blurred copy of the photograph has a range in it.
  */
  check("nor a flat colour: it is the photograph, blurred", top.max - top.min > 12, `${top.min}..${top.max}`);

  await rm(dir, { recursive: true, force: true });
}

section("Too many photographs is an honest count, not a silent truncation");
{
  const dir = await scratch();
  const source = Array.from({ length: 8 }, (_, i) => makeStill(dir, `p${i}`, 900, 1600));
  const reel = await stills.buildStillsReel(source, { width: 540, height: 960, fps: 30, targetSeconds: 6, motion: 0.1, workDir: dir });
  check("only what fits is used", reel.used === 5 && reel.dropped === 3, JSON.stringify(reel));
  const seconds = Number(ffprobe(reel.file, "format=duration")[0]);
  check("and the file is the shorter length, not the asked-for one", Math.abs(seconds - reel.seconds) < 0.005, `${seconds}`);
  await rm(dir, { recursive: true, force: true });
}

section("And it works at the size the product actually ships");
{
  const dir = await scratch();
  const source = [makeStill(dir, "full", 1200, 1600)];
  const reel = await stills.buildStillsReel(source, { width: 1080, height: 1920, fps: 30, targetSeconds: 3, motion: 0.12, workDir: dir });
  const [width, height] = ffprobe(reel.file, "stream=width,height").map(Number);
  check("a full-size reel comes out 1080x1920", width === 1080 && height === 1920, `${width}x${height}`);
  check("and is not black", statOf(frameAt(reel.file, 1, dir, "full")).avg > 20);
  await rm(dir, { recursive: true, force: true });
}

// ── Reaching it ─────────────────────────────────────────────────────────────

section("A sentence can ask for it, and a sentence can refuse it");
{
  const library = [
    { id: "img1", kind: "image", label: "front.jpg" },
    { id: "img2", kind: "image", label: "back.jpg" },
  ];
  const opsFor = (text, assets = library) => keywords.planFromText(text, { assets }).operations;
  const has = (text, assets = library) => opsFor(text, assets).some((o) => o.type === "stillsReel");

  for (const text of [
    "make a video from my product photos",
    "turn these images into a reel",
    "build an ad out of my photos",
    "اعمل فيديو من الصور",
    "سوي فيديو من صور المنتج",
  ]) {
    check(`"${text}" asks for a reel`, has(text), JSON.stringify(opsFor(text).map((o) => o.type)));
  }

  for (const text of [
    "cut the silences and add captions",
    "make it vertical for tiktok",
    "add captions but without my photos",
    "بدون صور",
  ]) {
    check(`"${text}" does not`, !has(text), JSON.stringify(opsFor(text).map((o) => o.type)));
  }

  const reel = opsFor("make a video from my product photos").find((o) => o.type === "stillsReel");
  check("it names the project's own photographs, in their order", JSON.stringify(reel.assetIds) === JSON.stringify(["img1", "img2"]), JSON.stringify(reel));

  /*
    With no photographs the answer names the fix rather than the limitation.
    Somebody told "I cannot" leaves; told "add the images and I will build it",
    they add the images. The same shape as music, b-roll and overlays.
  */
  const empty = keywords.planFromText("make a video from my product photos", { assets: [] });
  check("an empty library gets a refusal, not silence", empty.cannotYet.length > 0, JSON.stringify(empty.cannotYet));
  check("and the refusal says what to do about it", /add the product images|أضف صور المنتج/.test(empty.cannotYet.map((p) => `${p.en} ${p.ar}`).join(" ")), JSON.stringify(empty.cannotYet));
  check("and no reel is planned from photographs that do not exist", !empty.operations.some((o) => o.type === "stillsReel"));
}

section("The model has it too, and only when there is something to build from");
{
  const source = spawnSync("cat", [path.join(repoRoot, "artifacts/api-server/src/lib/planner.ts")], { encoding: "utf8" }).stdout;
  const types = source.slice(source.indexOf("const types = ["), source.indexOf("];", source.indexOf("const types = [")));
  check("it is in the model's vocabulary", types.includes('"stillsReel"'), "");
  /*
    Conditional, like b-roll and overlays and music: a reel is made *of*
    photographs, so on a project with none the operation does not exist rather
    than existing and failing. `inventory.mjs` reads this same shape to know
    the two planners are allowed to differ here.
  */
  check("and only when the project has images", /length > 0 \? \["stillsReel"\]/.test(types), types);
  check("the instructions tell the model what it is for", source.includes("stillsReel builds the video itself out of their photographs"), "");
  check("and the ids it may name are enumerated", /assetIds:\s*\n?\s*assetIds\.length > 0/.test(source), "");
}

section("The contract holds the line");
{
  const parse = (over) => zod.StillsReelOperation.safeParse({ type: "stillsReel", ...over });
  check("a reel needs at least one photograph", !parse({ assetIds: [] }).success);
  check("and carries the defaults", parse({ assetIds: ["a"] }).data.targetSeconds === 15 && parse({ assetIds: ["a"] }).data.motion === 0.12);
  check("twenty is the ceiling", !parse({ assetIds: Array.from({ length: 21 }, (_, i) => `a${i}`) }).success);
  check("a two-second advertisement is refused", !parse({ assetIds: ["a"], targetSeconds: 2 }).success);
  check("so is motion nobody could watch", !parse({ assetIds: ["a"], motion: 2 }).success);
  check(
    "and the operation is in the union the API validates against",
    zod.EditPlan.safeParse({ version: 1, operations: [{ type: "stillsReel", assetIds: ["a"] }] }).success,
  );
}

await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("A shop with no camera has a video.");
