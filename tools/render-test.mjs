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

const { renderPlan, probeSource, keepSegmentsFrom, remapTime, outputDuration, zoomExpression, writeSubtitleFile, wrapToLayout, frameFor, shapeFor, defaultHeightFor, chooseHighlight, chooseClips } =
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

const reviewModPath = path.join(buildDir, "review.mjs");
spawnSync(
  require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/worker"] }),
  [
    path.join(repoRoot, "artifacts/worker/src/review.ts"),
    "--bundle", "--platform=node", "--format=esm", "--target=node22",
    `--outfile=${reviewModPath}`, "--log-level=error",
  ],
  { stdio: "inherit" },
);
const { reviewOutput } = await import(pathToFileURL(reviewModPath).href);

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

/** Mean volume of one stretch of a file's audio, in dB. */
function segmentMeanVolume(file, from, to) {
  const r = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-i", file, "-af", `atrim=start=${from}:end=${to},volumedetect`, "-f", "null", "-"],
    { encoding: "utf8" },
  );
  const m = r.stderr.match(/mean_volume: ([-\d.]+) dB/);
  return m ? Number(m[1]) : NaN;
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

  // The same silence, *with* padding, and this is where it went wrong. The
  // trailing pad exists to give the speech after a silence room to start; when
  // the silence runs to the end of the file there is no speech after it, and
  // padding anyway welded a tenth of a second of pure silence to the end of the
  // edit. Nearly every real video ends this way, because people stop talking
  // before they stop recording.
  const paddedTail = keepSegmentsFrom(10, [{ start: 8, end: 10 }], 0.12);
  check(
    "and padding it does not leave a sliver of silence behind",
    paddedTail.length === 1 && Math.abs(paddedTail[0].end - 8.12) < 1e-6,
    JSON.stringify(paddedTail),
  );
  const paddedHead = keepSegmentsFrom(10, [{ start: 0, end: 2 }], 0.12);
  check(
    "nor at the front, where there is no speech before the silence either",
    paddedHead.length === 1 && Math.abs(paddedHead[0].start - 1.88) < 1e-6,
    JSON.stringify(paddedHead),
  );
  // Why it mattered more than a tenth of a second sounds like it should. The
  // transition's headroom is measured against the *shortest* piece, so one
  // sliver at the end told every such edit that its pieces were too short to
  // put a transition between — and the dissolve was refused on nearly every
  // real video, silently, with a note that was true about the sliver and
  // misleading about the edit.
  const withTail = keepSegmentsFrom(20, [{ start: 6, end: 8 }, { start: 18, end: 20 }], 0.12);
  check(
    "so the shortest piece is real content rather than an artefact of padding",
    Math.min(...withTail.map((s) => s.end - s.start)) > 1,
    JSON.stringify(withTail),
  );
  // A silence in the middle still gets both pads, because both sides have
  // speech to protect. This is the half that must not change.
  const middle = keepSegmentsFrom(20, [{ start: 8, end: 12 }], 0.5);
  check(
    "while a silence between two stretches of speech is still padded on both sides",
    middle.length === 2 && Math.abs(middle[0].end - 8.5) < 1e-6 && Math.abs(middle[1].start - 11.5) < 1e-6,
    JSON.stringify(middle),
  );

  check("a moment after a cut moves earlier by the cut length", remapTime(8, kept) === 4, String(remapTime(8, kept)));
  check("a moment inside a cut lands on the seam", remapTime(5, kept) === 3, String(remapTime(5, kept)));
  check("a moment before any cut is unmoved", remapTime(2, kept) === 2, String(remapTime(2, kept)));

  // The cold open reorders rather than removes, so the map is no longer
  // walked in source order. Every moment still appears exactly once, and the
  // arithmetic has to keep up with that.
  const reordered = [{ start: 12, end: 16 }, { start: 0, end: 12 }, { start: 16, end: 20 }];
  check("a moment inside the hook lands at the very start", remapTime(13, reordered) === 1, String(remapTime(13, reordered)));
  check("a moment before the hook lands after it", remapTime(3, reordered) === 7, String(remapTime(3, reordered)));
  check("a moment after the hook lands after everything else", remapTime(17, reordered) === 17, String(remapTime(17, reordered)));
  // A cut-away moment lands where the nearest *following* source material
  // plays — which, once the list is reordered, may be the very beginning.
  // Sorted lists are unaffected: the check two lines up still reads 3.
  check(
    "a cut-away moment lands where the material after it now plays",
    remapTime(5, [{ start: 8, end: 12 }, { start: 0, end: 4 }]) === 0,
    String(remapTime(5, [{ start: 8, end: 12 }, { start: 0, end: 4 }])),
  );

  // A dissolve overlaps every join, so the edited clock runs short by one
  // overlap per join made so far. This is the arithmetic every caption, punch,
  // overlay and title is placed by — if it drifts, they all drift together and
  // nobody can tell which feature broke.
  const three = [{ start: 0, end: 4 }, { start: 6, end: 10 }, { start: 12, end: 16 }];
  check("with no overlap the old answers are unchanged", remapTime(7, three, 0) === 5, String(remapTime(7, three, 0)));
  check(
    "a moment after one join moves earlier by one overlap",
    Math.abs(remapTime(7, three, 0.5) - 4.5) < 1e-9,
    String(remapTime(7, three, 0.5)),
  );
  check(
    "a moment after two joins moves earlier by two",
    Math.abs(remapTime(13, three, 0.5) - 8) < 1e-9,
    String(remapTime(13, three, 0.5)),
  );
  check(
    "and nothing is ever mapped past the end of the shortened file",
    remapTime(16, three, 0.5) <= outputDuration(three, 0.5) + 1e-9,
    `${remapTime(16, three, 0.5)} vs ${outputDuration(three, 0.5)}`,
  );
  check("the output loses one overlap per join, not per segment", outputDuration(three, 0.5) === 11, String(outputDuration(three, 0.5)));
  check("a single segment has no join to lose", outputDuration([{ start: 0, end: 4 }], 0.5) === 4, String(outputDuration([{ start: 0, end: 4 }], 0.5)));
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

  // Three shapes now, because the pricing page sells "Long-form: YouTube" and
  // a renderer that only makes 9:16 could not keep that promise.
  check("square is square", JSON.stringify(frameFor(1080, "square")) === JSON.stringify({ w: 1080, h: 1080 }), JSON.stringify(frameFor(1080, "square")));
  check(
    "widescreen is 16:9, the long edge across",
    JSON.stringify(frameFor(1080, "widescreen")) === JSON.stringify({ w: 1920, h: 1080 }),
    JSON.stringify(frameFor(1080, "widescreen")),
  );
  for (const shape of ["vertical", "square", "widescreen"]) {
    const f = frameFor(1080, shape);
    check(`${shape} exports even dimensions`, f.w % 2 === 0 && f.h % 2 === 0, JSON.stringify(f));
  }
  check("the three vertical feeds are vertical", ["tiktok", "reels", "shorts"].every((p) => shapeFor(p) === "vertical"));
  check("youtube is widescreen", shapeFor("youtube") === "widescreen");
  check("square is its own shape", shapeFor("square") === "square");
  check("an unknown or absent platform stays vertical, as it always was", shapeFor(null) === "vertical" && shapeFor("mystery") === "vertical");
  // 1920 tall is right for a vertical frame and absurd for a widescreen one
  // (it would be 3413 across), so the default follows the shape.
  check("the default height follows the shape", defaultHeightFor("vertical") === 1920 && defaultHeightFor("widescreen") === 1080 && defaultHeightFor("square") === 1080);
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

  /**
   * And it draws on the lines the layout chose.
   *
   * `wrapToLayout` decides where a cue breaks, for a box that clears the
   * platform's furniture, and marks a cue too long for that box by ending it in
   * an ellipsis. This branch ignored both: it read the cue's *words* and never
   * looked at its text, so a caption that "pop" drew as three lines inside the
   * safe band, karaoke drew as one unbroken run — which libass rewraps by its
   * own margins into as many lines as it likes, climbing over the speaker's
   * face and out of the band the layout exists to protect.
   *
   * Nothing failed. The captions were legible, timed to the voice and correctly
   * coloured, in the wrong half of the frame — and one of the three animations
   * was simply not subject to the module that places captions.
   */
  const longWords = "this is a very long sentence that will certainly not fit on one line"
    .split(" ")
    .map((text, i) => ({ text, startMs: i * 300, endMs: i * 300 + 280 }));
  const longCue = {
    startMs: 0,
    endMs: longWords.length * 300,
    text: longWords.map((w) => w.text).join(" "),
    words: longWords,
  };
  const wrapped = wrapToLayout([longCue], { maxCharsPerLine: 19, maxLines: 3 });
  const linesOf = (file) => {
    const dialogue = readFileSync(file, "utf8").split("\n").filter((l) => l.startsWith("Dialogue"));
    return (dialogue[0].match(/\\N/g) ?? []).length + 1;
  };

  const longKaraoke = path.join(dir, "long-k.ass");
  const longPop = path.join(dir, "long-p.ass");
  await writeSubtitleFile(longKaraoke, wrapped, "karaoke-box", "karaoke", { width: 1080, height: 1920 });
  await writeSubtitleFile(longPop, wrapped, "bold-white", "pop", { width: 1080, height: 1920 });

  check(
    "a karaoke cue breaks where the layout broke it",
    linesOf(longKaraoke) === linesOf(longPop),
    `karaoke drew ${linesOf(longKaraoke)} line(s), pop drew ${linesOf(longPop)} — one unbroken run is libass choosing the wrapping instead of the layout`,
  );
  check(
    "and is truncated where the layout truncated it",
    readFileSync(longKaraoke, "utf8").includes("…"),
    "a cue too long for the band must end in an ellipsis in every animation, not only in two of them",
  );
  check(
    "every word still carries its own wipe",
    (readFileSync(longKaraoke, "utf8").match(/\\kf\d+/g) ?? []).length === wrapped[0].text.split(/\s+/).filter(Boolean).length,
    readFileSync(longKaraoke, "utf8").split("\n").pop(),
  );

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

  /**
   * And says so when it could not wipe.
   *
   * A wipe is per word, so a cue with no word timings can only fade — which is
   * the right thing to draw and was the wrong thing to say. The note claimed
   * "(karaoke)" either way, so somebody who asked for the wipe, did not get it,
   * and was told they did had nowhere to look. Which provider answered decides
   * this, and the person can act on that; a note that lies about it, they
   * cannot.
   */
  const unwipeable = await renderPlan(
    source,
    {
      version: 1,
      operations: [
        base,
        {
          type: "burnCaptions",
          style: "bold-yellow",
          animation: "karaoke",
          cues: [{ startMs: 0, endMs: 4000, text: "no word times came back with this" }],
        },
      ],
    },
    { workDir: await scratch() },
  );
  check(
    "a karaoke ask with no word timings says it faded instead",
    unwipeable.notes.some((n) => /fade in rather than wiping|بتلاشٍ بدل المسح/.test(n)),
    JSON.stringify(unwipeable.notes),
  );
  check(
    "and does not claim the wipe it could not draw",
    !unwipeable.notes.some((n) => /captions \(karaoke\)/.test(n)),
    JSON.stringify(unwipeable.notes),
  );
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

