/**
 * Runs the worker's ffmpeg pipeline against generated clips and checks the
 * output is what the plan asked for.
 *
 * These check the picture and the sound, not ffmpeg's exit code: that the clip
 * is shorter by the silent part specifically, that the loudness really lands on
 * target, that captions really put pixels on the frame, and that a whole plan
 * survives a single encode rather than four. It builds the real module rather
 * than reimplementing any of it.
 *
 * Usage: node tools/render-test.mjs
 * Requires: ffmpeg and ffprobe on PATH.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-render-test-"));
const modulePath = path.join(buildDir, "ffmpeg.mjs");

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

const { renderPlan, probeSource, keepSegmentsFrom, remapTime, zoomExpression, writeSubtitleFile, frameFor, chooseHighlight } =
  await import(pathToFileURL(modulePath).href);

// The reference command below has to crop where the pipeline crops, or it
// measures framing rather than generation loss. Which crop is *correct* is
// quality-test.mjs's question; this file only asks whether one encode was used.
const framingPath = path.join(buildDir, "framing.mjs");
spawnSync(
  require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/worker"] }),
  [
    path.join(repoRoot, "artifacts/worker/src/framing.ts"),
    "--bundle", "--platform=node", "--format=esm", "--target=node22",
    `--outfile=${framingPath}`, "--log-level=error",
  ],
  { stdio: "inherit" },
);
const { measureInterest, chooseCropCenter, cropOffsetX, coverScale } = await import(pathToFileURL(framingPath).href);

const previewModPath = path.join(buildDir, "preview.mjs");
spawnSync(
  require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/worker"] }),
  [
    path.join(repoRoot, "artifacts/worker/src/preview.ts"),
    "--bundle", "--platform=node", "--format=esm", "--target=node22",
    `--outfile=${previewModPath}`, "--log-level=error",
  ],
  { stdio: "inherit" },
);
const { encodePreview, previewPathFor } = await import(pathToFileURL(previewModPath).href);

async function sameCropAs(sourceFile, cropWidth, cropHeight) {
  const info = await probeSource(sourceFile);
  const scaledWidth = Math.round(info.width * coverScale(info, { width: cropWidth, height: cropHeight }));
  if (scaledWidth <= cropWidth + 2) return Math.round((scaledWidth - cropWidth) / 4) * 2;
  return cropOffsetX(chooseCropCenter(await measureInterest(sourceFile), cropWidth / scaledWidth), scaledWidth, cropWidth);
}

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

const scratch = () => mkdtemp(path.join(tmpdir(), "editly-r-"));

function ffprobe(file, entries, extra = []) {
  const r = spawnSync(
    "ffprobe",
    ["-v", "error", ...extra, "-show_entries", entries, "-of", "default=nw=1:nk=1", file],
    { encoding: "utf8" },
  );
  return r.stdout.trim().split("\n");
}

/** Measured integrated loudness of a file, in LUFS. */
function measureLoudness(file) {
  const r = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-i", file, "-af", "loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"],
    { encoding: "utf8" },
  );
  const json = r.stderr.slice(r.stderr.lastIndexOf("{"), r.stderr.lastIndexOf("}") + 1);
  try {
    return Number.parseFloat(JSON.parse(json).input_i);
  } catch {
    return NaN;
  }
}

/** PSNR between two files, in dB. Infinity when they are identical. */
function psnr(a, b) {
  const r = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-i", a, "-i", b, "-filter_complex", "psnr", "-f", "null", "-"],
    { encoding: "utf8" },
  );
  const m = r.stderr.match(/average:([\d.]+|inf)/);
  if (!m) return NaN;
  return m[1] === "inf" ? Infinity : Number.parseFloat(m[1]);
}

