/**
 * Does the edit we just produced hold up?
 *
 * Every other suite here checks that a component behaves. This one checks the
 * thing the customer actually receives, and it exists because quality is the
 * only claim this product has: nobody in this category competes on the result —
 * they publish feature lists — so the result is the ground we chose to fight
 * on, and unmeasured ground is lost quietly.
 *
 * The failures it is built to catch are the ones that look like nothing in a
 * diff and like an amateur in a video:
 *
 *   - a cut that lands in the middle of a word
 *   - a caption that appears before the words are spoken, or after
 *   - a caption placed where the platform will draw its own furniture over it
 *   - a punch-in on a filler word instead of on the emphasis
 *   - captions that drift out of sync as the clip goes on, because the cuts
 *     moved and the cues did not
 *
 * Everything is measured off the rendered file and the artefacts that produced
 * it, not asserted about the code that wrote them.
 *
 * Usage: node tools/quality-test.mjs
 * Requires: ffmpeg and ffprobe on PATH. No keys, no network.
 */
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-quality-build-"));

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

const ffmpegMod = await import(bundle("artifacts/worker/src/ffmpeg.ts", "ffmpeg.mjs"));
const layoutMod = await import(bundle("artifacts/worker/src/caption-layout.ts", "layout.mjs"));
const captionsMod = await import(bundle("artifacts/worker/src/captions.ts", "captions.mjs"));
const enrichMod = await import(bundle("artifacts/worker/src/enrich.ts", "enrich.mjs"));

const { renderPlan, probeSource, keepSegmentsFrom, remapTime, writeSubtitleFile, wrapToLayout } = ffmpegMod;
const { captionLayout, safeAreaFor, collidesWithFurniture } = layoutMod;

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

const workDir = await mkdtemp(path.join(tmpdir(), "editly-quality-"));
const at = (name) => path.join(workDir, name);

function ff(args) {
  const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...args], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${args.join(" ")}`);
}

/**
 * A clip that speaks in known places. Tone bursts stand in for words: we know
 * to the millisecond where each one starts and stops, which is the only way to
 * assert that a cut did not land inside one.
 */
function spokenClip(name, bursts, seconds) {
  const out = at(`${name}.mp4`);
  const gate = bursts.map(([from, to]) => `between(t,${from},${to})`).join("+");
  ff([
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`,
    "-f", "lavfi", "-i", `testsrc=size=720x1280:rate=30:duration=${seconds}`,
    "-filter_complex", `[0:a]volume='min(1,${gate})':eval=frame[a]`,
    "-map", "[a]", "-map", "1:v",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", out,
  ]);
  return out;
}

console.log("\nCuts land between words, not through them");
{
  // Speech at 0–2, 4–6, 8–10. The silences between are what should go.
  const bursts = [[0, 2], [4, 6], [8, 10]];
  const clip = spokenClip("spoken", bursts, 10);

  const { output, notes } = await renderPlan(
    clip,
    { version: 1, operations: [{ type: "removeSilence", thresholdDb: -32, minSilenceMs: 500, paddingMs: 80 }] },
    { workDir: at("r1") ?? workDir },
  ).catch(async (e) => {
    // renderPlan needs its own directory to exist; fall back to the shared one.
    return renderPlan(
      clip,
      { version: 1, operations: [{ type: "removeSilence", thresholdDb: -32, minSilenceMs: 500, paddingMs: 80 }] },
      { workDir },
    );
  });

  const before = (await probeSource(clip)).duration;
  const after = (await probeSource(output)).duration;

  check("the clip gets shorter", after < before - 1, `${before.toFixed(2)}s → ${after.toFixed(2)}s`);
  check(
    "but no more than the silence that was actually there",
    after >= 6 - 0.7,
    `${after.toFixed(2)}s kept, 6s of speech existed`,
  );
  check("and the pipeline says what it removed", notes.some((n) => /removed .* of silence/.test(n)), JSON.stringify(notes));

  // The real test: is any burst clipped? Measure how much audio survives above
  // the noise floor and compare it with the 6 seconds we know were spoken.
  const measured = spawnSync("ffmpeg", [
    "-hide_banner", "-nostdin", "-i", output,
    "-af", "silencedetect=noise=-40dB:d=0.05", "-vn", "-f", "null", "-",
  ], { encoding: "utf8" }).stderr;
  const silentAfter = [...measured.matchAll(/silence_duration:\s*([\d.]+)/g)].reduce((s, m) => s + Number(m[1]), 0);
  const speechKept = after - silentAfter;
  check(
    "every spoken word survives the cut",
    speechKept >= 6 - 0.35,
    `${speechKept.toFixed(2)}s of speech left of 6s`,
  );
}