// The mirror image of the highlight: the person names the moments. These
// paths are the substrate multi-clip renders will ride, so they are measured
// on real cuts, not on arithmetic alone.
console.log("\nClips are chosen apart, in source order, honestly counted");
{
  // Two dense stretches of speech far apart, one weak one between them.
  const words = [];
  for (let t = 2; t < 6; t += 0.4) words.push({ start: t, end: t + 0.35, filler: false });
  for (let t = 14; t < 18; t += 0.4) words.push({ start: t, end: t + 0.35, filler: false });
  words.push({ start: 9, end: 9.3, filler: false });

  const spoken = chooseClips(20, 2, 5, words);
  check("with words, the two densest stretches win", spoken.how === "speech" && spoken.windows.length === 2, JSON.stringify(spoken));
  check(
    "one on each stretch, never overlapping",
    spoken.windows[0].end <= spoken.windows[1].start &&
      spoken.windows[0].start < 6 && spoken.windows[1].end > 13,
    JSON.stringify(spoken.windows),
  );
  check(
    "returned in source order, whatever their scores",
    spoken.windows[0].start < spoken.windows[1].start,
    JSON.stringify(spoken.windows),
  );
  check(
    "and the choice is deterministic",
    JSON.stringify(chooseClips(20, 2, 5, words)) === JSON.stringify(spoken),
  );

  const divided = chooseClips(30, 3, 6, undefined);
  check("no words divides evenly and says so", divided.how === "divided" && divided.windows.length === 3, JSON.stringify(divided));
  check(
    "divided windows do not overlap either",
    divided.windows.every((w, i) => i === 0 || divided.windows[i - 1].end <= w.start),
    JSON.stringify(divided.windows),
  );

  const short = chooseClips(11, 3, 5, undefined);
  check(
    "a short video yields fewer clips rather than overlapping ones",
    short.windows.length === 2,
    JSON.stringify(short),
  );

  const tiny = chooseClips(4, 3, 30, undefined);
  check("a video shorter than one clip still yields one", tiny.windows.length === 1, JSON.stringify(tiny));
}

console.log("\nThe stretch they name is kept exactly, with honest clamping");
{
  const plain = await renderPlan(
    source,
    { version: 1, operations: [{ type: "extractRange", startSeconds: 5, endSeconds: 12 }] },
    { workDir: await scratch() },
  );
  const plainSeconds = Number(ffprobe(plain.output, "format=duration")[0]);
  check("5s to 12s comes out seven seconds long", plainSeconds > 6.4 && plainSeconds < 7.6, String(plainSeconds));
  check(
    "and the note says which stretch was kept",
    plain.notes.some((n) => /kept 5\.0s to 12\.0s, the stretch you asked for/.test(n)),
    JSON.stringify(plain.notes),
  );

  // Composed with silence removal: the audible part of exactly that stretch.
  // The source is audible only during 0-3, 7-10 and 14-17.
  const tight = await renderPlan(
    source,
    {
      version: 1,
      operations: [
        { type: "extractRange", startSeconds: 5, endSeconds: 12 },
        { type: "removeSilence", thresholdDb: -32, minSilenceMs: 500, paddingMs: 80 },
      ],
    },
    { workDir: await scratch() },
  );
  const tightSeconds = Number(ffprobe(tight.output, "format=duration")[0]);
  check(
    "with the dead air cut, only the audible part of the stretch remains",
    tightSeconds > 2.2 && tightSeconds < 4.5,
    String(tightSeconds),
  );
  check(
    "and both decisions are in the notes",
    tight.notes.some((n) => /stretch you asked for/.test(n)) && tight.notes.some((n) => /silence/.test(n)),
    JSON.stringify(tight.notes),
  );

  // An end past the file is clamped, and the note says where the file ran out.
  const over = await renderPlan(
    source,
    { version: 1, operations: [{ type: "extractRange", startSeconds: 15, endSeconds: 40 }] },
    { workDir: await scratch() },
  );
  const overSeconds = Number(ffprobe(over.output, "format=duration")[0]);
  check("an end past the file becomes the end of the file", overSeconds > 4.4 && overSeconds < 5.6, String(overSeconds));
  check(
    "and the note names where the clip ran out",
    over.notes.some((n) => /runs out at 20\.0s, before the 40s you named/.test(n)),
    JSON.stringify(over.notes),
  );

  // A start past the file cuts nothing, and says so rather than erroring.
  const past = await renderPlan(
    source,
    { version: 1, operations: [{ type: "extractRange", startSeconds: 25, endSeconds: 30 }] },
    { workDir: await scratch() },
  );
  const pastSeconds = Number(ffprobe(past.output, "format=duration")[0]);
  check("a stretch past the end leaves the clip whole", pastSeconds > 19 && pastSeconds < 21, String(pastSeconds));
  check(
    "with the reason in the notes",
    past.notes.some((n) => /starts at 25s, but the clip is only 20\.0s long/.test(n)),
    JSON.stringify(past.notes),
  );

  // Two people holding the scissors: the named range wins over the highlight.
  const both = await renderPlan(
    source,
    {
      version: 1,
      operations: [
        { type: "extractHighlight", targetSeconds: 8 },
        { type: "extractRange", startSeconds: 5, endSeconds: 12 },
      ],
    },
    { workDir: await scratch() },
  );
  const bothSeconds = Number(ffprobe(both.output, "format=duration")[0]);
  check("the named stretch is the one that renders", bothSeconds > 6.4 && bothSeconds < 7.6, String(bothSeconds));
  check(
    "and the conflict is stated, not hidden",
    both.notes.some((n) => /the stretch you named won/.test(n)),
    JSON.stringify(both.notes),
  );
}

console.log("\nThe cold open moves the best moment to the front, and moves nothing else");
{
  // The source is audible during 0-3, 7-10 and 14-17, so the strongest four
  // seconds are somewhere in the middle — not at the start.
  const opened = await renderPlan(
    source,
    { version: 1, operations: [{ type: "coldOpen", seconds: 4 }] },
    { workDir: await scratch() },
  );
  const openedSeconds = Number(ffprobe(opened.output, "format=duration")[0]);
  // The property that makes this expressible at all: nothing is added and
  // nothing is dropped, so the video is exactly as long as it was.
  check(
    "the video is exactly as long as it was — the moment moved, it was not copied",
    openedSeconds > 19 && openedSeconds < 21,
    String(openedSeconds),
  );
  check(
    "and the note says where it opened from",
    opened.notes.some((n) => /opened on the strongest .*then the rest plays from the top|opens on .*from the middle/.test(n)),
    JSON.stringify(opened.notes),
  );

  // Composed with silence removal: the hook is taken out of what survived,
  // and the total is still the cut length rather than the cut length plus a
  // repeated moment.
  const cutOpen = await renderPlan(
    source,
    {
      version: 1,
      operations: [
        { type: "removeSilence", thresholdDb: -32, minSilenceMs: 500, paddingMs: 80 },
        { type: "coldOpen", seconds: 3 },
      ],
    },
    { workDir: await scratch() },
  );
  const cutOpenSeconds = Number(ffprobe(cutOpen.output, "format=duration")[0]);
  const cutOnly = await renderPlan(
    source,
    { version: 1, operations: [{ type: "removeSilence", thresholdDb: -32, minSilenceMs: 500, paddingMs: 80 }] },
    { workDir: await scratch() },
  );
  const cutOnlySeconds = Number(ffprobe(cutOnly.output, "format=duration")[0]);
  check(
    "with the silences cut, the hook still adds no length",
    Math.abs(cutOpenSeconds - cutOnlySeconds) < 0.6,
    `${cutOpenSeconds} vs ${cutOnlySeconds}`,
  );

  // A clip too short to open on part of itself says so rather than producing
  // a hook that is most of the video.
  const shortDir = await scratch();
  const shortFile = path.join(shortDir, "short.mp4");
  spawnSync("ffmpeg", [
    "-hide_banner", "-y",
    "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=5",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=5",
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", shortFile,
  ]);
  const tiny = await renderPlan(
    shortFile,
    { version: 1, operations: [{ type: "coldOpen", seconds: 4 }] },
    { workDir: await scratch() },
  );
  check(
    "a clip too short to open on part of itself is left in order, and says so",
    tiny.notes.some((n) => /too short to open on part of itself/.test(n)),
    JSON.stringify(tiny.notes),
  );
  const tinySeconds = Number(ffprobe(tiny.output, "format=duration")[0]);
  check("and it is still the whole clip", tinySeconds > 4.5 && tinySeconds < 5.5, String(tinySeconds));
}