// ── Pure maths, no ffmpeg involved ──────────────────────────────────────────
console.log("\nSegment arithmetic");
{
  const kept = keepSegmentsFrom(20, [{ start: 3, end: 7 }, { start: 10, end: 14 }], 0);
  check(
    "silences invert into the gaps between them",
    JSON.stringify(kept) === JSON.stringify([{ start: 0, end: 3 }, { start: 7, end: 10 }, { start: 14, end: 20 }]),
    JSON.stringify(kept),
  );

  const padded = keepSegmentsFrom(20, [{ start: 3, end: 7 }], 0.5);
  check("padding widens what is kept on both sides of a cut", padded[0].end === 3.5 && padded[1].start === 6.5, JSON.stringify(padded));

  const trailing = keepSegmentsFrom(10, [{ start: 8, end: 10 }], 0);
  check("a silence running to the end truncates the clip", trailing.length === 1 && trailing[0].end === 8, JSON.stringify(trailing));

  check("a moment after a cut moves earlier by the cut length", remapTime(8, kept) === 4, String(remapTime(8, kept)));
  check("a moment inside a cut lands on the seam", remapTime(5, kept) === 3, String(remapTime(5, kept)));
  check("a moment before any cut is unmoved", remapTime(2, kept) === 2, String(remapTime(2, kept)));
}

console.log("\nFrame arithmetic");
{
  check("1920 is the frame we have always exported", JSON.stringify(frameFor(1920)) === JSON.stringify({ w: 1080, h: 1920 }));
  check("1280 is 720p vertical", JSON.stringify(frameFor(1280)) === JSON.stringify({ w: 720, h: 1280 }));
  check("2160 keeps 9:16", Math.abs(frameFor(2160).w / frameFor(2160).h - 9 / 16) < 0.005, JSON.stringify(frameFor(2160)));
  // H.264 chroma subsampling needs even dimensions, and an odd one fails the
  // encode with a message about nothing in particular.
  for (const h of [720, 1080, 1280, 1440, 1920, 2160]) {
    const f = frameFor(h);
    check(`${h}p exports even dimensions`, f.w % 2 === 0 && f.h % 2 === 0, JSON.stringify(f));
  }
  check("taller asks give taller frames", frameFor(2160).h > frameFor(1920).h);
}

