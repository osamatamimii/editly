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
const {
  captionLayout, safeAreaFor, collidesWithFurniture, nominalSizeFor, CAPTION_FACES, widthInCaps,
} = layoutMod;

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
    // Against the *frames* rather than against two numbers. The absolute
    // values are a function of whichever face is the Latin default, and the
    // day that face changed — 0.54 to 0.47 — this check went red about
    // nothing, on a product whose captions were still exactly the same size on
    // screen. What the layout promises is proportionality, so that is what is
    // asserted: three times the frame, about three times the nominal size.
    Math.abs(large.fontSize / small.fontSize - 3) < 0.15 && small.capHeight < large.capHeight,
    `${small.fontSize} at 720 wide, ${large.fontSize} at 2160 — ratio ${(large.fontSize / small.fontSize).toFixed(2)}`,
  );
  check(
    "and the line length stays about the same however big the frame",
    Math.abs(small.maxCharsPerLine - large.maxCharsPerLine) <= 1,
    `${small.maxCharsPerLine} vs ${large.maxCharsPerLine}`,
  );
}

/*
  The two estimates that decide a caption's shape have to be the same estimate.

  Grouping words into cues and wrapping a cue onto lines are separate steps
  with separate code, and each needs to answer "does this fit". If they answer
  differently the caption is cut short: the grouper packs a cue it believes is
  two lines, the wrapper draws three, the third is over the line limit, and it
  is truncated with an ellipsis. Nothing fails. The words are simply gone, and
  the only place the disagreement is visible is on the frame.

  It is capitals that pull them apart, because a character count cannot see
  that `W` is three and a half times the width of `i`.
*/
console.log("\nGrouping words and wrapping them agree about what fits");
{
  const layout = captionLayout({ width: 1080, height: 1920 }, "tiktok");
  const lineWidthInCaps = layout.usableWidth / layout.capHeight;

  const speak = (line) => {
    let at = 0;
    return {
      segments: [{
        startMs: 0,
        endMs: line.split(" ").length * 320,
        text: line,
        words: line.split(" ").map((text) => {
          const startMs = at;
          at += 320;
          return { text, startMs, endMs: at - 20, confidence: 0.95, filler: false };
        }),
      }],
      language: "en",
      source: "fixture",
    };
  };

  for (const [name, line] of [
    ["ordinary speech", "nobody tells you this but it completely changes how you edit every single video you make"],
    ["shouting", "WHAT NOBODY EVER TELLS YOU ABOUT MAKING VIDEOS THAT PEOPLE ACTUALLY WATCH ALL THE WAY"],
    ["Arabic", "لا أحد يخبرك بهذا لكنه يغير كل شيء عن الطريقة التي تحرر بها كل فيديو تصنعه"],
  ]) {
    const cues = captionsMod.buildCaptionCues(speak(line), {
      dropFillers: true,
      maxCharsPerLine: layout.maxCharsPerLine,
      lineWidthInCaps,
      maxLines: layout.maxLines,
    });
    const wrapped = wrapToLayout(cues, layout);
    check(
      `${name}: no cue is truncated between the grouping and the wrap`,
      wrapped.every((c) => !c.text.includes("\u2026")),
      // An ellipsis here is words thrown away by two estimates disagreeing,
      // not by a caption that was genuinely too long to show.
      JSON.stringify(wrapped.map((c) => c.text)),
    );
    check(
      `${name}: and none uses more lines than the frame allows`,
      wrapped.every((c) => c.text.split("\n").length <= layout.maxLines),
      JSON.stringify(wrapped.map((c) => c.text.split("\n").length)),
    );
  }
}