console.log("\nThe frame is shaped by the platform, and measured");
{
  // Rendered, not calculated: the source is 640x360 landscape, and each of
  // these asks it for a different shape.
  const square = await renderPlan(
    source,
    { version: 1, operations: [{ type: "formatForPlatform", platform: "square" }] },
    { workDir: await scratch() },
  );
  const [sw, sh] = ffprobe(square.output, "stream=width,height", ["-select_streams", "v:0"]).map(Number);
  check("a square ask really comes out square", sw === sh && sw > 0, `${sw}x${sh}`);
  check(
    "and the note names the frame it made",
    square.notes.some((n) => new RegExp(`reframed to ${sw}x${sh} for square`).test(n)),
    JSON.stringify(square.notes),
  );

  const wide = await renderPlan(
    source,
    { version: 1, operations: [{ type: "formatForPlatform", platform: "youtube" }] },
    { workDir: await scratch() },
  );
  const [ww, wh] = ffprobe(wide.output, "stream=width,height", ["-select_streams", "v:0"]).map(Number);
  check("a YouTube ask comes out widescreen", Math.abs(ww / wh - 16 / 9) < 0.02, `${ww}x${wh}`);
  // The honest-upscale cap applies per shape: a 640x360 source cannot fill
  // 1920x1080, so it is exported smaller and says so.
  check("and is not upscaled past what the source can carry", wh <= 1080, `${ww}x${wh}`);

  const vertical = await renderPlan(
    source,
    { version: 1, operations: [{ type: "formatForPlatform", platform: "tiktok" }] },
    { workDir: await scratch() },
  );
  const [vw, vh] = ffprobe(vertical.output, "stream=width,height", ["-select_streams", "v:0"]).map(Number);
  check("and the vertical feeds are unchanged by any of this", Math.abs(vw / vh - 9 / 16) < 0.02, `${vw}x${vh}`);
}

console.log("\nThe fade opens from black, closes to black, and touches no clock");
{
  // Measured on the pixels, not on the filter string: the first and last
  // frames must actually be dark and the middle actually bright, and the file
  // must be exactly as long as it would have been without the fade — that
  // no-clock property is the whole reason this transition exists.
  const dir = await scratch();
  const bright = path.join(dir, "bright.mp4");
  spawnSync("ffmpeg", [
    "-hide_banner", "-y",
    "-f", "lavfi", "-i", "color=c=white:size=320x240:rate=25:duration=4",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", bright,
  ]);

  const frameLuma = (file, from, to) => {
    const r = spawnSync(
      "ffprobe",
      [
        "-v", "error", "-f", "lavfi",
        "-i", `movie=${file},trim=start=${from}:end=${to},signalstats`,
        "-show_entries", "frame_tags=lavfi.signalstats.YAVG",
        "-of", "default=nw=1:nk=1",
      ],
      { encoding: "utf8" },
    );
    const vals = r.stdout.trim().split("\n").filter(Boolean).map(Number);
    return vals.length > 0 ? vals[0] : NaN;
  };
  /** The very last decodable frame's luma — window past the end reads as NaN. */
  const lastFrameLuma = (file, duration) => {
    const r = spawnSync(
      "ffprobe",
      [
        "-v", "error", "-f", "lavfi",
        "-i", `movie=${file},trim=start=${Math.max(0, duration - 0.3)},signalstats`,
        "-show_entries", "frame_tags=lavfi.signalstats.YAVG",
        "-of", "default=nw=1:nk=1",
      ],
      { encoding: "utf8" },
    );
    const vals = r.stdout.trim().split("\n").filter(Boolean).map(Number);
    return vals.length > 0 ? vals[vals.length - 1] : NaN;
  };

  const faded = await renderPlan(
    bright,
    { version: 1, operations: [{ type: "fade", durationMs: 500 }] },
    { workDir: await scratch() },
  );
  const fadedSeconds = Number(ffprobe(faded.output, "format=duration")[0]);
  check("the video is exactly as long with the fade as without", fadedSeconds > 3.8 && fadedSeconds < 4.25, String(fadedSeconds));
  const first = frameLuma(faded.output, 0, 0.06);
  const middle = frameLuma(faded.output, 2.0, 2.06);
  const last = lastFrameLuma(faded.output, fadedSeconds);
  check("the first frame is black, not white", first < 30, String(first));
  check("the middle is untouched", middle > 150, String(middle));
  check("and the last frame has sunk back to black", last < 45, String(last));
  check(
    "the note says what happened",
    faded.notes.some((n) => /faded in from black and out to black over 0\.5s/.test(n)),
    JSON.stringify(faded.notes),
  );
  const edgeVol = segmentMeanVolume(faded.output, 0, 0.15);
  const midVol = segmentMeanVolume(faded.output, 1.5, 2.5);
  check("the audio rises out of silence with the picture", edgeVol < midVol - 6, `edge ${edgeVol}, middle ${midVol}`);

  // Composed with the cut: the fade is applied to the edited length, so the
  // fade-out lands at the end of what survived, not at the end of the source.
  const cutAndFaded = await renderPlan(
    source,
    {
      version: 1,
      operations: [
        { type: "removeSilence", thresholdDb: -32, minSilenceMs: 500, paddingMs: 80 },
        { type: "fade", durationMs: 500 },
      ],
    },
    { workDir: await scratch() },
  );
  const cutSeconds = Number(ffprobe(cutAndFaded.output, "format=duration")[0]);
  check("the cut still cuts — the fade added nothing back", cutSeconds > 8 && cutSeconds < 12, String(cutSeconds));
  const cutLast = lastFrameLuma(cutAndFaded.output, cutSeconds);
  check("and the fade-out lands at the edited end", cutLast < 45, String(cutLast));
  check(
    "with both decisions in the notes",
    cutAndFaded.notes.some((n) => /silence/.test(n)) && cutAndFaded.notes.some((n) => /faded/.test(n)),
    JSON.stringify(cutAndFaded.notes),
  );

  // A two-second fade on a four-second clip would be black more than picture.
  const greedy = await renderPlan(
    bright,
    { version: 1, operations: [{ type: "fade", durationMs: 2000 }] },
    { workDir: await scratch() },
  );
  check(
    "a fade longer than a third of the clip is shrunk, and says so",
    greedy.notes.some((n) => /shorter than asked/.test(n)),
    JSON.stringify(greedy.notes),
  );
}