console.log("\nZoom expressions");
{
  const still = zoomExpression({ base: 1.15, fps: 30, totalFrames: 300 });
  check("with nothing moving the zoom is a constant", still === "1.15", still);

  const push = zoomExpression({ base: 1.15, fps: 30, totalFrames: 300, kenBurns: { to: 1.08 } });
  check("a push ramps with the frame counter", /on\/300/.test(push) && push.startsWith("1.15+"), push);

  const punched = zoomExpression({
    base: 1.15,
    fps: 30,
    totalFrames: 300,
    punches: [{ at: 4, duration: 1.2, amount: 0.12 }],
  });
  // Both ramps clamp to [0,1] and combine with min, so the term is zero outside
  // the punch and never overshoots inside it.
  check("a punch is clamped at both ends", /max\(0,min\(1,/.test(punched) && punched.includes("min(max"), punched);
  check("the punch is scaled by the base zoom", punched.includes((0.12 * 1.15).toFixed(4)), punched);
}

console.log("\nCaption files");
{
  const dir = await scratch();
  const withWords = path.join(dir, "k.ass");
  await writeSubtitleFile(
    withWords,
    [{
      startMs: 0, endMs: 1000, text: "hello there",
      words: [{ startMs: 0, endMs: 400, text: "hello" }, { startMs: 400, endMs: 1000, text: "there" }],
    }],
    "karaoke-box",
    "karaoke",
    { width: 1080, height: 1920 },
  );
  const k = readFileSync(withWords, "utf8");
  check("karaoke emits a wipe per word", (k.match(/\\kf\d+/g) ?? []).length === 2, k.split("\n").pop());
  check("each wipe lasts that word's own duration", /\\kf40[^\d]/.test(k) && /\\kf60[^\d]/.test(k), k.split("\n").pop());

  const withoutWords = path.join(dir, "n.ass");
  await writeSubtitleFile(withoutWords, [{ startMs: 0, endMs: 1000, text: "hello there" }], "karaoke-box", "karaoke", { width: 1080, height: 1920 });
  check("without word timings it does not fake a rhythm", !/\\kf/.test(readFileSync(withoutWords, "utf8")), "");

  const popped = path.join(dir, "p.ass");
  await writeSubtitleFile(popped, [{ startMs: 0, endMs: 900, text: "hi" }], "bold-yellow", "pop", { width: 1080, height: 1920 });
  const pText = readFileSync(popped, "utf8");
  check("pop overshoots then settles", /\\t\(0,120,\\fscx108/.test(pText) && /\\t\(120,200,\\fscx100/.test(pText), pText.split("\n").pop());
  check("the frame size is written into the script", /PlayResY: 1920/.test(pText), "");

  await rm(dir, { recursive: true, force: true });
}

// ── The real pipeline ───────────────────────────────────────────────────────
const workDir = await scratch();
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
    { workDir: await scratch() },
  );
  const info = await probeSource(output);
  check("the clip actually got shorter", info.duration < 19, `${info.duration.toFixed(2)}s`);
  // 9s of sound, plus 80ms of padding either side of each cut.
  check("what is left is the audible part, not an arbitrary trim", info.duration > 9 && info.duration < 11, `${info.duration.toFixed(2)}s`);
  check("the worker reports what it did", notes.some((n) => /removed [\d.]+s of silence/.test(n)), JSON.stringify(notes));
  check("both streams survive", ffprobe(output, "stream=codec_type").sort().join(",") === "audio,video", "");

  // The VP9 mirror. The master is H.264, and H.264 decode is an *operating
  // system* component that we have watched be broken on a real machine — the
  // render finished and its owner could not play a second of it, while
  // canPlayType said "probably". The preview exists so watching the result
  // never depends on the viewer's codec luck; these checks pin the codec pair,
  // because a preview that quietly came out H.264 would be the same trap with
  // an extra file.
  const previewOut = output.replace(/\.mp4$/, "") + ".preview.webm";
  await encodePreview(output, previewOut);
  check("the preview really is VP9", ffprobe(previewOut, "stream=codec_name").includes("vp9"), JSON.stringify(ffprobe(previewOut, "stream=codec_name")));
  check("with Opus for the sound", ffprobe(previewOut, "stream=codec_name").includes("opus"), "");
  check(
    "and it runs as long as the master",
    Math.abs((await probeSource(previewOut)).duration - info.duration) < 0.5,
    `${(await probeSource(previewOut)).duration.toFixed(2)}s vs ${info.duration.toFixed(2)}s`,
  );
  check(
    "the conventional key derives from the master's key alone",
    previewPathFor("u/p/edited-1.mp4") === "u/p/edited-1.preview.webm",
    previewPathFor("u/p/edited-1.mp4"),
  );
}

console.log("\nReframing and encode quality");
{
  const { output } = await renderPlan(
    source,
    { version: 1, operations: [{ type: "formatForPlatform", platform: "tiktok" }] },
    { workDir: await scratch() },
  );
  const [width, height] = ffprobe(output, "stream=width,height");
  check("the frame is 1080x1920", width === "1080" && height === "1920", `${width}x${height}`);
  check("reframing does not change the length", Math.abs((await probeSource(output)).duration - 20) < 0.5, "");

  const [profile] = ffprobe(output, "stream=profile", ["-select_streams", "v:0"]);
  check("encoded at High profile, not the default", profile === "High", profile);

  const head = readFileSync(output).subarray(0, 4096);
  const moov = head.indexOf(Buffer.from("moov"));
  const mdat = head.indexOf(Buffer.from("mdat"));
  check("the moov atom is at the front so it streams", moov !== -1 && (mdat === -1 || moov < mdat), `moov@${moov} mdat@${mdat}`);
}

console.log("\nA cut that would clip a syllable is moved off it");
{
  const plan = {
    version: 1,
    operations: [{ type: "removeSilence", thresholdDb: -32, minSilenceMs: 500, paddingMs: 0 }],
  };

  const blind = await renderPlan(source, plan, { workDir: await scratch() });
  const blindDuration = (await probeSource(blind.output)).duration;

  // The tone stops at 3s, so the detector cuts there. A transcript saying a
  // word runs to 3.5 means cutting at 3 clips it — the most audible way an
  // automatic edit gives itself away, and one nobody reports because it sounds
  // like the speaker stumbled.
  const aware = await renderPlan(source, plan, {
    workDir: await scratch(),
    words: [{ start: 2.5, end: 3.5, filler: false }],
  });
  const awareDuration = (await probeSource(aware.output)).duration;

  check(
    "the render keeps the rest of the word",
    awareDuration > blindDuration + 0.3,
    `${blindDuration.toFixed(2)}s without, ${awareDuration.toFixed(2)}s with`,
  );
  check(
    "by about the half second the word overran",
    Math.abs(awareDuration - blindDuration - 0.5) < 0.25,
    `${(awareDuration - blindDuration).toFixed(2)}s`,
  );
  check("and it says so", aware.notes.some((n) => /middle of a word/.test(n)), JSON.stringify(aware.notes));
  check("silence is still removed", awareDuration < 12, `${awareDuration.toFixed(2)}s`);
  check("without a transcript nothing changes", !blind.notes.some((n) => /middle of a word/.test(n)));
}

console.log("\nResolution, and refusing to sell an upscale as 4K");
{
  // The source is 640x360. The 9:16 window out of it carries 360 real pixels
  // of height, so exporting at 2160 would be four times the file for exactly
  // the same picture — and slower to make, slower to upload, and softer.
  const { output, notes } = await renderPlan(
    source,
    { version: 1, operations: [{ type: "formatForPlatform", platform: "tiktok", maxHeight: 2160 }] },
    { workDir: await scratch() },
  );
  const [width, height] = ffprobe(output, "stream=width,height");
  check("the ask is capped at what the footage can fill", height === "1920", `${width}x${height}`);
  check("and it stays 9:16", width === "1080", `${width}x${height}`);
  check(
    "the cap is explained rather than applied silently",
    notes.some((n) => /2160p/.test(n) && /no more detail/.test(n)),
    JSON.stringify(notes),
  );

  // Asking for less is always honoured: there is no honesty problem in
  // exporting smaller than the source.
  const small = await renderPlan(
    source,
    { version: 1, operations: [{ type: "formatForPlatform", platform: "tiktok", maxHeight: 1280 }] },
    { workDir: await scratch() },
  );
  const [w720, h720] = ffprobe(small.output, "stream=width,height");
  check("a smaller ask is given exactly", w720 === "720" && h720 === "1280", `${w720}x${h720}`);
  check("with nothing to explain", !small.notes.some((n) => /no more detail/.test(n)), JSON.stringify(small.notes));

  const [level] = ffprobe(small.output, "stream=level", ["-select_streams", "v:0"]);
  check("and the ordinary encode settings still apply", level === "42", level);
}

console.log("\nOne encode, not four");
{
  // The whole point of compiling a plan into a single graph. If any operation
  // were still its own pass, this output would carry an extra generation of
  // loss and would not match a hand-written single-pass reference.
  const dir = await scratch();
  const { output } = await renderPlan(
    source,
    {
      version: 1,
      operations: [
        { type: "formatForPlatform", platform: "tiktok" },
        { type: "watermark", text: "Edited with Editly", position: "bottom-right" },
      ],
    },
    { workDir: dir },
  );

  const reference = path.join(dir, "reference.mp4");
  spawnSync("ffmpeg", [
    "-y", "-loglevel", "error", "-i", source,
    "-vf",
    `scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920:${await sameCropAs(source, 1080, 1920)}:(ih-oh)/2,setsar=1,` +
      "drawtext=text='Edited with Editly':fontcolor=white@0.85:fontsize=h/32:box=1:boxcolor=black@0.35:boxborderw=12:x=w-tw-40:y=h-th-40",
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-profile:v", "high", "-level", "4.2",
    "-pix_fmt", "yuv420p", "-g", "60", "-keyint_min", "30", "-sc_threshold", "0",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
    reference,
  ]);

  const quality = psnr(output, reference);
  check("the pipeline matches a hand-written single-pass command", quality > 45, `PSNR ${quality}`);
}

console.log("\nMotion");
{
  const dir = await scratch();
  const { output, notes } = await renderPlan(
    source,
    { version: 1, operations: [{ type: "formatForPlatform", platform: "tiktok" }, { type: "kenBurns", to: 1.1 }] },
    { workDir: dir },
  );
  check("a push still lands on the target frame size", ffprobe(output, "stream=width,height").join("x") === "1080x1920", "");
  check("and does not change the length", Math.abs((await probeSource(output)).duration - 20) < 0.8, "");
  check("the note says what it did", notes.some((n) => /slow push to 110%/.test(n)), JSON.stringify(notes));

  // The frame really moves: compare against the same reframe with no motion.
  const still = path.join(dir, "still.mp4");
  spawnSync("ffmpeg", [
    "-y", "-loglevel", "error", "-i", source,
    "-vf", "scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920",
    "-c:v", "libx264", "-crf", "18", "-an", still,
  ]);
  const moved = psnr(output, still);
  check("the picture genuinely moves relative to a static reframe", Number.isFinite(moved) && moved < 40, `PSNR ${moved}`);
}

{
  const { output, notes } = await renderPlan(
    source,
    {
      version: 1,
      operations: [
        { type: "formatForPlatform", platform: "reels" },
        { type: "zoomPunch", at: [5, 12], amount: 0.15, holdMs: 1000 },
      ],
    },
    { workDir: await scratch() },
  );
  check("punches render", notes.some((n) => /2 punch-ins/.test(n)), JSON.stringify(notes));
  check("with the frame size intact", ffprobe(output, "stream=width,height").join("x") === "1080x1920", "");
}

console.log("\nAudio levelling");
{
  const dir = await scratch();
  const quiet = path.join(dir, "quiet.mp4");
  spawnSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=8",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=8",
    "-filter_complex", "[1:a]volume=0.05[a]",
    "-map", "0:v", "-map", "[a]",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", quiet,
  ]);

  const before = measureLoudness(quiet);
  check("the test clip really is too quiet to start with", before < -25, `${before} LUFS`);

  const { output, notes } = await renderPlan(
    quiet,
    { version: 1, operations: [{ type: "normalizeLoudness", targetLufs: -14 }] },
    { workDir: dir },
  );
  const after = measureLoudness(output);
  check("levelling lands within 2 LU of the target", Math.abs(after + 14) < 2, `${after} LUFS`);
  check("and says so", notes.some((n) => /-14 LUFS/.test(n)), JSON.stringify(notes));
}