console.log("\nThe caption is drawn in the face it was sized for");
{
  const frame = { width: 1080, height: 1920 };
  const layout = captionLayout(frame, "tiktok");

  // The whole point of sizing by cap height: both faces draw a capital the
  // same height, so an Arabic line and an English line beside it match. Under
  // one nominal size they did not, and nothing anywhere said so.
  for (const [script, face] of Object.entries(CAPTION_FACES)) {
    const drawn = nominalSizeFor(face, layout) * face.capRatio;
    check(
      `${script}: a capital lands within a pixel of the height the layout asked for`,
      Math.abs(drawn - layout.capHeight) < 1,
      `${drawn.toFixed(2)} vs ${layout.capHeight.toFixed(2)}`,
    );
  }
  check(
    "the two faces are named differently, or one of them is not doing its job",
    CAPTION_FACES.latin.family !== CAPTION_FACES.arabic.family,
    "",
  );

  // The regression the font swap could have caused and nobody would have seen:
  // a heavier display face at the same nominal size draws smaller, so every
  // caption in the product shrinks by a sixth and no test fails.
  check(
    "the caption is the same size it was before any face changed",
    // A height in pixels, not a nominal size. It is the one number in this
    // area that is a *decision* rather than a measurement — 6.5% of the frame's
    // short side — and it has now survived two face changes and twelve faces
    // arriving. Every nominal size in the product is derived from it.
    Math.abs(layout.capHeight - 70 * 0.65) < 1.5,
    `cap ${layout.capHeight.toFixed(1)}px against the 70px DejaVu row's ${(70 * 0.65).toFixed(1)}px`,
  );

  // And the other half of it: the line breaks must not move either.
  check(
    "and line breaks land where they did, because the face is narrower in proportion",
    Math.abs(layout.maxCharsPerLine - 19) <= 1,
    `${layout.maxCharsPerLine} characters per line`,
  );
}