console.log("\nThe dissolve mixes one shot into the next, and the clock knows it");
{
  // Built so the join is visible as a number: white for the first kept
  // stretch, black for the second, a second of silence between them for the
  // cut to find. A hard cut goes white-frame straight to black-frame and no
  // frame is ever grey. A dissolve has to produce one — and the file has to
  // come out exactly one overlap shorter, because that is the property every
  // caption in the edit is then placed against.
  const dir = await scratch();
  const twoShots = path.join(dir, "two-shots.mp4");
  spawnSync("ffmpeg", [
    "-hide_banner", "-y",
    "-f", "lavfi", "-i", "color=c=white:size=320x240:rate=25:duration=4",
    "-f", "lavfi", "-i", "color=c=black:size=320x240:rate=25:duration=3",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
    "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono:d=1",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
    "-filter_complex",
    "[0:v][1:v]concat=n=2:v=1:a=0[v];[2:a][3:a][4:a]concat=n=3:v=0:a=1[a]",
    "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", twoShots,
  ]);

  const lumaAt = (file, at) => {
    const r = spawnSync(
      "ffprobe",
      [
        "-v", "error", "-f", "lavfi",
        "-i", `movie=${file},trim=start=${at}:end=${at + 0.06},signalstats`,
        "-show_entries", "frame_tags=lavfi.signalstats.YAVG",
        "-of", "default=nw=1:nk=1",
      ],
      { encoding: "utf8" },
    );
    const vals = r.stdout.trim().split("\n").filter(Boolean).map(Number);
    return vals.length > 0 ? vals[0] : NaN;
  };

  const cutOps = [{ type: "removeSilence", thresholdDb: -32, minSilenceMs: 500, paddingMs: 0 }];

  const hard = await renderPlan(twoShots, { version: 1, operations: cutOps }, { workDir: await scratch() });
  const hardSeconds = Number(ffprobe(hard.output, "format=duration")[0]);

  const soft = await renderPlan(
    twoShots,
    { version: 1, operations: [...cutOps, { type: "transition", style: "dissolve", durationMs: 400 }] },
    { workDir: await scratch() },
  );
  const softSeconds = Number(ffprobe(soft.output, "format=duration")[0]);

  check(
    "the dissolve says what it did, at the length it did it",
    soft.notes.some((n) => /dissolved between the cuts over 0\.40s/.test(n)),
    JSON.stringify(soft.notes),
  );
  check(
    "the edit comes out one overlap shorter than the hard cut",
    Math.abs(hardSeconds - softSeconds - 0.4) < 0.12,
    `hard ${hardSeconds}, soft ${softSeconds}`,
  );
  check(
    "and the renderer's own estimate agrees with the file it produced",
    Math.abs(soft.estimatedSeconds - softSeconds) < 0.2,
    `estimated ${soft.estimatedSeconds}, measured ${softSeconds}`,
  );

  // The join itself. On the hard cut the splice is at the end of the first
  // kept stretch; on the dissolve it starts one overlap earlier and runs
  // through it.
  const splice = hardSeconds - 3;
  check("the hard cut is white right up to the splice", lumaAt(hard.output, splice - 0.15) > 200, String(lumaAt(hard.output, splice - 0.15)));
  check("and black immediately after it", lumaAt(hard.output, splice + 0.15) < 40, String(lumaAt(hard.output, splice + 0.15)));

  const midway = splice - 0.4 / 2;
  const blended = lumaAt(soft.output, midway);
  check(
    "halfway through the dissolve the frame is neither shot but both",
    blended > 60 && blended < 200,
    String(blended),
  );
  check("before the dissolve begins the first shot is still itself", lumaAt(soft.output, midway - 0.35) > 200, String(lumaAt(soft.output, midway - 0.35)));
  check("after it ends the second shot is too", lumaAt(soft.output, midway + 0.35) < 40, String(lumaAt(soft.output, midway + 0.35)));

  // ── A shape, not a blend ─────────────────────────────────────────────────
  //
  // This is the check that tells a wipe from a dissolve, and it has to measure
  // *geometry* rather than "something changed" — both make the frame differ
  // from either shot, and a test that only asserts that would pass with the
  // dissolve wired to every style. Halfway through a left wipe the frame is
  // split: one side is entirely the outgoing shot and the other entirely the
  // incoming one, with a hard edge between. Halfway through a dissolve both
  // sides are the same grey. So each side is measured on its own.
  const sideLuma = (file, at, side) => {
    const crop = side === "left" ? "iw/3:ih:0:0" : "iw/3:ih:2*iw/3:0";
    const r = spawnSync(
      "ffprobe",
      [
        "-v", "error", "-f", "lavfi",
        "-i", `movie=${file},trim=start=${at}:end=${at + 0.06},crop=${crop},signalstats`,
        "-show_entries", "frame_tags=lavfi.signalstats.YAVG",
        "-of", "default=nw=1:nk=1",
      ],
      { encoding: "utf8" },
    );
    const vals = r.stdout.trim().split("\n").filter(Boolean).map(Number);
    return vals.length > 0 ? vals[0] : NaN;
  };

  const wiped = await renderPlan(
    twoShots,
    { version: 1, operations: [...cutOps, { type: "transition", style: "wipeLeft", durationMs: 400 }] },
    { workDir: await scratch() },
  );
  check(
    "a wipe says it wiped, and which way",
    wiped.notes.some((n) => /wiped left between the cuts over 0\.40s/.test(n)),
    JSON.stringify(wiped.notes),
  );
  const wipedSeconds = Number(ffprobe(wiped.output, "format=duration")[0]);
  check(
    "and costs the same overlap as the dissolve — the shape is free, the join is not",
    Math.abs(wipedSeconds - softSeconds) < 0.12,
    `wipe ${wipedSeconds}, dissolve ${softSeconds}`,
  );

  // The same instant as `midway` above, and computed the same way rather than
  // from this file's own duration: the transition occupies the last overlap of
  // the first kept stretch, so it is measured from the *hard cut* length. The
  // first attempt subtracted the overlap twice and landed before the join had
  // begun — where both sides are legitimately the same shot, which is exactly
  // what a broken wipe would also look like.
  const wipeMid = midway;
  const wipeLeftSide = sideLuma(wiped.output, wipeMid, "left");
  const wipeRightSide = sideLuma(wiped.output, wipeMid, "right");
  check(
    "halfway through a wipe the two sides are different shots, not one average",
    Math.abs(wipeLeftSide - wipeRightSide) > 120,
    `left ${wipeLeftSide}, right ${wipeRightSide}`,
  );
  check(
    "one side is fully the shot arriving and the other fully the shot leaving",
    (wipeLeftSide < 60 && wipeRightSide > 190) || (wipeLeftSide > 190 && wipeRightSide < 60),
    `left ${wipeLeftSide}, right ${wipeRightSide}`,
  );

  // The same measurement on the dissolve, which is what makes the one above
  // mean something: a dissolve has no side to be on.
  const dissolveLeftSide = sideLuma(soft.output, midway, "left");
  const dissolveRightSide = sideLuma(soft.output, midway, "right");
  check(
    "whereas halfway through a dissolve both sides are the same mix",
    Math.abs(dissolveLeftSide - dissolveRightSide) < 30,
    `left ${dissolveLeftSide}, right ${dissolveRightSide}`,
  );

  // The flash goes through white, which neither shot is — white is the tell.
  const flashed = await renderPlan(
    twoShots,
    { version: 1, operations: [...cutOps, { type: "transition", style: "flash", durationMs: 400 }] },
    { workDir: await scratch() },
  );
  const flashSeconds = Number(ffprobe(flashed.output, "format=duration")[0]);
  check(
    "the flash costs the same overlap too",
    Math.abs(flashSeconds - softSeconds) < 0.12,
    `flash ${flashSeconds}, dissolve ${softSeconds}`,
  );
  // "Passes through white" is a claim about the *brightest* moment of the join,
  // not about one frame of it: the whitest instant is a single frame near the
  // middle and which frame that is depends on the frame rate. So the window is
  // scanned and the peak taken — measuring the claim rather than a sample of it.
  const peakOver = (file, from, to) => {
    const r = spawnSync(
      "ffprobe",
      [
        "-v", "error", "-f", "lavfi",
        "-i", `movie=${file},trim=start=${from}:end=${to},signalstats`,
        "-show_entries", "frame_tags=lavfi.signalstats.YAVG",
        "-of", "default=nw=1:nk=1",
      ],
      { encoding: "utf8" },
    );
    const vals = r.stdout.trim().split("\n").filter(Boolean).map(Number).filter(Number.isFinite);
    return vals.length > 0 ? Math.max(...vals) : NaN;
  };
  // A narrow window around the middle of the join, not the whole of it: the
  // first frames of any transition are still almost entirely the outgoing shot
  // — which here is white — so a window spanning the whole overlap peaks at
  // white for every style and discriminates nothing.
  const flashPeak = peakOver(flashed.output, midway - 0.07, midway + 0.07);
  const dissolvePeak = peakOver(soft.output, midway - 0.07, midway + 0.07);
  check(
    "a flash passes through white on its way from one shot to the next",
    flashPeak > 200,
    String(flashPeak),
  );
  // What makes that mean something: at the very same instant the dissolve is
  // halfway grey. Without this line the check above would pass on any style
  // measured a moment early, while the white shot was still on screen.
  // What makes that mean something: across the same window the dissolve never
  // gets near white. Without this line the check above would pass on any style
  // measured while the white shot was still on screen.
  check(
    "and the dissolve never does across the same window, so the tell is the flash",
    flashPeak > dissolvePeak + 40,
    `flash peak ${flashPeak}, dissolve peak ${dissolvePeak}`,
  );
  check(
    "and says so",
    flashed.notes.some((n) => /flashed white between the cuts/.test(n)),
    JSON.stringify(flashed.notes),
  );

  // Nothing to dissolve between is not an error, and not silence either.

  const nothingToJoin = await renderPlan(
    twoShots,
    { version: 1, operations: [{ type: "transition", style: "dissolve", durationMs: 400 }] },
    { workDir: await scratch() },
  );
  check(
    "a transition on an uncut video says there was nothing to join",
    nothingToJoin.notes.some((n) => /no cuts in this edit to put a transition between/.test(n)),
    JSON.stringify(nothingToJoin.notes),
  );
  const untouched = Number(ffprobe(nothingToJoin.output, "format=duration")[0]);
  check("and leaves the video exactly as long as it was", Math.abs(untouched - 7) < 0.3, String(untouched));

  // An overlap that will not fit inside the shortest piece is shortened to
  // fit rather than refused — and admitted. Built from half-second bursts:
  // 400ms of dissolve on a 500ms shot would leave it never once on screen by
  // itself, which is not a transition, it is a smear.
  const staccato = path.join(dir, "staccato.mp4");
  spawnSync("ffmpeg", [
    "-hide_banner", "-y",
    "-f", "lavfi", "-i", "color=c=white:size=320x240:rate=25:duration=5",
    "-f", "lavfi", "-i",
    "sine=frequency=440:duration=5,volume='if(lt(mod(t,1.2),0.5),1,0)':eval=frame",
    "-map", "0:v", "-map", "1:a",
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", staccato,
  ]);
  const greedy = await renderPlan(
    staccato,
    { version: 1, operations: [...cutOps, { type: "transition", style: "dissolve", durationMs: 400 }] },
    { workDir: await scratch() },
  );
  check(
    "an overlap longer than the pieces allow is shrunk, and says so",
    greedy.notes.some((n) => /dissolved between the cuts over 0\.\d\ds — shorter than asked, so the shortest piece/.test(n)),
    JSON.stringify(greedy.notes),
  );
}

console.log("\nCut edges are ramped under the ear's threshold, so joins do not click");
{
  // A cut rarely lands on a zero crossing, and a waveform that jumps
  // mid-cycle is a broadband click stitched into the join. Every audio edge
  // gets a 15ms ramp — too short to register as a fade, long enough that the
  // step is gone. Measured here on the first edge of a real silence-removed
  // render: the opening milliseconds rise out of zero instead of slamming in.
  const cut = await renderPlan(
    source,
    { version: 1, operations: [{ type: "removeSilence", thresholdDb: -32, minSilenceMs: 500, paddingMs: 0 }] },
    { workDir: await scratch() },
  );
  const head = segmentMeanVolume(cut.output, 0, 0.008);
  const steady = segmentMeanVolume(cut.output, 0.1, 0.5);
  check("the first blink of audio rises out of zero", head < steady - 6, `head ${head} dB, steady ${steady} dB`);
  check(
    "the cut itself still happened",
    cut.notes.some((n) => /removed .* of silence/.test(n)),
    JSON.stringify(cut.notes),
  );
  check(
    "and no note announces the ramp — a cut done properly is not a decision",
    !cut.notes.some((n) => /ramp|click|declick/i.test(n)),
    JSON.stringify(cut.notes),
  );
}