console.log("\nCaptions on the frame");
{
  const base = { type: "formatForPlatform", platform: "tiktok" };
  const plain = await renderPlan(source, { version: 1, operations: [base] }, { workDir: await scratch() });
  const captioned = await renderPlan(
    source,
    {
      version: 1,
      operations: [
        base,
        {
          type: "burnCaptions",
          style: "bold-yellow",
          animation: "karaoke",
          cues: [{
            startMs: 0, endMs: 4000, text: "this really is on the frame",
            words: [
              { startMs: 0, endMs: 800, text: "this" },
              { startMs: 800, endMs: 1600, text: "really" },
              { startMs: 1600, endMs: 2400, text: "is" },
              { startMs: 2400, endMs: 4000, text: "on the frame" },
            ],
          }],
        },
      ],
    },
    { workDir: await scratch() },
  );

  const difference = psnr(plain.output, captioned.output);
  check("burning captions changes the picture", Number.isFinite(difference) && difference < 45, `PSNR ${difference}`);
  check("and reports the animation used", captioned.notes.some((n) => /captions \(karaoke\)/.test(n)), JSON.stringify(captioned.notes));
}

console.log("\nEverything at once");
{
  const { output, notes } = await renderPlan(
    source,
    {
      version: 1,
      operations: [
        // Deliberately out of order: the pipeline fixes the order itself,
        // because only one order is correct.
        { type: "watermark", text: "Edited with Editly", position: "bottom-right" },
        { type: "burnCaptions", style: "bold-white", animation: "pop", cues: [{ startMs: 500, endMs: 2500, text: "hook line" }] },
        { type: "zoomPunch", at: [3], amount: 0.12, holdMs: 900 },
        { type: "formatForPlatform", platform: "tiktok" },
        { type: "removeSilence", thresholdDb: -32, minSilenceMs: 500, paddingMs: 80 },
        { type: "normalizeLoudness", targetLufs: -14 },
      ],
    },
    { workDir: await scratch() },
  );
  const info = await probeSource(output);
  check("a full plan renders", info.width === 1080 && info.height === 1920, `${info.width}x${info.height}`);
  check("with the silence still removed", info.duration > 9 && info.duration < 11, `${info.duration.toFixed(2)}s`);
  check("and every operation reported", notes.length >= 5, JSON.stringify(notes));
  check("audio levelled even inside a full plan", Math.abs(measureLoudness(output) + 14) < 3, `${measureLoudness(output)} LUFS`);
}