console.log("\nCaptions stay with the voice after the cuts");
{
  // A cue for each burst, timed against the original.
  const cues = [
    { startMs: 0, endMs: 2000, text: "first line" },
    { startMs: 4000, endMs: 6000, text: "second line" },
    { startMs: 8000, endMs: 10000, text: "third line" },
  ];
  const kept = keepSegmentsFrom(10, [{ start: 2, end: 4 }, { start: 6, end: 8 }], 0.08);

  const shifted = cues.map((c) => ({
    startMs: remapTime(c.startMs / 1000, kept) * 1000,
    endMs: remapTime(c.endMs / 1000, kept) * 1000,
  }));

  check(
    "the first cue does not move",
    Math.abs(shifted[0].startMs) < 50,
    `${shifted[0].startMs.toFixed(0)} ms`,
  );
  check(
    "later cues move back by exactly what was removed before them",
    Math.abs(shifted[1].startMs - 2080) < 200 && Math.abs(shifted[2].startMs - 4160) < 300,
    JSON.stringify(shifted.map((s) => Math.round(s.startMs))),
  );
  check(
    "drift does not accumulate — the last cue is as accurate as the first",
    Math.abs(shifted[2].startMs - 4160) - Math.abs(shifted[1].startMs - 2080) < 200,
    "",
  );
  check("no cue is left with negative or zero length", shifted.every((s) => s.endMs > s.startMs), JSON.stringify(shifted));
}

console.log("\nCaptions land where the platform will not cover them");
{
  const frame = { width: 1080, height: 1920 };

  for (const platform of ["tiktok", "reels", "shorts"]) {
    const layout = captionLayout(frame, platform);
    const safe = safeAreaFor(platform);
    check(
      `${platform}: the caption sits above the app's own furniture`,
      layout.marginV > frame.height * safe.bottom,
      `${layout.marginV}px vs ${Math.round(frame.height * safe.bottom)}px reserved`,
    );
    check(
      `${platform}: and clear of the action rail`,
      layout.marginL >= frame.width * safe.rail,
      `${layout.marginL}px vs rail ${Math.round(frame.width * safe.rail)}px`,
    );
    check(
      `${platform}: a full-height caption still does not collide`,
      !collidesWithFurniture(layout, frame, platform, layout.maxLines),
      "",
    );
  }

  // The regression this whole module exists for.
  const old = { marginV: 180, fontSize: 72, marginL: 80, alignment: 2, maxLines: 2 };
  check(
    "the old fixed 180px margin is correctly judged unsafe",
    collidesWithFurniture(old, frame, "tiktok", 2),
    "",
  );

  // Size must follow the frame, or the same caption is unreadable small and
  // absurd large.
  const small = captionLayout({ width: 720, height: 1280 }, "tiktok");
  const large = captionLayout({ width: 2160, height: 3840 }, "tiktok");
  check(
    "caption size scales with the frame instead of being fixed",
    small.fontSize < 60 && large.fontSize > 120,
    `${small.fontSize} / ${large.fontSize}`,
  );
  check(
    "and the line length stays about the same however big the frame",
    Math.abs(small.maxCharsPerLine - large.maxCharsPerLine) <= 1,
    `${small.maxCharsPerLine} vs ${large.maxCharsPerLine}`,
  );
}

console.log("\nLines break where we chose, and never spill");
{
  const layout = captionLayout({ width: 1080, height: 1920 }, "tiktok");
  const [wrapped] = wrapToLayout(
    [{ startMs: 0, endMs: 2000, text: "this is a much longer caption than will ever fit on one single line of a phone screen" }],
    layout,
  );
  const lines = wrapped.text.split("\n");

  check("it uses no more lines than the frame allows", lines.length <= layout.maxLines, `${lines.length}`);
  check(
    "no line exceeds the usable width",
    lines.every((l) => l.replace("…", "").length <= layout.maxCharsPerLine),
    JSON.stringify(lines),
  );
  check("no word is split across lines", lines.every((l) => !/\w-$/.test(l)), JSON.stringify(lines));
  check("an overlong cue says it was cut rather than spilling silently", wrapped.text.endsWith("…"), wrapped.text);

  const [short] = wrapToLayout([{ startMs: 0, endMs: 1000, text: "short one" }], layout);
  check("a short cue is left alone", short.text === "short one", short.text);
}