console.log("\nThe worker looks at what it made before handing it over");
{
  const dir = await scratch();

  // A finished-looking output whose mix landed nowhere near the brief: bright
  // test pattern, tone at roughly -31 LUFS against a -14 target.
  const off = path.join(dir, "off.mp4");
  spawnSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=6",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
    "-filter_complex", "[1:a]volume=0.05[a]",
    "-map", "0:v", "-map", "[a]",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", off,
  ]);
  const keep = path.join(dir, "off-before.mp4");
  spawnSync("cp", [off, keep]);

  const before = measureLoudness(off);
  check("the crafted output really did miss the target", before < -20, `${before} LUFS`);

  const loudnessPlan = [{ type: "normalizeLoudness", targetLufs: -14 }];
  const review = await reviewOutput(off, {
    operations: loudnessPlan,
    sourcePath: keep,
    sourceHadAudio: true,
    expectedSeconds: 6,
    workDir: dir,
  });
  check("the miss is noticed and the file is repaired in place", review.repaired === true, JSON.stringify(review));
  const after = measureLoudness(off);
  check("the corrected mix lands within tolerance of the target", Math.abs(after + 14) <= 1.2, `${after} LUFS`);
  check(
    "and the note admits the first pass missed rather than pretending",
    review.notes.some((n) => /levelling missed/.test(n) && /LUFS/.test(n)),
    JSON.stringify(review.notes),
  );
  check(
    "the picture was stream-copied, not re-encoded — the frames are bit-identical",
    psnr(keep, off) === Infinity,
    String(psnr(keep, off)),
  );

  // The same file, reviewed again: now on target, so the critic stays quiet.
  const again = await reviewOutput(off, {
    operations: loudnessPlan,
    sourcePath: keep,
    sourceHadAudio: true,
    expectedSeconds: 6,
    workDir: dir,
  });
  check(
    "a mix already on target is left untouched, with nothing to say",
    again.repaired === false && again.notes.length === 0,
    JSON.stringify(again),
  );

  // A near-silent mix is a clip with nothing in it, not a level to correct —
  // gain would only raise the noise floor, so no repair and no note.
  const hush = path.join(dir, "hush.mp4");
  spawnSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=4",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
    "-filter_complex", "[1:a]volume=0.001[a]",
    "-map", "0:v", "-map", "[a]",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", hush,
  ]);
  const hushed = await reviewOutput(hush, {
    operations: loudnessPlan,
    sourcePath: hush,
    sourceHadAudio: true,
    expectedSeconds: 4,
    workDir: dir,
  });
  check(
    "silence is not corrected and not apologised for",
    hushed.repaired === false && hushed.notes.length === 0,
    JSON.stringify(hushed),
  );

  // A source that had sound and an output that does not is a defect worth
  // saying out loud — deterministic, so not retried, but never hushed up.
  const mute = path.join(dir, "mute.mp4");
  spawnSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=4",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", mute,
  ]);
  const muted = await reviewOutput(mute, {
    operations: loudnessPlan,
    sourcePath: keep,
    sourceHadAudio: true,
    expectedSeconds: 4,
    workDir: dir,
  });
  check(
    "an audio track that vanished is confessed in the notes",
    muted.notes.some((n) => /sound did not survive/.test(n)),
    JSON.stringify(muted.notes),
  );

  // A black picture is called out — but only when the source was not black,
  // because audio over a black card is somebody's deliberate look.
  const black = path.join(dir, "black.mp4");
  spawnSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=black:size=320x240:rate=25:duration=4",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
    "-map", "0:v", "-map", "1:a",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", black,
  ]);
  const blackFromBright = await reviewOutput(black, {
    operations: [],
    sourcePath: keep,
    sourceHadAudio: true,
    expectedSeconds: 4,
    workDir: dir,
  });
  check(
    "a black picture from a bright source is a confessed bug",
    blackFromBright.notes.some((n) => /came out black/.test(n)),
    JSON.stringify(blackFromBright.notes),
  );
  const blackFromBlack = await reviewOutput(black, {
    operations: [],
    sourcePath: black,
    sourceHadAudio: true,
    expectedSeconds: 4,
    workDir: dir,
  });
  check(
    "a black picture from a black source is the user's own look, not our bug",
    blackFromBlack.notes.every((n) => !/came out black/.test(n)),
    JSON.stringify(blackFromBlack.notes),
  );

  // Length drift is ours to chase in the logs, never the user's to worry about.
  const drifted = await reviewOutput(off, {
    operations: loudnessPlan,
    sourcePath: keep,
    sourceHadAudio: true,
    expectedSeconds: 20,
    workDir: dir,
  });
  check(
    "duration drift raises a diagnostic, not an apology",
    drifted.warnings.some((w) => /cut map/.test(w)) && drifted.notes.length === 0,
    JSON.stringify(drifted),
  );

  await rm(dir, { recursive: true, force: true });
}

// ── The music bed ───────────────────────────────────────────────────────────
//
// Everything below measures the mix that came out, not the filter string that
// went in: a bed that is silent, a duck that does not duck, and a track laid
// under a silent clip that never reaches the file all produce a perfectly
// well-formed command.
console.log("\nMusic");
{
  const dir = await scratch();

  // Source: a loud tone for the first two seconds, then nothing. The tone is
  // what the ducking listens to, and the silence is where the bed is naked and
  // can be measured on its own.
  const spoken = path.join(dir, "spoken.mp4");
  spawnSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=4",
    "-f", "lavfi", "-i", "sine=frequency=300:duration=4",
    "-filter_complex", "[1:a]volume='if(between(t,0,2),1,0)':eval=frame[a]",
    "-map", "0:v", "-map", "[a]",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", spoken,
  ]);

  // A silent clip — no audio stream at all, which is what a phone screen
  // recording or an exported animation actually is.
  const mute = path.join(dir, "mute.mp4");
  spawnSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=4",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", mute,
  ]);

  // The "track": deliberately shorter than every edit it is laid under, so
  // looping is exercised rather than assumed.
  const track = path.join(dir, "track.m4a");
  spawnSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "sine=frequency=900:duration=1.5",
    "-c:a", "aac", track,
  ]);

  const assets = new Map([
    ["song", { file: track, kind: "audio" }],
    ["reel", { file: spoken, kind: "video" }],
  ]);
  const music = (extra = {}) => ({
    type: "addMusic", assetId: "song", gainDb: 0, duck: true,
    fadeSeconds: 0, fromSeconds: 0, loop: true, ...extra,
  });

  // 1. A clip with no audio track comes out with sound.
  const alone = await renderPlan(mute, { version: 1, operations: [music()] }, { workDir: await scratch(), assets });
  const aloneStreams = ffprobe(alone.output, "stream=codec_type").join(",");
  check("a silent clip with music under it comes out with an audio stream", /audio/.test(aloneStreams), aloneStreams);
  const aloneLevel = segmentMeanVolume(alone.output, 0.5, 3.5);
  check("and that stream is audible, not a silent placeholder", aloneLevel > -40, `${aloneLevel} dB`);
  check(
    "the note says the music is all of it rather than claiming a mix",
    alone.notes.some((n) => /no sound of its own/.test(n)),
    JSON.stringify(alone.notes),
  );

  // 2. The bed runs the whole edit, looping past the end of a 1.5s track.
  const aloneDuration = Number(ffprobe(alone.output, "stream=duration", ["-select_streams", "a:0"])[0]);
  check("a short track loops to the length of the edit", aloneDuration > 3.5, String(aloneDuration));
  const tail = segmentMeanVolume(alone.output, 3.0, 3.9);
  check("the last second is still music, not the silence after the track ran out", tail > -40, `${tail} dB`);

  // 3. Ducking. Both renders carry the same speech, so the difference in the
  //    loud window is the bed being pulled down and nothing else.
  const ducked = await renderPlan(spoken, { version: 1, operations: [music({ duck: true })] }, { workDir: await scratch(), assets });
  const flat = await renderPlan(spoken, { version: 1, operations: [music({ duck: false })] }, { workDir: await scratch(), assets });
  const duckedUnderSpeech = segmentMeanVolume(ducked.output, 0.4, 1.8);
  const flatUnderSpeech = segmentMeanVolume(flat.output, 0.4, 1.8);
  check(
    "under speech the ducked mix sits below the unducked one",
    duckedUnderSpeech < flatUnderSpeech - 0.5,
    `ducked ${duckedUnderSpeech} dB vs flat ${flatUnderSpeech} dB`,
  );
  const duckedInGap = segmentMeanVolume(ducked.output, 2.6, 3.8);
  check(
    "in the gap the bed comes back up",
    duckedInGap > duckedUnderSpeech - 12 && duckedInGap > -40,
    `gap ${duckedInGap} dB vs under speech ${duckedUnderSpeech} dB`,
  );
  check(
    "the note admits which of the two happened",
    ducked.notes.some((n) => /ducking under the speech/.test(n)) &&
      flat.notes.some((n) => /laid music under the whole edit/.test(n) && !/ducking/.test(n)),
    JSON.stringify([ducked.notes, flat.notes]),
  );

  // 4. The voice is not quieter for having a bed under it. amix averages by
  //    default, which would drop the speech 6dB and make the level note a lie.
  const bare = await renderPlan(spoken, { version: 1, operations: [{ type: "grade", saturation: 1 }] }, { workDir: await scratch() });
  const bareSpeech = segmentMeanVolume(bare.output, 0.4, 1.8);
  check(
    "the speech is no quieter for having music under it",
    flatUnderSpeech > bareSpeech - 1,
    `with music ${flatUnderSpeech} dB vs alone ${bareSpeech} dB`,
  );

  // 5. A track that is not in the library, and one that is not audio.
  const missing = await renderPlan(spoken, { version: 1, operations: [music({ assetId: "nope" })] }, { workDir: await scratch(), assets });
  check(
    "music naming an asset outside the project is skipped, not rendered",
    missing.notes.some((n) => /not in this project/.test(n)),
    JSON.stringify(missing.notes),
  );
  const wrongKind = await renderPlan(spoken, { version: 1, operations: [music({ assetId: "reel" })] }, { workDir: await scratch(), assets });
  check(
    "music pointing at a video file is skipped with the reason",
    wrongKind.notes.some((n) => /not an audio file/.test(n)),
    JSON.stringify(wrongKind.notes),
  );

  // 6. Fades are the bed's own and are clamped to a third of a short edit.
  const faded = await renderPlan(spoken, { version: 1, operations: [music({ fadeSeconds: 3 })] }, { workDir: await scratch(), assets });
  check(
    "a fade longer than a third of the edit is shortened and said so",
    faded.notes.some((n) => /music fades run 1\.3s rather than the 3\.0s asked/.test(n)),
    JSON.stringify(faded.notes),
  );

  await rm(dir, { recursive: true, force: true });
}