console.log("\nDegenerate input");
{
  const dir = await scratch();
  const silent = path.join(dir, "silent.mp4");
  spawnSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=4",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", silent,
  ]);
  const { output, notes } = await renderPlan(
    silent,
    {
      version: 1,
      operations: [
        { type: "removeSilence", thresholdDb: -32, minSilenceMs: 500, paddingMs: 80 },
        { type: "normalizeLoudness", targetLufs: -14 },
      ],
    },
    { workDir: dir },
  );
  check("a clip with no audio is left alone, not destroyed", notes.some((n) => /no audio track/.test(n)), JSON.stringify(notes));
  check("it still produces a playable file", (await probeSource(output)).duration > 3, "");
}

console.log("\nWhen ffmpeg refuses, it says why");
{
  // What the customer used to read on every failed render was `ffmpeg exited 1`
  // — a binary name and a number. The message was built as
  // `${bin} exited ${code}\n<the last ten lines of stderr>`, and everything
  // downstream that needs one sentence takes the first line. So the complaint
  // was carried all the way to the job row and then thrown away one character
  // before anybody could read it, and the comment above it said ffmpeg's
  // complaints were "specific enough to be worth showing".
  const dir = await scratch();
  const missing = path.join(dir, "does-not-exist.mp4");

  let thrown = null;
  try {
    await probeSource(missing);
  } catch (error) {
    thrown = error;
  }

  check("a file ffmpeg cannot read is an error, not a silent zero", thrown !== null, "it resolved");

  const firstLine = String(thrown?.message ?? "").split("\n")[0];
  check(
    "the first line is ffmpeg's own complaint, because that is the line anything downstream takes",
    /No such file|Invalid data|does-not-exist/i.test(firstLine),
    firstLine,
  );
  check(
    "not the exit code, which is what it used to be",
    !/^ffprobe exited/.test(firstLine) && !/^ffmpeg exited/.test(firstLine),
    firstLine,
  );
  check(
    "the exit code is still there, one line down, for whoever wants it",
    /exited \d+/.test(String(thrown?.message ?? "")),
    String(thrown?.message ?? "").slice(0, 200),
  );
  check(
    "and it is one sentence rather than a wall — this reaches a person",
    firstLine.length < 300,
    String(firstLine.length),
  );
}