console.log("\nPunches land on emphasis, not on filler");
{
  const words = [
    { text: "so", startMs: 0, endMs: 140, confidence: 1, filler: false },
    { text: "um", startMs: 150, endMs: 900, confidence: 1, filler: true },
    { text: "the", startMs: 950, endMs: 1090, confidence: 1, filler: false },
    { text: "thing", startMs: 1090, endMs: 1240, confidence: 1, filler: false },
    { text: "is", startMs: 1240, endMs: 1380, confidence: 1, filler: false },
    { text: "nobody", startMs: 2300, endMs: 3300, confidence: 1, filler: false },
    { text: "checks", startMs: 3300, endMs: 3460, confidence: 1, filler: false },
  ];
  const transcript = { segments: [{ startMs: 0, endMs: 3460, text: "", words }], language: null, source: "t" };
  const points = captionsMod.emphasisPoints(transcript);

  check("the stressed word is chosen", points.includes(2.3), JSON.stringify(points));
  check(
    "the long filler is not — a punch on 'um' is the tell of an automatic edit",
    !points.includes(0.15),
    JSON.stringify(points),
  );

  const out = await enrichMod.enrichPlan("unused.mp4", {
    version: 1,
    operations: [{ type: "zoomPunch", at: [], amount: 0.13, holdMs: 1000 }],
  }, {
    providers: { transcriber: { name: "stub", transcribe: async () => transcript }, sceneReader: null, status: { transcription: null, vision: null } },
  });
  check(
    "and the plan that reaches the renderer carries those exact points",
    JSON.stringify(out.plan.operations[0].at) === JSON.stringify(points),
    JSON.stringify(out.plan.operations[0]?.at),
  );
}

console.log("\nThe whole thing survives one pass");
{
  const clip = spokenClip("full", [[0, 2], [4, 6]], 6);
  const layout = captionLayout({ width: 1080, height: 1920 }, "tiktok");

  const { output, notes } = await renderPlan(
    clip,
    {
      version: 1,
      operations: [
        { type: "removeSilence", thresholdDb: -32, minSilenceMs: 500, paddingMs: 80 },
        { type: "formatForPlatform", platform: "tiktok" },
        { type: "burnCaptions", cues: [{ startMs: 0, endMs: 1800, text: "one" }, { startMs: 4000, endMs: 5800, text: "two" }], style: "bold-white", animation: "pop" },
        { type: "zoomPunch", at: [0.5], amount: 0.12, holdMs: 800 },
        { type: "normalizeLoudness", targetLufs: -14 },
        { type: "watermark", text: "Edited with Editly", position: "bottom-right" },
      ],
    },
    { workDir },
  );

  const info = await probeSource(output);
  check("the output is vertical", info.height > info.width, `${info.width}x${info.height}`);
  check("it is 9:16 to within a pixel", Math.abs(info.width / info.height - 9 / 16) < 0.01, `${(info.width / info.height).toFixed(4)}`);
  check("it still has audio", info.hasAudio, "");
  check("it is not empty", info.duration > 1, `${info.duration.toFixed(2)}s`);
  check("captions were burned, not skipped", notes.some((n) => /burned \d+ captions/.test(n)), JSON.stringify(notes));

  // Loudness is the one thing a viewer notices instantly when it is wrong.
  const loud = spawnSync("ffmpeg", [
    "-hide_banner", "-nostdin", "-i", output, "-af", "ebur128=peak=true", "-vn", "-f", "null", "-",
  ], { encoding: "utf8" }).stderr;
  const integrated = [...loud.matchAll(/I:\s+(-?[\d.]+)\s+LUFS/g)].map((m) => Number(m[1])).pop();
  check(
    "and it lands on the level every platform normalises to",
    integrated !== undefined && Math.abs(integrated - -14) < 2.5,
    `${integrated} LUFS`,
  );
}

console.log("\nThe subtitle file itself is well formed");
{
  const frame = { width: 1080, height: 1920 };
  const layout = captionLayout(frame, "tiktok");
  const file = at("check.ass");
  await writeSubtitleFile(
    file,
    [{ startMs: 0, endMs: 1500, text: "hello there", words: [{ startMs: 0, endMs: 700, text: "hello" }, { startMs: 700, endMs: 1500, text: "there" }] }],
    "karaoke-box",
    "karaoke",
    frame,
    layout,
  );
  const ass = await readFile(file, "utf8");

  check("the style row carries the computed margin, not a constant", ass.includes(`,${layout.marginV},`), "");
  check("and the computed size", ass.includes(`DejaVu Sans,${layout.fontSize},`), "");
  check("the play resolution matches the real frame", ass.includes(`PlayResX: ${frame.width}`), "");
  check("karaoke timing is per word, not per cue", (ass.match(/\\kf\d+/g) ?? []).length === 2, "");
  check("no unescaped braces leak into the text", !/[^\\]\{[^\\]/.test(ass.split("[Events]")[1] ?? ""), "");
}

await rm(workDir, { recursive: true, force: true });
await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("The edit that comes out is the edit we meant.");