// ── Two overlays of different shapes ────────────────────────────────────────
//
// The stream index for an extra input used to be derived from the length of
// the args array on the assumption that every input is `-i file`. A still is
// six args and the motion layer is four, so the *second* extra input was
// addressed wrongly whenever the first was not b-roll — and ffmpeg failed on
// a filtergraph error, which reads as our bug and is invisible until a plan
// happens to combine the two.
console.log("\nMixed overlay inputs");
{
  const dir = await scratch();
  const still = path.join(dir, "still.png");
  spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:size=64x64", "-frames:v", "1", still]);
  const cut = path.join(dir, "cut.mp4");
  spawnSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=green:size=320x240:rate=25:duration=3",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", cut,
  ]);
  const assets = new Map([
    ["logo", { file: still, kind: "image" }],
    ["cutaway", { file: cut, kind: "video" }],
  ]);
  const both = await renderPlan(
    source,
    {
      version: 1,
      operations: [
        { type: "extractRange", startSeconds: 0, endSeconds: 6 },
        { type: "overlayImage", assetId: "logo", at: 0.5, durationSeconds: 2, position: "top-left", scale: 0.2, opacity: 1 },
        { type: "insertBRoll", assetId: "cutaway", at: 3, durationSeconds: 2, fit: "cover", keepSourceAudio: true },
      ],
    },
    { workDir: await scratch(), assets },
  );
  check(
    "a still and a b-roll clip in one plan both reach the frame",
    both.notes.some((n) => /laid an image over the frame/.test(n)) && both.notes.some((n) => /cut to b-roll/.test(n)),
    JSON.stringify(both.notes),
  );
  const frames = Number(ffprobe(both.output, "stream=nb_read_frames", ["-select_streams", "v:0", "-count_frames"])[0]);
  check("and the render finished rather than dying on a bad stream index", Number.isFinite(frames) && frames > 100, String(frames));
  await rm(dir, { recursive: true, force: true });
}

// ── The named looks ─────────────────────────────────────────────────────────
//
// A grade is the easiest thing in this file to fake: emit a filter, write a
// note, ship. So nothing here reads the filter string. Each look is measured
// off the pixels that came out, against the same clip rendered with no grade
// at all — U and V are the colour-difference planes, so "warmer" is a real
// number (V up, U down) rather than a word.
console.log("\nColour looks are measured on the pixels, not on the filter");
{
  const dir = await scratch();

  // Mid-grey with real colour in it: a flat colour patch would make every
  // channel move together and hide exactly what these filters do differently.
  const colourful = path.join(dir, "colourful.mp4");
  spawnSync("ffmpeg", [
    "-hide_banner", "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25:duration=3",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", colourful,
  ]);

  /** Mean Y, U, V and the spread of Y, averaged over the whole clip. */
  const planes = (file) => {
    const r = spawnSync(
      "ffprobe",
      [
        "-v", "error", "-f", "lavfi",
        "-i", `movie=${file},signalstats`,
        "-show_entries", "frame_tags=lavfi.signalstats.YAVG,lavfi.signalstats.UAVG,lavfi.signalstats.VAVG,lavfi.signalstats.YDIF",
        "-of", "csv=p=0",
      ],
      { encoding: "utf8" },
    );
    const rows = r.stdout.trim().split("\n").filter(Boolean).map((line) => line.split(",").map(Number));
    if (rows.length === 0) return { y: NaN, u: NaN, v: NaN };
    const mean = (i) => rows.reduce((sum, row) => sum + row[i], 0) / rows.length;
    return { y: mean(0), u: mean(1), v: mean(2) };
  };

  /** How far the colour planes sit from neutral — zero is grey. */
  const chroma = (file) => {
    const r = spawnSync(
      "ffprobe",
      [
        "-v", "error", "-f", "lavfi",
        "-i", `movie=${file},signalstats`,
        "-show_entries", "frame_tags=lavfi.signalstats.SATAVG",
        "-of", "default=nw=1:nk=1",
      ],
      { encoding: "utf8" },
    );
    const vals = r.stdout.trim().split("\n").filter(Boolean).map(Number);
    return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : NaN;
  };

  const graded = async (look) => {
    const { output, notes } = await renderPlan(
      colourful,
      { version: 1, operations: [{ type: "grade", saturation: 1, look }] },
      { workDir: await scratch() },
    );
    return { output, notes };
  };

  const plain = await graded("none");
  const base = planes(plain.output);
  const baseChroma = chroma(plain.output);
  check("the ungraded render is a usable baseline", Number.isFinite(base.u) && Number.isFinite(baseChroma), JSON.stringify(base));
  check("and says nothing about colour when no look was asked for", !plain.notes.some((n) => /warm|cool|cinematic|colour/i.test(n)), JSON.stringify(plain.notes));

  // Hue shifts are measured on neutral grey, not on the colourful clip. The
  // first version of this check used the colour bars for everything and read a
  // warm shift as 0.3 of a level — because a rainbow's saturated patches move
  // in opposite directions and the frame mean cancels them out. On grey the
  // same filter reads four levels. That is not a lowered bar, it is the right
  // instrument: the colourful clip stays below for the saturation checks,
  // where a flat grey would be the useless one.
  const grey = path.join(dir, "grey.mp4");
  spawnSync("ffmpeg", [
    "-hide_banner", "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=gray:size=320x240:rate=25:duration=2",
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", grey,
  ]);
  const gradedGrey = async (look) => {
    const { output } = await renderPlan(
      grey,
      { version: 1, operations: [{ type: "grade", saturation: 1, look }] },
      { workDir: await scratch() },
    );
    return planes(output);
  };

  // V carries red, U carries blue. Warming pushes one up and the other down,
  // and checking both is what separates a colour shift from the picture simply
  // getting brighter.
  const greyBase = planes(grey);
  const w = await gradedGrey("warm");
  check(
    "warm moves red up and blue down",
    w.v > greyBase.v + 1.5 && w.u < greyBase.u - 1.5,
    `V ${greyBase.v.toFixed(1)}→${w.v.toFixed(1)}, U ${greyBase.u.toFixed(1)}→${w.u.toFixed(1)}`,
  );
  const c = await gradedGrey("cool");
  check(
    "and cool moves them the other way",
    c.v < greyBase.v - 1.5 && c.u > greyBase.u + 1.5,
    `V ${greyBase.v.toFixed(1)}→${c.v.toFixed(1)}, U ${greyBase.u.toFixed(1)}→${c.u.toFixed(1)}`,
  );
  check("so the two are not the same filter under two names", Math.abs(w.v - c.v) > 4, `${w.v.toFixed(1)} vs ${c.v.toFixed(1)}`);

  // Mono: the whole point is that there is no colour left.
  const mono = await graded("mono");
  const monoChroma = chroma(mono.output);
  check("mono takes the colour out", monoChroma < baseChroma * 0.2, `saturation ${baseChroma.toFixed(1)} → ${monoChroma.toFixed(1)}`);
  check("and says so plainly", mono.notes.some((n) => /took the colour out/.test(n)), JSON.stringify(mono.notes));

  // Punch: more colour, no hue shift. Both halves matter — a "punch" that
  // tinted the picture would be a different look wearing the name.
  const punch = await graded("punch");
  const punchChroma = chroma(punch.output);
  const p = planes(punch.output);
  check("punch adds colour rather than removing it", punchChroma > baseChroma * 1.05, `saturation ${baseChroma.toFixed(1)} → ${punchChroma.toFixed(1)}`);
  check("without tinting it one way or the other", Math.abs(p.v - base.v) < 3 && Math.abs(p.u - base.u) < 3, `V ${base.v.toFixed(1)}→${p.v.toFixed(1)}, U ${base.u.toFixed(1)}→${p.u.toFixed(1)}`);

  // Cinematic is the only look that has to treat the ends of the range
  // differently, so measuring one frame as a whole would miss the entire
  // point: a uniform blue cast would pass a whole-frame check and be the wrong
  // look. It is measured on two flat clips instead — one dark, one bright —
  // and asked to move them in *opposite* directions.
  //
  // This first used a black-to-white ramp from the `gradients` source, read in
  // two horizontal bands. It passed here and failed in CI, where the shadow
  // band measured as a highlight: that filter does not render identically
  // across ffmpeg builds, so the test was really asserting which way one
  // generator happened to paint. Two flat colours at named levels cannot be
  // ambiguous about which one is the dark one.
  const flat = async (colour) => {
    const file = path.join(dir, `flat-${colour}.mp4`);
    spawnSync("ffmpeg", [
      "-hide_banner", "-y", "-loglevel", "error",
      "-f", "lavfi", "-i", `color=c=${colour}:size=320x240:rate=25:duration=2`,
      "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", file,
    ]);
    const { output, notes } = await renderPlan(
      file,
      { version: 1, operations: [{ type: "grade", saturation: 1, look: "cinematic" }] },
      { workDir: await scratch() },
    );
    return { before: planes(file), after: planes(output), notes };
  };

  const dark = await flat("0x202020");
  const bright = await flat("0xD8D8D8");
  check(
    "cinematic puts blue into the shadows",
    dark.after.u > dark.before.u + 3,
    `U ${dark.before.u?.toFixed(1)}→${dark.after.u?.toFixed(1)}`,
  );
  check(
    "and takes it out of the highlights, which is the whole look",
    bright.after.u < bright.before.u - 3 && bright.after.v > bright.before.v + 1,
    `U ${bright.before.u?.toFixed(1)}→${bright.after.u?.toFixed(1)}, V ${bright.before.v?.toFixed(1)}→${bright.after.v?.toFixed(1)}`,
  );
  check(
    "so the two ends really do move apart, which a uniform cast would not",
    dark.after.u - bright.after.u > 10,
    `shadows U ${dark.after.u?.toFixed(1)} against highlights U ${bright.after.u?.toFixed(1)}`,
  );
  const cine = { notes: dark.notes };
  check("and names what it did", cine.notes.some((n) => /blue in the shadows/.test(n)), JSON.stringify(cine.notes));

  // A look and a reference match compose. Mono is the one pair that cannot,
  // and the render says so rather than claiming a match it did not make.
  const both = await renderPlan(
    colourful,
    { version: 1, operations: [{ type: "grade", saturation: 1.3, look: "warm" }] },
    { workDir: await scratch() },
  );
  check(
    "a look and a reference match both happen",
    both.notes.some((n) => /warmed the picture/.test(n)) && both.notes.some((n) => /pushed 30%/.test(n)),
    JSON.stringify(both.notes),
  );
  const monoBoth = await renderPlan(
    colourful,
    { version: 1, operations: [{ type: "grade", saturation: 1.3, look: "mono" }] },
    { workDir: await scratch() },
  );
  check(
    "but a reference match on a black-and-white picture is admitted, not claimed",
    monoBoth.notes.some((n) => /no colour left/.test(n)) && !monoBoth.notes.some((n) => /pushed 30%/.test(n)),
    JSON.stringify(monoBoth.notes),
  );
  check(
    "and it really is still black and white",
    chroma(monoBoth.output) < baseChroma * 0.2,
    String(chroma(monoBoth.output)),
  );

  await rm(dir, { recursive: true, force: true });
}