console.log("\nThe highlight is chosen from the words, cut for real, and honest about how");
{
  // ── The choice, as pure arithmetic ────────────────────────────────────────
  const whole = chooseHighlight(20, 30, undefined);
  check("a clip shorter than the ask is kept whole", whole.how === "whole" && whole.window.end === 20, JSON.stringify(whole));

  const centered = chooseHighlight(20, 8, undefined);
  check(
    "no words means the middle, said as a fallback rather than a judgement",
    centered.how === "centered" && Math.abs(centered.window.start - 6) < 0.01 && Math.abs(centered.window.end - 14) < 0.01,
    JSON.stringify(centered),
  );

  // Dense clean speech late in the clip, hesitant fragments early: the window
  // must find the dense run, and the same words must always pick the same
  // window — a re-render that moves the highlight is a product nobody trusts.
  const words = [
    { start: 1.0, end: 1.3, filler: true },
    { start: 2.0, end: 2.2, filler: false },
    ...Array.from({ length: 12 }, (_, i) => ({ start: 13 + i * 0.45, end: 13 + i * 0.45 + 0.4, filler: false })),
  ];
  const spoken = chooseHighlight(20, 6, words);
  check(
    "with words, the densest stretch of speech wins",
    spoken.how === "speech" && spoken.window.start >= 12 && spoken.window.end <= 20,
    JSON.stringify(spoken),
  );
  check(
    "and the choice is deterministic",
    JSON.stringify(chooseHighlight(20, 6, words)) === JSON.stringify(spoken),
  );

  // ── The cut, through the real renderer ────────────────────────────────────
  const blind = await renderPlan(
    source,
    { version: 1, operations: [{ type: "extractHighlight", targetSeconds: 6 }] },
    { workDir: await scratch() },
  );
  const blindSeconds = Number(ffprobe(blind.output, "format=duration")[0]);
  check("the wordless highlight is the asked length", Math.abs(blindSeconds - 6) < 0.6, String(blindSeconds));
  check(
    "and its note admits the middle was a fallback",
    blind.notes.some((n) => /middle 6s/.test(n)),
    JSON.stringify(blind.notes),
  );

  const heard = await renderPlan(
    source,
    { version: 1, operations: [{ type: "extractHighlight", targetSeconds: 6 }] },
    { workDir: await scratch(), words },
  );
  const heardSeconds = Number(ffprobe(heard.output, "format=duration")[0]);
  check(
    "a heard highlight lands on the speech and says where",
    heard.notes.some((n) => /strongest 6s — 1[23]/.test(n)),
    JSON.stringify(heard.notes),
  );
  check("at roughly the asked length, allowing the word-boundary widening", heardSeconds > 5.4 && heardSeconds < 8, String(heardSeconds));

  // ── Composed with silence removal: the silences are cut inside the window ──
  const both = await renderPlan(
    source,
    {
      version: 1,
      operations: [
        { type: "extractHighlight", targetSeconds: 8 },
        { type: "removeSilence", thresholdDb: -32, minSilenceMs: 500, paddingMs: 80 },
      ],
    },
    { workDir: await scratch() },
  );
  const bothSeconds = Number(ffprobe(both.output, "format=duration")[0]);
  check(
    "the centered 8s window keeps only its audible stretch",
    bothSeconds > 2.5 && bothSeconds < 4.5,
    String(bothSeconds),
  );
  check(
    "and both decisions are in the notes, because both were made",
    both.notes.some((n) => /middle 8s/.test(n)) && both.notes.some((n) => /silence/.test(n)),
    JSON.stringify(both.notes),
  );
}

await rm(workDir, { recursive: true, force: true });
await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("The render pipeline does what the plan says.");