console.log("\nAn Arabic caption is drawn in a face that has Arabic in it");
{
  const frame = { width: 1080, height: 1920 };
  const file = at("rtl.ass");
  await writeSubtitleFile(
    file,
    [
      { startMs: 0, endMs: 1000, text: "hello there" },
      { startMs: 1000, endMs: 2000, text: "الفيديو جاهز" },
    ],
    "bold-white",
    "pop",
    frame,
  );
  const ass = await readFile(file, "utf8");
  const events = (ass.split("[Events]")[1] ?? "").split("\n").filter((l) => l.startsWith("Dialogue:"));

  check("both styles are declared", /Style: Cap,/.test(ass) && /Style: CapRtl,/.test(ass), "");
  check("the English line takes the Latin face", /,Cap,,/.test(events[0]), events[0]);
  check(
    "and the Arabic line takes the one with Arabic glyphs",
    /,CapRtl,,/.test(events[1]),
    // libass would have fallen back per glyph and drawn it — a fifth too
    // large, beside a Latin caption sized for a different face. Legible, and
    // wrong, and silent.
    events[1],
  );
  check(
    "the two rows carry different sizes, because the faces have different proportions",
    (() => {
      const rows = ass.split("\n").filter((l) => l.startsWith("Style: Cap"));
      const sizes = rows.map((r) => r.split(",")[2]);
      return sizes[0] !== sizes[1];
    })(),
    ass.split("\n").filter((l) => l.startsWith("Style: Cap")).join(" | "),
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
  const fits = (line) => widthInCaps(line.replace("…", "")) <= layout.usableWidth / layout.capHeight;
  check(
    "no line exceeds the usable width",
    lines.every(fits),
    // Measured, not counted. A character count is a fine estimate for prose
    // and a bad one for anything else, which is the next check.
    JSON.stringify(lines.map((l) => [l, widthInCaps(l).toFixed(1)])),
  );

  /*
    The line the character count could not see.

    `W` is 1.74 caps and `i` is 0.48 — three and a half times — so a line of
    capitals fits half the characters a line of ordinary speech does. Against a
    single average, this drew off both margins of the frame, and nothing said
    so: libass rewrapped it, which looked like the caption working and was in
    fact the renderer overruling the layout on every caption in the product.
  */
  const [shout] = wrapToLayout(
    [{ startMs: 0, endMs: 2000, text: "WHAT NOBODY EVER TELLS YOU ABOUT ANY OF THIS" }],
    layout,
  );
  check(
    "a line of capitals is broken on its width, not on its character count",
    shout.text.split("\n").every(fits),
    JSON.stringify(shout.text.split("\n").map((l) => [l, widthInCaps(l).toFixed(1)])),
  );
  check(
    "and it takes fewer characters per line than ordinary speech, because it is wider",
    Math.max(...shout.text.split("\n").map((l) => l.replace("…", "").length)) <
      Math.max(...lines.map((l) => l.replace("…", "").length)),
    `${JSON.stringify(shout.text.split("\n"))} vs ${JSON.stringify(lines)}`,
  );

  // And the opposite direction, which is the quiet one. Arabic joins, so its
  // letters are narrower than Latin — charging Latin widths for them would
  // break every Arabic caption early and truncate the tail with an ellipsis.
  const [arabic] = wrapToLayout(
    [{ startMs: 0, endMs: 2000, text: "لا أحد يخبرك بهذا لكنه يغير كل شيء عن الطريقة" }],
    layout,
  );
  check(
    "an Arabic line is not broken early for being Latin-wide",
    arabic.text.split("\n").every(fits) &&
      Math.max(...arabic.text.split("\n").map((l) => l.length)) > layout.maxCharsPerLine,
    JSON.stringify(arabic.text.split("\n").map((l) => [l.length, widthInCaps(l).toFixed(1)])),
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

console.log("\nThe vertical crop finds the subject instead of the middle");
{
  const framing = await import(bundle("artifacts/worker/src/framing.ts", "framing.mjs"));
  const { measureInterest, chooseCropCenter, cropOffsetX, coverScale, COLUMNS } = framing;

  /** Dark 16:9 frame with one bright square moving in place at `xFraction`. */
  function subjectClip(name, xFraction) {
    const out = at(`${name}.mp4`);
    const x = Math.round(1280 * xFraction) - 60;
    ff([
      "-f", "lavfi", "-i", "color=c=black:size=1280x720:rate=25:duration=5",
      "-vf", `drawbox=x=${x}:y='260+40*sin(t*3)':w=120:h=200:color=white@1:t=fill`,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", out,
    ]);
    return out;
  }

  const windowFraction = (720 * (9 / 16)) / 1280; // a 9:16 window out of 16:9

  for (const [where, fraction] of [["left", 0.18], ["right", 0.82], ["centre", 0.5]]) {
    const clip = subjectClip(`subject-${where}`, fraction);
    const choice = chooseCropCenter(await measureInterest(clip, 5), windowFraction);
    check(
      `a subject on the ${where} pulls the window to the ${where}`,
      Math.abs(choice.center - fraction) < 0.12,
      `chose ${choice.center.toFixed(2)}, subject at ${fraction}`,
    );
  }

  const flat = at("flat.mp4");
  ff([
    "-f", "lavfi", "-i", "color=c=gray:size=1280x720:rate=25:duration=4",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", flat,
  ]);
  const flatChoice = chooseCropCenter(await measureInterest(flat, 4), windowFraction);
  check(
    "a frame with nothing to say keeps the centre rather than inventing a subject",
    !flatChoice.moved && flatChoice.center === 0.5,
    JSON.stringify(flatChoice),
  );

  const empty = chooseCropCenter({ columns: new Array(COLUMNS).fill(0), frames: 0 }, windowFraction);
  check("and so does a measurement that produced nothing", empty.center === 0.5 && !empty.moved, "");

  // Offsets have to stay on the image, and on even pixels: an odd offset makes
  // the encoder resample the half-resolution chroma planes of 4:2:0.
  const scaled = 2000;
  const cropW = 1080;
  check(
    "the window never runs off the left edge",
    cropOffsetX({ center: 0.0, moved: true, advantage: 2 }, scaled, cropW) === 0,
    "",
  );
  check(
    "nor off the right",
    cropOffsetX({ center: 1.0, moved: true, advantage: 2 }, scaled, cropW) === scaled - cropW,
    "",
  );
  check(
    "and always lands on an even pixel",
    [0.13, 0.37, 0.61, 0.88].every((c) => cropOffsetX({ center: c, moved: true, advantage: 2 }, scaled, cropW) % 2 === 0),
    "",
  );
  check(
    "the cover scale matches what ffmpeg will apply",
    Math.abs(coverScale({ width: 1280, height: 720 }, { width: 1080, height: 1920 }) - 1920 / 720) < 1e-9,
    "",
  );

  // The proof: a subject a centre crop would miss entirely.
  const offCentre = subjectClip("off-centre-source", 0.14);
  const { output, notes } = await renderPlan(
    offCentre,
    { version: 1, operations: [{ type: "formatForPlatform", platform: "tiktok" }] },
    { workDir },
  );

  const stats = spawnSync("ffmpeg", [
    "-hide_banner", "-nostdin", "-i", output,
    "-vf", "fps=2,signalstats,metadata=print:file=-", "-an", "-f", "null", "-",
  ], { encoding: "utf8" });
  const luma = [...`${stats.stdout}${stats.stderr}`.matchAll(/YAVG=([\d.]+)/g)].map((m) => Number(m[1]));
  const brightest = luma.length ? Math.max(...luma) : 0;

  check("it says it framed on the subject", notes.some((n) => /framed on the subject/.test(n)), JSON.stringify(notes));
  check(
    "and the subject is really in the delivered frame, not cropped away",
    brightest > 20,
    `brightest sampled frame ${brightest.toFixed(1)} of 255`,
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
  check(
    "captions are drawn in the caption face, not in whatever the base image had",
    ass.includes(`Style: Cap,Montserrat Black,${layout.fontSize},`),
    ass.split("[Events]")[0].split("\n").filter((l) => l.startsWith("Style:")).join(" | "),
  );
  check("the play resolution matches the real frame", ass.includes(`PlayResX: ${frame.width}`), "");
  check("karaoke timing is per word, not per cue", (ass.match(/\\kf\d+/g) ?? []).length === 2, "");
  check("no unescaped braces leak into the text", !/[^\\]\{[^\\]/.test(ass.split("[Events]")[1] ?? ""), "");
}

/*
  The captions, as pixels.

  Everything above this reads the file the renderer wrote. A subtitle file can
  be perfectly correct and still draw something else, because libass has
  opinions — and it had one: `WrapStyle: 0` re-decided every line break the
  layout had chosen, so a three-line caption drew as four and a karaoke caption
  drew as five. Nothing failed. The captions were legible, correctly timed and
  correctly coloured, in a block a third taller than the one checked against
  the platform's safe area — so the collision test passed on three lines while
  five climbed over the speaker's face.

  No amount of reading the file finds that. This section renders the file and
  counts the ink: how many rows of it there are, and where its edges land.
*/
console.log("\nAnd what libass actually draws");
{
  const frame = { width: 1080, height: 1920 };
  const layout = captionLayout(frame, "tiktok");

  const drawn = (text, style, animation, words) => {
    const file = at(`draw-${animation}-${Math.random().toString(36).slice(2, 7)}.ass`);
    const cue = { startMs: 0, endMs: 3000, text, ...(words ? { words } : {}) };
    return writeSubtitleFile(file, wrapToLayout([cue], layout), style, animation, frame, layout).then(
      () => {
        const png = file.replace(/\.ass$/, ".png");
        ff([
          // Three seconds, and the frame taken at 1.2 — after `\fad` has
          // finished bringing the caption in and after the `pop` overshoot has
          // settled. A one-second source with `-ss 1.2` seeks past the end and
          // writes an empty file, which measures as a caption that drew
          // nothing: the same false pass this whole section exists to remove.
          "-f", "lavfi", "-i", `color=c=black:s=${frame.width}x${frame.height}:d=3`,
          "-vf", `subtitles=${file}`, "-ss", "1.2", "-frames:v", "1", png,
        ]);
        /*
          The whole frame, in grey, measured pixel by pixel.

          The first version of this squeezed the image to one column with area
          averaging and thresholded the result, which is what the worker's own
          Dockerfile does to prove its font is installed. It is the wrong tool
          here: averaging a row across 1080 pixels turns a line of short
          letters into a number below the floor, so one caption line measured
          as two segments and the check failed on a frame that was correct. A
          measurement that is noisy in the direction of "found a bug" is worse
          than no measurement, because it teaches whoever reads it to ignore it.

          Two megabytes of grey and a loop is exact, and this suite renders
          real video anyway.
        */
        const grey = spawnSync("ffmpeg", [
          "-v", "error", "-i", png, "-vf", "format=gray", "-frames:v", "1", "-f", "rawvideo", "-",
        ], { maxBuffer: 1 << 26 }).stdout;

        const width = frame.width;
        const height = frame.height;
        let lines = 0;
        let previous = false;
        let top = -1;
        let bottom = -1;
        let left = width;
        let right = -1;
        for (let y = 0; y < height; y += 1) {
          let inked = false;
          const row = y * width;
          for (let x = 0; x < width; x += 1) {
            // 40 of 255. Above the shadow and the anti-aliased fringe, well
            // below the stroke of a letter.
            if (grey[row + x] > 40) {
              inked = true;
              if (x < left) left = x;
              if (x > right) right = x;
            }
          }
          if (inked && !previous) lines += 1;
          if (inked) {
            if (top < 0) top = y;
            bottom = y;
          }
          previous = inked;
        }
        if (right < 0) left = -1;

        return { lines, top, bottom, left, right };
      },
    );
  };

  const speech = "nobody tells you this but it changes everything";
  const perWord = speech.split(" ").map((text, i) => ({
    text, startMs: i * 340, endMs: (i + 1) * 340,
  }));

  const planned = wrapToLayout([{ startMs: 0, endMs: 3000, text: speech }], layout).length;
  const plannedLines = wrapToLayout(
    [{ startMs: 0, endMs: 3000, text: speech }],
    layout,
  )[0].text.split("\n").length;

  for (const [name, animation, words] of [
    ["a plain caption", "none", null],
    ["a caption that pops", "pop", null],
    ["a caption timed to the voice", "karaoke", perWord],
  ]) {
    const ink = await drawn(speech, "bold-white", animation, words);
    check(
      `${name}: draws the number of lines the layout planned`,
      ink.lines === plannedLines,
      // The renderer adding a line is not a rendering detail: it is the layout
      // being overruled, on the one screen it was written to protect.
      `${ink.lines} drawn against ${plannedLines} planned`,
    );
    check(
      `${name}: and stays inside the margins it was given`,
      ink.left >= layout.marginL - 2 && ink.right <= frame.width - layout.marginR + 2,
      `${ink.left}..${ink.right} against ${layout.marginL}..${frame.width - layout.marginR}`,
    );
    check(
      `${name}: and clear of the platform's furniture`,
      ink.bottom > 0 && frame.height - ink.bottom >= frame.height * safeAreaFor("tiktok").bottom - 2,
      `${frame.height - ink.bottom}px of clearance, ${Math.round(frame.height * safeAreaFor("tiktok").bottom)} reserved`,
    );
  }
  void planned;

  // The case the character count could not see, measured where it matters.
  const shout = await drawn("WHAT NOBODY EVER TELLS YOU ABOUT THIS", "bold-white", "none", null);
  check(
    "a line of capitals is drawn inside the margins too",
    shout.left >= layout.marginL - 2 && shout.right <= frame.width - layout.marginR + 2,
    `${shout.left}..${shout.right} against ${layout.marginL}..${frame.width - layout.marginR}`,
  );

  const arabic = await drawn("لا أحد يخبرك بهذا لكنه يغير كل شيء", "bold-white", "none", null);
  check(
    "and so is an Arabic one, in the face that has Arabic in it",
    arabic.left >= layout.marginL - 2 &&
      arabic.right <= frame.width - layout.marginR + 2 &&
      arabic.lines > 0,
    `${arabic.left}..${arabic.right}, ${arabic.lines} lines`,
  );

  /*
    And the two scripts come out the same size, which is the only thing
    `capRatio` exists to guarantee and the one thing nothing else measures.

    Every other check on it is arithmetic — `nominalSizeFor(face) * capRatio`
    equals the height the layout asked for, which is true by construction
    whatever number is in the field. What makes the number right or wrong is
    the *font*, and the only way to ask a font is to draw with it.

    This is not a hypothetical. The Arabic face moved from DejaVu Sans to Cairo
    Black, and their ratios are 0.66 and 0.38 — the same 46-pixel target
    produces a nominal size of 70 for one and 121 for the other. Carrying the
    old number over would have rendered every Arabic caption at 58% of its
    intended size: perfectly legible, obviously wrong to anybody who looked,
    and green in every check in this repository.

    One line each, so the measurement is a single band of ink. Six pixels of
    tolerance, because a capital H and an alef are different shapes and neither
    is trying to be the other.
  */
  const latinBand = await drawn("HANDLING", "bold-white", "none", null);
  const arabicBand = await drawn("االاالاا", "bold-white", "none", null);
  const latinHeight = latinBand.bottom - latinBand.top;
  const arabicHeight = arabicBand.bottom - arabicBand.top;
  check(
    "the Latin face draws at the height the layout asked for",
    Math.abs(latinHeight - layout.capHeight) <= 6,
    `${latinHeight}px drawn against ${layout.capHeight.toFixed(1)} asked`,
  );
  check(
    "and the Arabic face draws at the same height, which is what capRatio is for",
    Math.abs(arabicHeight - layout.capHeight) <= 6,
    // Wrong here means every Arabic caption in the product is the wrong size,
    // with nothing failing anywhere.
    `${arabicHeight}px drawn against ${layout.capHeight.toFixed(1)} asked`,
  );
  check(
    "so the two scripts match each other on screen",
    Math.abs(latinHeight - arabicHeight) <= 6,
    `Latin ${latinHeight}px, Arabic ${arabicHeight}px`,
  );

  /*
    The box, and which way the colour runs.

    Two things that are invisible on a dark test frame and decide whether a
    caption is readable on a real one.

    `karaoke-box` had `Outline: 0`, and with BorderStyle 3 the outline width
    *is* the box's padding — so the style called "box" had never drawn a box.
    Over anything dark that is fine and looks deliberate; over a beige wall or
    a bright sky it is white text on a light ground, which is the one thing an
    opaque backing exists to prevent. So it is measured over a light frame.

    And the wipe ran backwards. With `\kf` the words already spoken take the
    *primary* colour and the ones still to come take the secondary, and this
    style had the loud colour on the secondary — so the yellow sat on the part
    of the line nobody had said yet, the eye was pulled ahead of the voice, and
    the colour drained out of the sentence as it was read. A legible caption
    with its two colours the other way round, which nothing but a person
    watching it could have called wrong. Counting the coloured pixels at two
    moments says which way it runs.
  */
  const spoken = "nobody tells you this but it changes everything";
  const perWordBox = spoken.split(" ").map((text, i) => ({
    text, startMs: i * 340, endMs: (i + 1) * 340,
  }));
  const boxFile = at("box.ass");
  await writeSubtitleFile(
    boxFile,
    wrapToLayout([{ startMs: 0, endMs: 3000, text: spoken, words: perWordBox }], layout),
    "karaoke-box",
    "karaoke",
    frame,
    layout,
  );

  const swatch = (seconds, tag) => {
    const png = at(`box-${tag}.png`);
    ff([
      // A light ground, because that is where an opaque backing earns its keep.
      "-f", "lavfi", "-i", `color=c=0xd8d0c0:s=${frame.width}x${frame.height}:d=3`,
      "-vf", `subtitles=${boxFile}`, "-ss", String(seconds), "-frames:v", "1", png,
    ]);
    const rgb = spawnSync("ffmpeg", [
      "-v", "error", "-i", png, "-vf", "format=rgb24", "-frames:v", "1", "-f", "rawvideo", "-",
    ], { maxBuffer: 1 << 26 }).stdout;
    let dark = 0;
    let warm = 0;
    for (let i = 0; i < rgb.length; i += 3) {
      const r = rgb[i];
      const g = rgb[i + 1];
      const b = rgb[i + 2];
      if (r < 60 && g < 60 && b < 60) dark += 1;
      // The highlight is &H0000E5FF: full red, 229 green, no blue.
      if (r > 180 && g > 140 && b < 90) warm += 1;
    }
    return { dark, warm };
  };

  const early = swatch(0.5, "early");
  const late = swatch(2.5, "late");

  check(
    "the box style draws a box, so a caption over a bright shot is still readable",
    early.dark > 20000,
    // Zero here is the state it shipped in: BorderStyle 3 with no padding.
    `${early.dark} dark pixels behind the words`,
  );
  check(
    "and the colour fills the line as it is spoken rather than draining out of it",
    late.warm > early.warm * 1.5,
    `${early.warm} coloured pixels at 0.5s against ${late.warm} at 2.5s`,
  );
}

await rm(workDir, { recursive: true, force: true });
await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("The edit that comes out is the edit we meant.");