/**
 * The captions can draw the language the transcript comes back in.
 *
 * Until the previous round every video was transcribed as English, so Arabic
 * text had never reached the caption burner at all. Now that it does, the
 * question is whether libass can actually draw it — and that is a question
 * about the *image*, not about this code: an ffmpeg built without HarfBuzz
 * renders Arabic as isolated, unjoined letters, one built without FriBidi
 * renders the word backwards, and a font without the glyphs renders nothing.
 *
 * All three failures render successfully. There are captions on the frame,
 * the file plays, the duration is right, and the words are unreadable. That is
 * the same shape of bug as the transcription default, one layer further down,
 * and it is why this is measured rather than assumed.
 *
 * The measurements are relationships, not pixel counts, so they survive a font
 * update: a joined word fits inside a box that the same letters spaced apart
 * spill out of, and the tall strokes swap sides when the word is reversed.
 */
/**
 * The punches land on the music, or they do not happen.
 *
 * "Cut it to the beat" left the "cannot yet" list this round, and the thing
 * that makes it safe to ship is not the detector — it is what the renderer does
 * when the detector says no. A track with no pulse must not quietly become the
 * *other* edit: punches on the speaker's emphasis are a different film, and
 * doing that without saying so is the exact failure this pipeline's notes exist
 * to prevent.
 *
 * So all three answers are asserted here, on real renders: a beat, no beat, and
 * no music at all.
 */
console.log("\nPunches land on the beat, or the render says why not");
{
  const dir = await scratch();

  // Eight seconds of clicks half a second apart: 120 bpm, chosen by us.
  const clicks = path.join(dir, "clicks.m4a");
  spawnSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "aevalsrc='0.9*sin(2*PI*1000*t)*exp(-mod(t\\,0.5)*250)':d=8:s=22050",
    "-c:a", "aac", clicks,
  ]);
  // The same length of a held tone: audible, and with no pulse in it at all.
  const flat = path.join(dir, "flat.m4a");
  spawnSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=8",
    "-c:a", "aac", flat,
  ]);
  const clip = path.join(dir, "eight.mp4");
  spawnSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=8",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", clip,
  ]);

  const beatPlan = (assetId) => ({
    version: 1,
    operations: [
      ...(assetId
        ? [{ type: "addMusic", assetId, gainDb: -6, duck: false, fadeSeconds: 0, fromSeconds: 0, loop: true }]
        : []),
      { type: "zoomPunch", at: [], amount: 0.13, holdMs: 800, on: "beat" },
    ],
  });
  const beatAssets = new Map([
    ["clicks", { file: clicks, kind: "audio" }],
    ["flat", { file: flat, kind: "audio" }],
  ]);

  const onBeat = await renderPlan(clip, beatPlan("clicks"), { workDir: await scratch(), assets: beatAssets });
  check(
    "with a beat under it, the note says how many punches and at what tempo",
    onBeat.notes.some((n) => /on the beat, one a bar at 120 bpm/.test(n)),
    JSON.stringify(onBeat.notes),
  );
  check(
    "and the file is still a file",
    Number(ffprobe(onBeat.output, "format=duration")[0]) > 7,
    JSON.stringify(ffprobe(onBeat.output, "format=duration")),
  );

  const noPulse = await renderPlan(clip, beatPlan("flat"), { workDir: await scratch(), assets: beatAssets });
  check(
    "a track with no pulse is admitted, not guessed at",
    noPulse.notes.some((n) => /could not find a steady beat/.test(n)),
    JSON.stringify(noPulse.notes),
  );
  // The whole point: the other edit did not happen instead.
  check(
    "and the punches are simply not there, rather than moved to the voice",
    !noPulse.notes.some((n) => /on the beat/.test(n)),
    JSON.stringify(noPulse.notes),
  );

  const noMusic = await renderPlan(clip, beatPlan(null), { workDir: await scratch(), assets: beatAssets });
  check(
    "and with no music at all the note names that, not the detector",
    noMusic.notes.some((n) => /no music under this edit/.test(n)),
    JSON.stringify(noMusic.notes),
  );

  await rm(dir, { recursive: true, force: true });
}

console.log("\nThe captions can draw Arabic, not just accept it");
{
  // A black 1080x1920 clip, so every lit pixel in the caption band is ink.
  const dark = path.join(workDir, "dark.mp4");
  spawnSync("ffmpeg", [
    "-y", "-f", "lavfi", "-i", "color=c=black:s=1080x1920:d=2",
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono",
    "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", dark,
  ], { stdio: "ignore" });

  const captioned = async (text) => {
    const { output } = await renderPlan(
      dark,
      {
        version: 1,
        operations: [
          {
            type: "burnCaptions",
            style: "bold-white",
            animation: "pop",
            cues: [{ startMs: 0, endMs: 2000, text }],
          },
        ],
      },
      { workDir: await scratch() },
    );
    return output;
  };

  // Limited-range black is Y=16, not 0, so a crop with no ink in it reads 16.
  // Subtracting that floor leaves a number proportional to the ink itself,
  // which is what makes two renders comparable.
  const BLACK = 16;
  const BAND = { whole: "iw:400:0:ih-700", left: "iw/2:400:0:ih-700", right: "iw/2:400:iw/2:ih-700" };
  const inkIn = (file, crop) => {
    const r = spawnSync(
      "ffprobe",
      [
        "-v", "error", "-f", "lavfi",
        "-i", `movie=${file},trim=start=1:end=1.06,crop=${crop},signalstats`,
        "-show_entries", "frame_tags=lavfi.signalstats.YAVG",
        "-of", "default=nw=1:nk=1",
      ],
      { encoding: "utf8" },
    );
    const vals = r.stdout.trim().split("\n").filter(Boolean).map(Number);
    return vals.length > 0 ? Math.max(0, vals[0] - BLACK) : NaN;
  };

  // ── The font has the glyphs at all ──────────────────────────────────────
  const words = await captioned("السلام عليكم ورحمة الله");
  check(
    "Arabic captions put ink on the frame — the font covers the script",
    inkIn(words, BAND.whole) > 1,
    `${inkIn(words, BAND.whole)} above a black floor`,
  );

  // ── The letters join ────────────────────────────────────────────────────
  //
  // The same four letters, once as a word and once with spaces between them.
  // Arabic joins, and the joined forms are simpler than the isolated ones, so
  // the word carries visibly less ink than the spaced version. Without
  // shaping the "word" renders as four isolated forms and the two carry the
  // same ink — which is the whole test, and it needs no geometry: an ffmpeg
  // built without HarfBuzz cannot make the difference appear.
  const joined = await captioned("بببب");
  const spaced = await captioned("ب ب ب ب");
  check(
    "a joined word carries less ink than the same letters spaced apart",
    inkIn(joined, BAND.whole) < 0.8 * inkIn(spaced, BAND.whole),
    `joined ${inkIn(joined, BAND.whole)} vs spaced ${inkIn(spaced, BAND.whole)} — equal means the letters are not being shaped`,
  );

  // The control, and the reason the check above is worth anything: a
  // zero-width non-joiner between each letter forbids the joining while
  // leaving the letters adjacent, which is precisely what an ffmpeg without
  // HarfBuzz produces. It measures the same as the spaced version, so the
  // check is reading the shaping and not the spaces.
  const forbidden = await captioned("\u0628\u200C\u0628\u200C\u0628\u200C\u0628");
  check(
    "and letters forbidden to join measure the same as spaced ones — so that is what is being read",
    inkIn(forbidden, BAND.whole) > 0.9 * inkIn(spaced, BAND.whole),
    `forbidden ${inkIn(forbidden, BAND.whole)} vs spaced ${inkIn(spaced, BAND.whole)}`,
  );

  // ── And they run right to left ──────────────────────────────────────────
  //
  // Alef is a bare tall stroke and beh is a short bowl, so three alefs weigh
  // one side of the line down. Put the beh last and the alefs sit on the
  // right; put it first and they sit on the left. What is asserted is that
  // the two answers are opposites, which needs no reference frame and no
  // absolute number — only that reversing the word moves the weight.
  const behLast = await captioned("اااب");
  const behFirst = await captioned("بااا");
  const leansRight = (file) => inkIn(file, BAND.right) > inkIn(file, BAND.left);

  check(
    "the last letter is drawn on the left, because Arabic runs right to left",
    leansRight(behLast),
    `left ${inkIn(behLast, BAND.left)}, right ${inkIn(behLast, BAND.right)}`,
  );
  check(
    "and reversing the word moves the weight to the other side",
    !leansRight(behFirst),
    `left ${inkIn(behFirst, BAND.left)}, right ${inkIn(behFirst, BAND.right)} — the same lean both ways means the order is not being applied`,
  );

  // The control again: a left-to-right override in front of the same word
  // makes it lay out the way an ffmpeg without FriBidi would lay it out, and
  // the lean goes the other way. Without this the two checks above could both
  // be satisfied by a renderer that never reorders anything.
  const overridden = await captioned("\u202D\u0627\u0627\u0627\u0628");
  check(
    "a word forced left-to-right leans the other way — so that is what is being read",
    !leansRight(overridden),
    `left ${inkIn(overridden, BAND.left)}, right ${inkIn(overridden, BAND.right)}`,
  );

  // ── And the line reads in the direction of its language ─────────────────
  //
  // Everything above is about the letters. This is about everything that is
  // *not* a letter: the full stop, the question mark, the ellipsis this
  // renderer appends when a caption is truncated. Those characters have no
  // direction of their own, so they take the line's — and ASS has no way to
  // state one, so libass used left to right. An Arabic sentence ending in `…`
  // was drawn with the ellipsis at its beginning.
  //
  // A single-language check cannot see this: a run of alefs leans right either
  // way, because the alefs carry their own direction. What gives it away is
  // that the *same shape of string* must lean opposite ways in the two
  // languages. Under the old behaviour both leaned the same way.
  const arabicTail = await captioned("ااااااااا…");
  const latinTail = await captioned("IIIIIIIII…");
  check(
    "an Arabic caption's ellipsis ends the sentence, so the weight sits on the right",
    leansRight(arabicTail),
    `left ${inkIn(arabicTail, BAND.left)}, right ${inkIn(arabicTail, BAND.right)}`,
  );
  check(
    "the same shape in English leans the other way — the direction follows the language",
    !leansRight(latinTail),
    `left ${inkIn(latinTail, BAND.left)}, right ${inkIn(latinTail, BAND.right)} — the same lean in both means neither is being read`,
  );

  // ── The karaoke wipe does not reverse the sentence ──────────────────────
  //
  // The worst of the three, and the one that could only ever be found by
  // looking at a frame. A `\kf` tag starts a new layout run — a colour tag in
  // the same place does not, which is how we know it is the tag and not the
  // markup — so libass ordered each word correctly *within itself* and then
  // laid the words down left to right. Every word shaped, every wipe on the
  // beat, and the sentence backwards. Nothing failed; nothing could.
  //
  // What is asserted is that the wipe changes nothing about where the words
  // are: the same sentence, with and without karaoke, must put its heavy word
  // on the same side.
  const heavy = "اااااااا";
  const light = "بب";
  const sentence = `${heavy} ${light}`;
  const withWords = async (text, words, animation) => {
    const { output } = await renderPlan(
      dark,
      {
        version: 1,
        operations: [
          {
            type: "burnCaptions",
            style: "karaoke-box",
            animation,
            cues: [{ startMs: 0, endMs: 2000, text, words }],
          },
        ],
      },
      { workDir: await scratch() },
    );
    return output;
  };
  const spoken = [
    { text: heavy, startMs: 0, endMs: 1000 },
    { text: light, startMs: 1000, endMs: 2000 },
  ];
  const plainSentence = await captioned(sentence);
  const sungSentence = await withWords(sentence, spoken, "karaoke");
  check(
    "a karaoke wipe leaves the words where the sentence puts them",
    leansRight(sungSentence) === leansRight(plainSentence),
    `karaoke left ${inkIn(sungSentence, BAND.left)}/right ${inkIn(sungSentence, BAND.right)} against plain left ${inkIn(plainSentence, BAND.left)}/right ${inkIn(plainSentence, BAND.right)} — a difference means the wipe reversed the sentence`,
  );

  // The control for that one: saying the words in the other order must move
  // the weight. Without it the check above passes for a renderer that ignores
  // word order entirely and centres everything.
  const sungBackwards = await withWords(`${light} ${heavy}`, [
    { text: light, startMs: 0, endMs: 1000 },
    { text: heavy, startMs: 1000, endMs: 2000 },
  ], "karaoke");
  check(
    "and saying them in the other order moves the weight — so word order is what is being read",
    leansRight(sungBackwards) !== leansRight(sungSentence),
    `left ${inkIn(sungBackwards, BAND.left)}, right ${inkIn(sungBackwards, BAND.right)}`,
  );

  // English is the other half of the same claim: the reversal is conditional
  // on the line, not applied to every karaoke cue. An English sentence must
  // sit identically with the wipe and without it — and this is the check that
  // fails if somebody ever "simplifies" the condition away.
  const englishSentence = "WWWWWWWW ii";
  const englishWords = [
    { text: "WWWWWWWW", startMs: 0, endMs: 1000 },
    { text: "ii", startMs: 1000, endMs: 2000 },
  ];
  const plainEnglish = await captioned(englishSentence);
  const sungEnglish = await withWords(englishSentence, englishWords, "karaoke");
  check(
    "an English sentence is not touched by any of this",
    leansRight(sungEnglish) === leansRight(plainEnglish) && !leansRight(plainEnglish),
    `karaoke left ${inkIn(sungEnglish, BAND.left)}/right ${inkIn(sungEnglish, BAND.right)} against plain left ${inkIn(plainEnglish, BAND.left)}/right ${inkIn(plainEnglish, BAND.right)}`,
  );
}

/**
 * The render answers in the language it was asked in.
 *
 * Round 35 gave the reply both languages; the render's notes stayed English,
 * so a conversation that opened in Arabic finished in English — a note that
 * arrives minutes later in the other language reads as a different program
 * answering. The notes are the only place that admits a caption was skipped or
 * a punch dropped, so they are exactly the text that must not switch.
 *
 * These render for real rather than reading the source, because the note that
 * matters is the one a finished file produces.
 */
console.log("\nThe render answers in the language it was asked in");
{
  const plan = {
    version: 1,
    operations: [
      { type: "removeSilence", thresholdDb: -32, minSilenceMs: 500, paddingMs: 80 },
      { type: "normalizeLoudness", targetLufs: -14 },
    ],
  };

  const english = await renderPlan(source, plan, { workDir: await scratch() });
  const arabic = await renderPlan(source, plan, { workDir: await scratch(), language: "ar" });

  const arabicScript = /[\u0600-\u06ff]/;
  check(
    "an English render's notes are English",
    english.notes.length > 0 && english.notes.every((n) => !arabicScript.test(n)),
    JSON.stringify(english.notes),
  );
  check(
    "an Arabic render's notes are Arabic",
    arabic.notes.length > 0 && arabic.notes.every((n) => arabicScript.test(n)),
    JSON.stringify(arabic.notes),
  );
  check(
    "and it is the same edit either way — one note per thing done, both times",
    english.notes.length === arabic.notes.length,
    JSON.stringify([english.notes, arabic.notes]),
  );
  check(
    "the numbers are the same numbers",
    JSON.stringify((english.notes.join(" ").match(/[\d.]+/g) ?? []).sort()) ===
      JSON.stringify((arabic.notes.join(" ").match(/[\d.]+/g) ?? []).sort()),
    JSON.stringify([english.notes, arabic.notes]),
  );
  check(
    "an unset language is English, which is what a button in an English interface gives",
    (await renderPlan(source, plan, { workDir: await scratch() })).notes.every((n) => !arabicScript.test(n)),
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
