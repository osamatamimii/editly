/**
 * Proves the motion engine is an engine.
 *
 * Two properties, and only the second is interesting.
 *
 * The easy one: a title puts pixels on the frame while it is on, and none once
 * it is off.
 *
 * The one that matters: **rendering the same scene twice produces the same
 * bytes.** Motion that does not repeat exactly is a screen recording — it looks
 * fine once and cannot be re-exported, retimed, or trusted in a template. The
 * whole design of this renderer (pause every animation, seek by hand, never
 * play) exists to make that true, so it is the thing to assert.
 *
 * Usage: node tools/motion-test.mjs
 * Requires: ffmpeg, and a Chromium that playwright-core can launch. Without one
 * the suite says so and passes the checks that do not need it, because "this
 * laptop has no browser" is not a defect in the renderer.
 */
import { mkdtemp, mkdir, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { order } from "./lib/order.mjs";
import { existsSync, readdirSync } from "node:fs";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-motion-test-"));
/**
 * The bundle is written inside the worker package, not into the temp dir.
 *
 * Node resolves a bare specifier by walking up from the *importing file*, so a
 * bundle sitting in /tmp can never find `playwright` however it is installed —
 * and `renderMotionLayer` answers a missing driver by returning null, which is
 * a legitimate result. The two together meant every render check silently
 * skipped itself and the suite reported all-green while testing none of it.
 */
const moduleDir = path.join(repoRoot, "artifacts/worker/.motion-test");
await mkdir(moduleDir, { recursive: true });
const modulePath = path.join(moduleDir, "motion.mjs");

const esbuild = spawnSync(
  require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/worker"] }),
  [
    path.join(repoRoot, "artifacts/worker/src/motion.ts"),
    "--bundle", "--platform=node", "--format=esm", "--target=node22",
    "--external:playwright-core", "--external:playwright",
    `--outfile=${modulePath}`, "--log-level=error",
  ],
  { stdio: "inherit" },
);
if (esbuild.status !== 0) {
  console.error("could not bundle the motion module");
  process.exit(1);
}
/**
 * Point the module at a browser this machine actually has.
 *
 * `renderMotionLayer` answers a missing browser with null — correct in
 * production, where a missing browser must cost the titles and not the render,
 * and quietly fatal in a test, where it turns every render check into a skip.
 * Some sandboxes preinstall Chromium under PLAYWRIGHT_BROWSERS_PATH and forbid
 * the download, and the preinstalled build rarely matches the version
 * Playwright expects — so the binary is found by pattern and handed over
 * explicitly, exactly as browser-test does.
 */
function findChromium() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !existsSync(root)) return undefined;
  for (const dir of readdirSync(root)) {
    if (!/^chromium-\d+$/.test(dir)) continue;
    const candidate = path.join(root, dir, "chrome-linux", "chrome");
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}
if (!process.env.CHROMIUM_PATH) {
  const found = findChromium();
  if (found) process.env.CHROMIUM_PATH = found;
}

const { spring, sceneHtml, renderMotionLayer, wordsOf, staggerFor, entranceCss, elevation, STAGGER_S, safeColor, safeAssetUrl, deviceScreenBox } = await import(pathToFileURL(modulePath).href);

// The renderer too, because the cost of the layer is decided at its call site:
// the module draws whatever window it is given, and the bug was in what it was
// given.
/*
  Beside the other bundle, and for the reason this file's own header gives.

  `motion.ts` was moved out of /tmp because Node resolves a bare specifier by
  walking up from the *importing file*, so a bundle in a temp directory can
  never find `playwright` however it is installed. The render bundle — which
  reaches the same `import("playwright")` through `renderPlan` — was left
  behind in /tmp, so the half of this suite that exercises titles through a
  real render could not load a browser on any machine. `renderMotionLayer`
  answers a missing driver with null, the render writes "could not render the
  titles here", and `work/motion` is never created: the checks below it fail
  on a missing directory and say nothing about titles.
*/
const renderModulePath = path.join(moduleDir, "ffmpeg.mjs");
spawnSync(
  require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/worker"] }),
  [
    path.join(process.cwd(), "artifacts/worker/src/ffmpeg.ts"),
    "--bundle", "--platform=node", "--format=esm", "--target=node22",
    `--outfile=${renderModulePath}`, "--log-level=error",
  ],
  { stdio: "inherit" },
);
const { renderPlan } = await import(pathToFileURL(renderModulePath).href);

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

console.log("\nThe curve");
{
  const curve = spring();
  const values = curve.slice("linear(".length, -1).split(",").map(Number);
  check("starts at rest", Math.abs(values[0]) < 1e-9, String(values[0]));
  check("ends exactly at its target", values[values.length - 1] === 1, String(values[values.length - 1]));
  // The point of a spring: it goes past where it is going, then comes back. A
  // curve that never exceeds 1 is an ease, and an ease is what we already had.
  check("overshoots on the way", Math.max(...values) > 1.02, `peak ${Math.max(...values).toFixed(3)}`);
  check("settles rather than ringing forever", Math.abs(values.at(-5) - 1) < 0.02, String(values.at(-5)));
}

console.log("\nThe scene");
{
  const html = sceneHtml({
    width: 1080, height: 1920, fps: 30, durationSeconds: 3,
    titles: [{ text: 'Hello & <world>', at: 0.5, durationSeconds: 2, style: "card", position: "center" }],
  });
  check("is a whole document", html.startsWith("<!doctype html>"));
  check("carries the spring, not a bezier", html.includes("linear(") && !html.includes("cubic-bezier"));
  check("escapes the text instead of trusting it", html.includes("Hello &amp; &lt;world&gt;") && !html.includes("<world>"));
  check("paints on nothing", html.includes("background:transparent"));
  // The title is the one piece of the person's own language that gets *burned
  // into the file*, where they cannot fix it afterwards. `dir="auto"` is the
  // same answer the editor gives, and for the same reason: the browser reads
  // the first strong character, which is a better rule than one we would write.
  check("lets the title work out its own direction", html.includes('dir="auto"'));
}

/**
 * Words that arrive as words.
 *
 * `word` is the style the schema describes as words animating onto the screen,
 * and it is what the model is told to choose when somebody asks for kinetic
 * text. It rendered the whole string as one slab on the same curve as a card.
 * Nothing failed — frames had ink, the export played — and the only thing wrong
 * was that the feature named after words did not treat them as words.
 *
 * The source checks below are the cheap half. The half worth having is further
 * down, in pixels: that the line fills in over time, and that it fills in from
 * the correct end for its language.
 */
console.log("\nA kinetic line arrives a word at a time");
{
  check("a line is split on whitespace, and nothing smaller", JSON.stringify(wordsOf("  Ship  it   now ")) === JSON.stringify(["Ship", "it", "now"]), JSON.stringify(wordsOf("  Ship  it   now ")));
  check("and an empty line is no words rather than one empty one", wordsOf("   ").length === 0);

  const kinetic = sceneHtml({
    width: 1080, height: 1920, fps: 30, durationSeconds: 4,
    titles: [{ text: "one two three", at: 1, durationSeconds: 2, style: "word", position: "center" }],
  });
  const delays = [...kinetic.matchAll(/animation-delay:([\d.]+)s/g)].map((m) => Number(m[1]));
  check("one piece per word", delays.length === 3, JSON.stringify(delays));
  check("the first arrives when the title does", delays[0] === 1, String(delays[0]));
  check(
    "and each one after it, later than the one before",
    delays.every((d, i) => i === 0 || d > delays[i - 1]),
    JSON.stringify(delays),
  );
  check("the words are still escaped, not trusted", sceneHtml({
    width: 100, height: 100, fps: 30, durationSeconds: 2,
    titles: [{ text: "a <b> c", at: 0, durationSeconds: 1, style: "word", position: "center" }],
  }).includes("&lt;b&gt;"));

  // A single word has nothing to stagger, so it must take the path it always
  // took — otherwise this round changes the emoji sticker and the one-word
  // emphasis title for no reason at all.
  const single = sceneHtml({
    width: 1080, height: 1920, fps: 30, durationSeconds: 4,
    titles: [{ text: "Ship", at: 1, durationSeconds: 2, style: "word", position: "center" }],
  });
  check("one word is still one block", !single.includes("<i "), "a lone word has nothing to stagger against");

  const card = sceneHtml({
    width: 1080, height: 1920, fps: 30, durationSeconds: 4,
    titles: [{ text: "one two three", at: 1, durationSeconds: 2, style: "card", position: "center" }],
  });
  check("and a card is a card — the other styles are untouched", !card.includes("<i "));

  /**
   * The compression, which is the part that would never be noticed.
   *
   * Twelve words at a fixed 0.11s are still arriving 1.2s in. A two-second
   * title starts fading at 2s, so the last words would land into a fade — words
   * that are on screen and unreadable, in a file nobody re-renders.
   */
  const many = sceneHtml({
    width: 1080, height: 1920, fps: 30, durationSeconds: 6,
    titles: [{
      text: "one two three four five six seven eight nine ten eleven twelve",
      at: 0, durationSeconds: 2, style: "word", position: "center",
    }],
  });
  const late = [...many.matchAll(/animation-delay:([\d.]+)s/g)].map((m) => Number(m[1]));
  check("twelve words all land in the first half of the title", Math.max(...late) <= 1.001, `last word at ${Math.max(...late)}s of a 2s title`);
}

console.log("\nRendering");
const outA = await mkdtemp(path.join(tmpdir(), "editly-motion-a-"));
const outB = await mkdtemp(path.join(tmpdir(), "editly-motion-b-"));
const scene = {
  width: 480, height: 854, fps: 25, durationSeconds: 1.2,
  titles: [{ text: "Ship it", at: 0.2, durationSeconds: 0.6, style: "card", position: "center" }],
};

const first = await renderMotionLayer(scene, outA);
if (!first) {
  console.log("  · no browser here, so the render checks are skipped (not failed)");
} else {
  check("produced a frame sequence", first.frames > 0, `${first.frames} frames`);

  const framesA = (await readdir(outA)).filter((f) => f.endsWith(".png")).sort();
  check("one file per sample", framesA.length === first.frames, `${framesA.length} files`);

  // Determinism: the same scene, rendered again into a different directory.
  const second = await renderMotionLayer(scene, outB);
  const framesB = (await readdir(outB)).filter((f) => f.endsWith(".png")).sort();
  const digest = async (dir, files) => {
    const h = createHash("sha256");
    for (const f of files) h.update(await readFile(path.join(dir, f)));
    return h.digest("hex");
  };
  const a = await digest(outA, framesA);
  const b = await digest(outB, framesB);
  check("the same scene renders to the same bytes", a === b, `${a.slice(0, 12)} vs ${b.slice(0, 12)}`);

  // And it is actually animating: a frame during the title must differ from one
  // before it. Identical frames would mean time is not moving.
  const early = await readFile(path.join(outA, framesA[0]));
  const mid = await readFile(path.join(outA, framesA[Math.floor(framesA.length / 2)]));
  check("frames differ over time", !early.equals(mid), "frame 0 and the middle frame are identical");
}

/**
 * The titles read in the direction of their language.
 *
 * A title is user text laid into the frame permanently, and until this round
 * the page had no direction at all — so Chromium laid every line out left to
 * right. A wholly Arabic title survived that, because its own letters carry
 * their direction. What did not survive is everything with no direction of its
 * own: the full stop, the question mark, the ellipsis. «٥ أسرار للنجاح!» came
 * out with the bang four fifths of the way across the line, at the wrong end,
 * in an exported file.
 *
 * So the measurement is a *comparison between the two languages*, not an
 * absolute position. The same shape of string — a run of tall strokes followed
 * by an ellipsis — must lean opposite ways in Arabic and in English. Under the
 * old behaviour both leaned the same way, which is precisely the failure, and
 * no single-language check could see it.
 */
console.log("\nThe titles read in the direction of their language");
if (!first) {
  console.log("  · no browser here, so the direction checks are skipped (not failed)");
} else {
  const outC = await mkdtemp(path.join(tmpdir(), "editly-motion-dir-"));
  // Tall strokes on one side, a small neutral mark on the other. Alef and I are
  // both bare vertical strokes, so the two languages weigh the same and the
  // only thing being compared is which end each one is drawn at.
  const heavyThenDots = { arabic: "ااااااااا…", latin: "IIIIIIIII…", overridden: "\u202Dااااااااا…" };

  const leanOf = async (text, name) => {
    const dir = path.join(outC, name);
    const layer = await renderMotionLayer(
      {
        width: 540, height: 960, fps: 25, durationSeconds: 1,
        titles: [{ text, at: 0.05, durationSeconds: 0.9, style: "card", position: "center" }],
      },
      dir,
    );
    // Well after the spring has settled and well before the title fades.
    const frames = (await readdir(dir)).filter((f) => f.endsWith(".png")).sort();
    const frame = path.join(dir, frames[Math.floor(frames.length * 0.6)]);
    // The frames are transparent, so every unpainted pixel is already black and
    // the ink is whatever is above it. Halves rather than coordinates: this
    // survives a font change, a size change and a layout change, and a check
    // pinned to a pixel column survives none of them.
    const ink = (crop) => {
      const r = spawnSync(
        "ffprobe",
        ["-v", "error", "-f", "lavfi", "-i", `movie=${frame},crop=${crop},signalstats`,
         "-show_entries", "frame_tags=lavfi.signalstats.YAVG", "-of", "default=nw=1:nk=1"],
        { encoding: "utf8" },
      );
      return Number(r.stdout.trim().split("\n")[0]);
    };
    const left = ink("iw/2:ih:0:0");
    const right = ink("iw/2:ih:iw/2:0");
    return { leansRight: right > left, left, right, layer };
  };

  const ar = await leanOf(heavyThenDots.arabic, "ar");
  const en = await leanOf(heavyThenDots.latin, "en");

  check(
    "an Arabic title's ellipsis ends the sentence, so the weight sits on the right",
    ar.leansRight,
    `left ${ar.left.toFixed(4)}, right ${ar.right.toFixed(4)}`,
  );
  check(
    "the same shape in English leans the other way — the direction follows the language",
    !en.leansRight,
    `left ${en.left.toFixed(4)}, right ${en.right.toFixed(4)} — the same lean in both languages means neither is being read`,
  );

  // The control, and the reason the pair above is worth anything: a left-to-
  // right override in front of the Arabic reproduces exactly what a page with
  // no direction did, and the lean goes back the other way. Without this both
  // checks could be satisfied by a browser that happened to centre the ink.
  const forced = await leanOf(heavyThenDots.overridden, "forced");
  check(
    "and Arabic forced left-to-right leans like English — so that is what is being read",
    !forced.leansRight,
    `left ${forced.left.toFixed(4)}, right ${forced.right.toFixed(4)}`,
  );

  await rm(outC, { recursive: true, force: true });
}

/**
 * And the words arrive from the end the language starts at.
 *
 * The source checks above prove three delays were written into a stylesheet.
 * They cannot prove the line fills in, and they especially cannot prove it
 * fills in from the correct side — which is the half of kinetic type that is
 * invisible to anyone who only reads English. Arabic runs right to left, so the
 * first word of an Arabic line lands on the **right**; the same three-word
 * line in English lands on the left. Nothing in this module decides that: the
 * words are atomic inlines, which the bidi algorithm orders in the paragraph's
 * own direction, and the paragraph gets its direction from `dir="auto"`.
 *
 * Measured as a comparison between the two languages, for the reason the
 * direction section gives: an absolute position is a claim about a font, and
 * this is a claim about reading order.
 */
console.log("\nAnd it fills in from the end its language starts at");
if (!first) {
  console.log("  · no browser here, so the kinetic render checks are skipped (not failed)");
} else {
  const outK = await mkdtemp(path.join(tmpdir(), "editly-motion-kinetic-"));
  const AT = 0.4;
  const ink = (frame, crop) => {
    const r = spawnSync(
      "ffprobe",
      ["-v", "error", "-f", "lavfi", "-i", `movie=${frame},crop=${crop},signalstats`,
       "-show_entries", "frame_tags=lavfi.signalstats.YAVG", "-of", "default=nw=1:nk=1"],
      { encoding: "utf8" },
    );
    return Number(r.stdout.trim().split("\n")[0]);
  };

  // 100 samples a second (25fps × 4 subsamples), so a frame index is a
  // hundredth of a second and the two moments below are exact.
  const at = async (text, name) => {
    const dir = path.join(outK, name);
    const layer = await renderMotionLayer(
      {
        // Wide and short on purpose: the title size is a fraction of the
        // frame *height*, so a tall frame makes three words wrap onto three
        // centred lines — and three centred lines weigh the same on both
        // halves whatever order they are in, which would make this whole
        // section pass without reading anything.
        width: 1280, height: 360, fps: 25, durationSeconds: 1.6,
        titles: [{ text, at: AT, durationSeconds: 2.4, style: "word", position: "center" }],
      },
      dir,
    );
    const frames = (await readdir(dir)).filter((f) => f.endsWith(".png")).sort();
    const frameAt = (seconds) => path.join(dir, frames[Math.round(seconds * layer.fps)]);
    // 90ms after the first word is asked for and 20ms before the second is:
    // the spring has settled — it reaches its target in about a tenth of a
    // second — so this is one word on screen and two not yet.
    const alone = frameAt(AT + 0.09);
    const whole = frameAt(AT + 0.9);
    return {
      firstLeft: ink(alone, "iw/2:ih:0:0"),
      firstRight: ink(alone, "iw/2:ih:iw/2:0"),
      inkAlone: ink(alone, "iw:ih:0:0"),
      inkWhole: ink(whole, "iw:ih:0:0"),
    };
  };

  const en = await at("one two three", "en");
  const ar = await at("واحد اثنان ثلاثة", "ar");
  /**
   * The control: the same Arabic, read left to right.
   *
   * A left-to-right mark is zero width and strongly directional, so `dir="auto"`
   * reads it as the first strong character and lays the paragraph out the other
   * way. Nothing visible changes and every word is identical — only the reading
   * order does — which is exactly the failure this section is here to catch: a
   * line whose words arrive in DOM order rather than in the order they are read.
   * Without it, "Arabic leans right" could be satisfied by a browser that
   * happened to put more ink on the right.
   */
  const forced = await at("\u200Eواحد اثنان ثلاثة", "forced");

  // A transparent frame is already black, and black is 16 on this scale — not
  // zero. Comparing the raw averages would be comparing 16.8 with 18.9 and
  // calling a threefold difference in ink a twelve per cent one.
  const BLACK = 16;
  check(
    "one word is on screen before the others are",
    en.inkAlone - BLACK > 0.1 && en.inkWhole - BLACK > (en.inkAlone - BLACK) * 2,
    `${(en.inkAlone - BLACK).toFixed(4)} of ink, then ${(en.inkWhole - BLACK).toFixed(4)} — no growth means every word arrived at once`,
  );
  check(
    "an English line starts filling in from the left",
    en.firstLeft > en.firstRight,
    `left ${en.firstLeft.toFixed(4)}, right ${en.firstRight.toFixed(4)}`,
  );
  check(
    "and an Arabic line from the right, because that is where its first word is",
    ar.firstRight > ar.firstLeft,
    `left ${ar.firstLeft.toFixed(4)}, right ${ar.firstRight.toFixed(4)} — the same side as English means the words are in DOM order, not reading order`,
  );
  check(
    "and the same Arabic forced left-to-right starts from the left — so that is what is being read",
    forced.firstLeft > forced.firstRight,
    `left ${forced.firstLeft.toFixed(4)}, right ${forced.firstRight.toFixed(4)}`,
  );

  // Kinetic titles are the busiest thing this module renders — one animation
  // per word rather than one per title — so the property the whole file exists
  // for is asserted again on that path rather than assumed to carry over.
  const again = path.join(outK, "en-again");
  await renderMotionLayer(
    {
      width: 1280, height: 360, fps: 25, durationSeconds: 1.6,
      titles: [{ text: "one two three", at: AT, durationSeconds: 2.4, style: "word", position: "center" }],
    },
    again,
  );
  const digestOf = async (dir) => {
    const h = createHash("sha256");
    for (const f of (await readdir(dir)).filter((f) => f.endsWith(".png")).sort()) {
      h.update(await readFile(path.join(dir, f)));
    }
    return h.digest("hex");
  };
  const one = await digestOf(path.join(outK, "en"));
  const two = await digestOf(again);
  check("a kinetic line renders to the same bytes twice", one === two, `${one.slice(0, 12)} vs ${two.slice(0, 12)}`);

  await rm(outK, { recursive: true, force: true });
}

/**
 * An emoji is a picture, and a picture has colour.
 *
 * Emojis left the "cannot yet" list this round, and the thing that can go
 * wrong is not the placing — it is that a font with no colour glyph draws an
 * empty box instead. The render succeeds, the frame has ink on it, the file
 * plays, and the sticker somebody asked for is a rectangle. Same silent shape
 * as a missing Arabic font, one layer along, and neither ffmpeg's drawtext nor
 * libass can draw these at all: emojis exist because the titles go through a
 * browser.
 *
 * Saturation is the whole difference between a picture and a glyph. White text
 * on a transparent frame has none, which is what makes the number mean
 * something — so the plain word is measured too, and must come back at zero.
 */
console.log("\nAn emoji draws as a picture, not as a box");
if (!first) {
  console.log("  · no browser here, so the emoji checks are skipped (not failed)");
} else {
  const outE = await mkdtemp(path.join(tmpdir(), "editly-motion-emoji-"));

  const saturationOf = async (text, name) => {
    const dir = path.join(outE, name);
    await renderMotionLayer(
      {
        width: 540, height: 960, fps: 25, durationSeconds: 1,
        titles: [{ text, at: 0.05, durationSeconds: 0.9, style: "word", position: "center" }],
      },
      dir,
    );
    const frames = (await readdir(dir)).filter((f) => f.endsWith(".png")).sort();
    const frame = path.join(dir, frames[Math.floor(frames.length * 0.6)]);
    const r = spawnSync(
      "ffprobe",
      ["-v", "error", "-f", "lavfi", "-i", `movie=${frame},signalstats`,
       "-show_entries", "frame_tags=lavfi.signalstats.SATAVG", "-of", "default=nw=1:nk=1"],
      { encoding: "utf8" },
    );
    return Number(r.stdout.trim().split("\n")[0]);
  };

  const fire = await saturationOf("\u{1F525}", "fire");
  const words = await saturationOf("Ship it", "words");

  check(
    "an emoji comes out in colour, so the font has the glyph and not a box",
    fire > 0.5,
    `saturation ${fire} — zero is a tofu box, which renders and plays and is wrong`,
  );
  check(
    "and a plain word comes out with none — so that is what is being measured",
    words === 0,
    `saturation ${words} for white text, which should have no colour at all`,
  );

  await rm(outE, { recursive: true, force: true });
}

await rm(outA, { recursive: true, force: true });
await rm(outB, { recursive: true, force: true });
await rm(buildDir, { recursive: true, force: true });

console.log("\nThe layer is drawn for the titles, not for the video");
{
  /*
    The layer was always rendered from zero, so its cost was the *end* time of
    the last title rather than its length — and every frame before the first
    one is fully transparent. A title at 8:30 of a podcast asked Chromium for
    51,110 screenshots: measured at 102ms each and 12 KB per empty frame, that
    is eighty-five minutes and six hundred megabytes to draw two and a half
    seconds of text, on a box with 1 GB, with no deadline and no progress
    reported while it ran. The job looked hung because it was.
  */
  const late = {
    width: 160,
    height: 284,
    fps: 25,
    titles: [{ text: "Chapter two", at: 0.5, durationSeconds: 1.5, style: "card", position: "bottom" }],
    durationSeconds: 2.6,
  };
  if (process.env.CHROMIUM_PATH) {
    const dir = await mkdtemp(path.join(tmpdir(), "editly-motion-window-"));
    const layer = await renderMotionLayer(late, dir);
    check("a short title is a short layer", layer !== null && layer.frames <= 2.6 * 25 * 4 + 4, String(layer?.frames));
    await rm(dir, { recursive: true, force: true });

    // And the render asks for that window rather than for everything up to it.
    const work = await mkdtemp(path.join(tmpdir(), "editly-motion-render-"));
    const clip = path.join(work, "v.mp4");
    spawnSync("ffmpeg", [
      "-y", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=navy:s=160x284:r=25:d=20",
      "-f", "lavfi", "-i", "sine=frequency=300:duration=20",
      "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
      clip,
    ]);
    let command = [];
    await renderPlan(
      clip,
      { version: 1, operations: [{ type: "motionTitle", text: "Chapter two", at: 15, durationSeconds: 2.5, style: "card", position: "bottom" }] },
      { workDir: work, onCommand: (args) => { command = args; } },
    );
    const drawn = (await readdir(path.join(work, "motion"))).filter((f) => f.endsWith(".png")).length;
    check(
      "a title fifteen seconds in does not cost fifteen seconds of screenshots",
      drawn > 0 && drawn < 20 * 25 * 4 * 0.3,
      `${drawn} frames against ${20 * 25 * 4} for the whole video`,
    );
    check(
      "and the layer is put back where the title belongs",
      /setpts=N\/[\d.]+\/TB\+14\.5/.test(command.join(" ")),
      command.join(" ").slice(0, 300),
    );
    await rm(work, { recursive: true, force: true });
  } else {
    check("a short title is a short layer (skipped: no browser)", true);
  }
}

/*
  The vocabulary, checked as arithmetic before it is checked as pixels.

  These four — the spring, the stagger, the named entrances and the shadow —
  were written inline inside the title renderer, where the only thing that
  could check them was a person reading the file. They are shared now, which
  means a change to any of them changes the interstitial card, the device
  mockup and the overlay diagram at the same time. That is the point of sharing
  them and also the reason they need checks of their own: a vocabulary nobody
  tests is a vocabulary that drifts one caller at a time.
*/
console.log("\nThe stagger compresses rather than overrunning");
{
  check("one thing has nothing to stagger against", staggerFor(1, 1) === 0, String(staggerFor(1, 1)));
  check("nor does none", staggerFor(0, 1) === 0, String(staggerFor(0, 1)));

  // Three arrivals inside a generous budget: the ideal gap fits, so it is used
  // rather than spread to fill the time. A stagger stretched to fill a long
  // card is a card that is still assembling itself when it cuts away.
  check("a roomy budget gets the ideal gap", staggerFor(3, 2) === STAGGER_S, String(staggerFor(3, 2)));

  // Twelve words in one second: the ideal would still be arriving at 1.21s.
  const tight = staggerFor(12, 1);
  check("a tight budget compresses instead", tight < STAGGER_S, `${tight.toFixed(4)}s`);
  check(
    "and the last one lands exactly on the budget, never after it",
    Math.abs(tight * 11 - 1) < 1e-9,
    `last at ${(tight * 11).toFixed(6)}s of a 1s budget`,
  );
}

console.log("\nEvery entrance knows where it starts and where it rests");
{
  const drop = entranceCss("drop", { travel: 100, scale: 0.86 });
  const rise = entranceCss("rise", { travel: 100, scale: 0.86 });
  // The whole difference between a card landing and a title rising is the sign
  // of this number, and getting it backwards is invisible in source and obvious
  // on screen.
  check("drop comes down from above", drop.from.includes("translateY(-100px)"), drop.from);
  check("rise comes up from below", rise.from.includes("translateY(100px)"), rise.from);
  check("both rest at nothing", drop.to === rise.to && rise.to === "translateY(0) scale(1)", rise.to);

  const settle = entranceCss("settle", { scale: 0.9 });
  check("settle scales in place and does not travel", !settle.from.includes("translateY"), settle.from);

  const fade = entranceCss("fade");
  check("fade does not move at all", fade.from === "none" && fade.to === "none", fade.from);
  // A spring's overshoot is meaningless on an opacity, so fade is the one
  // entrance that is allowed to be quicker than the rest.
  check("and fade is the quick one", fade.ms < entranceCss("rise").ms, `${fade.ms}ms vs ${entranceCss("rise").ms}ms`);

  // CSS writes .86, not 0.86, and this file's output is compared byte for byte.
  check("scales are written the way a stylesheet writes them", drop.from.includes("scale(.86)"), drop.from);
}

console.log("\nThe shadow is two layers, and it is sized against the frame");
{
  const tall = elevation(3, 1920);
  const small = elevation(3, 720);
  check("two shadows, not one", tall.split("rgba").length - 1 === 2, tall);
  // A shadow in fixed pixels is a different shadow at 720p and at 1080p, and
  // the export people actually post is not always the one anybody looked at.
  check("a bigger frame gets a bigger shadow", tall !== small, `${tall} vs ${small}`);
  check("and a heavier level casts further than a lighter one", elevation(3, 1920) !== elevation(1, 1920));
}

console.log("\nThe card cuts in, and everything on it arrives in order");
{
  const html = sceneHtml({
    width: 1080, height: 1920, fps: 30, durationSeconds: 4,
    titles: [],
    elements: [{ kind: "card", name: "Higgs & <b>", note: "a <note>", at: 0.5, durationSeconds: 2 }],
  });
  check("the card is on the page", html.includes("class=\"c0\""), html.slice(0, 80));
  check("its ground is the measured neutral, not white", html.includes("#ECECEC"));
  // A dissolve here is the one thing that makes this read as a slideshow, and
  // the reference never does it.
  check("it cuts in and out rather than dissolving", /on-c0 1ms linear/.test(html) && /off-c0 1ms linear/.test(html), "a card that fades is a slideshow");
  check("and it leaves when it said it would", html.includes("2.500s forwards"), "0.5s + 2s");

  /*
    Read by name, not by position.

    These were matched in document order, which silently encoded the order the
    rules happen to appear in the stylesheet — and that order changed the
    moment the name moved behind the icon, so a correct card failed a check
    about staggering. A test that breaks when the CSS is reordered is a test
    about the CSS, not about the card.
  */
  const delayOf = (name) => {
    const m = html.match(new RegExp(`${name}-c0 \\d+ms [^;]*? ([\\d.]+)s forwards`));
    return m ? Number(m[1]) : null;
  };
  const [icon, title, note] = ["iin", "nin", "pin"].map(delayOf);
  check("three arrivals on the card", [icon, title, note].every((d) => d !== null), JSON.stringify([icon, title, note]));
  check("the icon is first, and it is there when the card is", icon === 0.5, String(icon));
  check("nothing arrives together", title > icon && note > title, JSON.stringify([icon, title, note]));

  check("the name is escaped, not trusted", html.includes("Higgs &amp; &lt;b&gt;") && !html.includes("<b>"));
  check("and so is the note", html.includes("a &lt;note&gt;"));
  check("both work out their own direction", (html.match(/dir="auto"/g) ?? []).length >= 2);

  // No icon is a design, not a gap: the same tile, the same shadow, the same
  // landing, carrying the first letter. The operation is useful before anything
  // here knows how to find a product's logo.
  check("a card with no icon still has something in the tile", html.includes(">H</div>"), "the first letter stands in");

  /*
    The icon URL is the one field on this card that is not plain text, and it
    goes into a CSS string. A quote closes that string; what follows it is
    whatever the caller wrote, inside a stylesheet, in a browser.
  */
  const nasty = sceneHtml({
    width: 1080, height: 1920, fps: 30, durationSeconds: 2, titles: [],
    elements: [{ kind: "card", name: "X", iconUrl: 'a") ; background:url("http://evil/x', at: 0, durationSeconds: 1 }],
  });
  check(
    "an icon URL cannot end the declaration it sits in",
    !nasty.includes("evil"),
    nasty.slice(nasty.indexOf("background:#fff"), nasty.indexOf("background:#fff") + 110),
  );
  // And the refusal is not silent about what it cost: no icon means the tile
  // falls back to the letter, which is the same path a card with no icon takes.
  check("and a refused URL leaves a card rather than a hole", nasty.includes(">X</div>"));
  // The other half of the same rule: a URL that is fine must still be drawn,
  // or this is a check that passes by never drawing anything.
  const good = sceneHtml({
    width: 1080, height: 1920, fps: 30, durationSeconds: 2, titles: [],
    elements: [{ kind: "card", name: "X", iconUrl: "file:///tmp/icon.png", at: 0, durationSeconds: 1 }],
  });
  check("a real file URL is drawn", good.includes('url("file:///tmp/icon.png")'), "otherwise nothing is ever an icon");

  /*
    The name is behind the icon, not above it, and that is the whole look: the
    case has to paint over the wordmark, which in source order means after it.

    Through `order` rather than two `indexOf` results, because `indexOf`
    answers -1 for something that is not there and -1 is less than every real
    position — so the bare comparison would have passed *most loudly* on a card
    that had lost its name altogether. `deploy-test` caught this one before it
    was committed, which is the entire reason that section of it exists.
  */
  const layered = order(html, 'class="n"', 'class="i"');
  check(
    "the icon paints over the name rather than sitting under it",
    layered.ok,
    layered.why || "reversing these two turns a designed card into a stacked list",
  );
}

/*
  The card, in drawn pixels.

  Everything above reads the stylesheet, which is the cheap half. The half
  worth having is this one, because the two things that went wrong with this
  element were both invisible in source: a wordmark that ran off both edges of
  the frame, and a shadow whose far layer blurred into a grey slab behind the
  icon. Both looked completely fine as CSS.

  The name is sized by estimate — there is no way to measure text in a string
  builder — so the estimate is what is checked here, against the longest name
  anybody would plausibly put on a card.
*/
console.log("\nThe card is drawn inside the frame, whatever it is asked to say");
{
  const dir = path.join(buildDir, "card-frames");
  const layer = await renderMotionLayer({
    width: 1080, height: 1920, fps: 25, durationSeconds: 1.6, titles: [],
    elements: [{
      kind: "card",
      // Longer than any product name in the reference, on purpose: "Apify" fits
      // at any size, which is exactly why the first build shipped a number that
      // could not hold "Higgsfield".
      name: "Extraordinarily Long Product",
      note: "and the note under it",
      at: 0.1,
      durationSeconds: 1.4,
    }],
  }, dir);

  if (layer) {
    const files = (await readdir(dir)).filter((f) => f.endsWith(".png")).sort();
    // Well after the last arrival has landed.
    const settled = path.join(dir, files[Math.floor(files.length * 0.7)]);
    const raw = spawnSync("ffmpeg", ["-v", "error", "-i", settled, "-f", "rawvideo", "-pix_fmt", "rgba", "-"], {
      maxBuffer: 1 << 30,
    }).stdout;
    const W = 1080, H = 1920;
    const at = (x, y) => raw[(y * W + x) * 4 + 3];

    check("the card is on the frame at all", raw.length === W * H * 4 && at(W / 2 | 0, H / 2 | 0) > 250, "nothing was drawn");

    /*
      Ink against the edge.

      The card's own ground covers the frame, so "overflow" cannot be measured
      as transparency — it is measured as *dark* pixels in the columns the
      frame ends at. A wordmark that does not fit is cut by the viewport, and a
      cut letter leaves ink hard against the boundary.
    */
    const darkIn = (x) => {
      let n = 0;
      for (let y = 0; y < H; y += 2) {
        const i = (y * W + x) * 4;
        if (raw[i] < 110 && raw[i + 1] < 110 && raw[i + 2] < 110) n += 1;
      }
      return n;
    };
    const left = darkIn(1) + darkIn(3);
    const right = darkIn(W - 2) + darkIn(W - 4);
    check(
      "a long name is sized to fit rather than cut off at the edges",
      left === 0 && right === 0,
      `${left} dark rows against the left edge, ${right} against the right`,
    );

    /*
      The shadow, from both sides — and these thresholds were measured, after
      the first pair of them turned out to be untestable.

      The first version sampled the ground at the frame's far right to prove
      the shadow was not a panel. It could not fail: at that distance even the
      broken calibration — a 286px blur offset 119px under a 277px case — had
      already faded to the ground, so the check passed on the exact bug it was
      written for. That is the second time in this repository a check has been
      written that cannot go red, and the only reason this one was caught is
      that it was deliberately broken and did not.

      So the points come from rendering all three states and reading the
      pixels, rather than from arithmetic about where a shadow ought to reach.
      `near` is a short arc under-right of the case; `open` is the clear ground
      to its right, above the pill. Darkening is summed against the #ECECEC
      ground of 236:

                       near     open
          good           37        7
          a slab         60       42     <- far blur 2.6x too wide
          no shadow       0        0

      Two thresholds fall cleanly between the three, with room either side.
    */
    const ground = (x, y) => raw[(y * W + x) * 4];
    const darkening = (points) =>
      points.reduce((n, [x, y]) => n + Math.max(0, 236 - ground(Math.round(x * W), Math.round(y * H))), 0);

    const near = darkening([[0.655, 0.578], [0.640, 0.590], [0.620, 0.600]]);
    const open = darkening([[0.70, 0.545], [0.70, 0.585], [0.755, 0.560], [0.755, 0.600], [0.80, 0.575]]);

    check(
      "there is a real shadow under the case",
      near > 15,
      `${near} of darkening under-right of the icon — an object with no shadow is pasted on, not lifted`,
    );
    check(
      "and it is a shadow rather than a grey panel behind the icon",
      open < 20,
      `${open} of darkening out in the clear ground beside the icon`,
    );

    await rm(dir, { recursive: true, force: true });
  } else {
    // A laptop with no browser is not a defect in the renderer, and this is
    // how every other render section in this file says so.
    console.log("  · no browser here, so the card's pixel checks are skipped (not failed)");
  }
}

/*
  The layer language.

  The card above is hand-written and matches the one reference it was measured
  against. The language is the answer to that: a model that has watched a
  reference emits boxes with content, entrances and shadows, and the renderer
  draws whatever it is handed — including looks nobody anticipated.

  Which means the renderer is now drawing *caller-supplied values straight into
  a stylesheet*, and there are three of them rather than one: a colour, an
  asset URL, and text. The card already learned what that costs — stripping
  quotes from a URL still let a bare `)` close the url() and open a new
  declaration — so all three are validated here, and the checks below are the
  ones that would have caught that bug on the first day.
*/
const L = (o) => ({ kind: "layer", ...o });
const fill = (color) => ({
  box: { x: 0, y: 0, w: 1, h: 1 }, content: { kind: "fill", color },
  at: 0, durationSeconds: 1,
});

console.log("\nA colour is matched against a shape, or refused");
{
  for (const good of ["#fff", "#ECECEC", "#11223344", "rgb(1,2,3)", "rgba(1,2,3,.5)", "hsl(148 62% 58%)", "transparent"]) {
    check(`${good} is a colour`, safeColor(good) === good, JSON.stringify(safeColor(good)));
  }
  /*
    Each of these is a real way out of a declaration, and none of them is
    exotic — they are what a model emits when it has been told to describe a
    colour and describes something else instead, and what a prompt injected
    into a reference's own on-screen text would try.
  */
  for (const bad of [
    "red;background:url(http://evil/x)",
    "#fff;} body { display:none",
    "url(http://evil/x)",
    "expression(alert(1))",
    "var(--x)",
    "#fff\\\\",
    "rgb(1,2,3);}*{color:red",
  ]) {
    check(`${JSON.stringify(bad)} is refused`, safeColor(bad) === null, JSON.stringify(safeColor(bad)));
  }
  check("and nothing at all is nothing", safeColor(undefined) === null && safeColor("") === null);

  // A refused colour must cost the colour, never the render.
  const html = sceneHtml({
    width: 1080, height: 1920, fps: 30, durationSeconds: 2, titles: [],
    elements: [L(fill("red;background:url(http://evil/x)"))],
  });
  check("a refused colour leaves a transparent box, not an injected rule", !html.includes("evil"), html.slice(0, 200));
  check("and the layer is still drawn", html.includes('class="l0"'));
}

console.log("\nAn asset URL is matched against a shape, or refused");
{
  check("a file URL is usable", safeAssetUrl("file:///tmp/a.png") === "file:///tmp/a.png");
  /*
    And a data URL, which the first version of the validator rejected outright:
    an embedded image *must* carry `;base64,` and the file rule forbids a
    semicolon. The check written for this originally ended in `|| true`, so it
    passed while every data URL in the product was being silently dropped.
    Third time this session that a check could not fail; the only defence is
    breaking each one on purpose.
  */
  const embedded = "data:image/png;base64,iVBORw0KGgo=";
  check("so is an embedded image", safeAssetUrl(embedded) === embedded, JSON.stringify(safeAssetUrl(embedded)));
  check("but not one with something else in its alphabet", safeAssetUrl('data:image/png;base64,AA") ; x:(') === null);
  check("nor a made-up type", safeAssetUrl("data:text/html;base64,AAAA") === null);
  for (const bad of [
    'a") ; background:url("http://evil/x',
    "http://evil/x.png",
    "file:///tmp/a.png) ; color:red",
    "file:///tmp/a b.png",
    "javascript:alert(1)",
  ]) {
    check(`${JSON.stringify(bad.slice(0, 32))} is refused`, safeAssetUrl(bad) === null, JSON.stringify(safeAssetUrl(bad)));
  }
  const html = sceneHtml({
    width: 1080, height: 1920, fps: 30, durationSeconds: 2, titles: [],
    elements: [L({ box: { x: 0, y: 0, w: 1, h: 1 }, content: { kind: "image", url: 'a") ; background:url("http://evil/x' }, at: 0, durationSeconds: 1 })],
  });
  check("a refused image URL cannot open a declaration", !html.includes("evil"), html.slice(0, 200));
}

console.log("\nA line is a sequence of runs, each with its own weight");
{
  const html = sceneHtml({
    width: 1080, height: 1920, fps: 30, durationSeconds: 3, titles: [],
    elements: [L({
      box: { x: 0.06, y: 0.6, w: 0.88, h: 0.22 },
      content: {
        kind: "text", size: 0.052, color: "#fff", weight: 800, staggerRuns: true,
        runs: [{ text: "pretty" }, { text: "Good & <b>", scale: 2, color: "#3ddc97" }, { text: "at" }],
      },
      at: 0.2, durationSeconds: 2, enter: "rise", travel: 0.03, from: 0.86,
    })],
  });
  check("one piece per run", (html.match(/<i/g) ?? []).length === 3, html.match(/<i/g)?.length + " pieces");
  // The thing plain captions cannot say, and every reference says: one word
  // inside the phrase is bigger and a different colour.
  check("a run can be larger than the line it is in", html.includes("font-size:200.0%"));
  check("and its own colour", html.includes("color:#3ddc97"));
  check("run text is escaped, not trusted", html.includes("Good &amp; &lt;b&gt;") && !html.includes("<b>"));

  const delays = [...html.matchAll(/animation-delay:([\d.]+)s/g)].map((m) => Number(m[1]));
  check("the runs arrive one after another", delays.length === 3 && delays[1] > delays[0] && delays[2] > delays[1], JSON.stringify(delays));
  check("the first arrives when the layer does", delays[0] === 0.2, String(delays[0]));

  /*
    When the runs carry the entrance the layer itself must not also animate in,
    or the line arrives twice — once as a block and once a word at a time. It
    is the kind of thing that looks like a stutter and reads as a bug in the
    encoder.
  */
  check("a staggered line does not also fly in as a block", !/\.l0 \{[^}]*animation: in-l0/.test(html), "the layer and its runs would both animate");
}

console.log("\nA layer is placed and shaped against the frame");
{
  const html = sceneHtml({
    width: 1000, height: 2000, fps: 30, durationSeconds: 2, titles: [],
    elements: [L({
      box: { x: 0.25, y: 0.1, w: 0.5, h: 0.2 },
      content: { kind: "fill", color: "#2f5cff" },
      at: 0.3, durationSeconds: 1.2, enter: "drop", travel: 0.5, radius: 0.25, shadow: 2, z: 3,
    })],
  });
  check("the box is a fraction of the frame, not a pixel count", html.includes("left:250px") && html.includes("top:200px") && html.includes("width:500px") && html.includes("height:400px"), "0.25/0.1/0.5/0.2 of 1000x2000");
  // Radius against the layer's shorter side, so a wide box and a tall one with
  // the same radius look like the same corner.
  check("the radius is a fraction of the layer's shorter side", html.includes("border-radius:100px"), "0.25 of min(500,400)");
  check("it carries a shadow when asked", html.includes("box-shadow:"), "");
  check("and a depth", html.includes("z-index:3"));
  check("it leaves on a cut, like the card", html.includes("out-l0 1ms linear 1.500s"), "0.3 + 1.2");
}

console.log("\nA gradient is built here, never handed over as CSS");
{
  const good = sceneHtml({
    width: 1080, height: 1920, fps: 30, durationSeconds: 2, titles: [],
    elements: [L({ box: { x: 0, y: 0, w: 1, h: 0.5 },
      content: { kind: "gradient", from: "#2f5cff", to: "#f4f5f7", angle: 200 },
      at: 0, durationSeconds: 1 })],
  });
  check("two stops and an angle become one gradient", good.includes("linear-gradient(200deg, #2f5cff, #f4f5f7)"), good.slice(good.indexOf("background:"), good.indexOf("background:") + 70));

  /*
    The whole reason this takes three values instead of a string: there is no
    spelling of a colour that can end the declaration, so there is no gradient
    a caller can write that escapes one.
  */
  const nasty = sceneHtml({
    width: 1080, height: 1920, fps: 30, durationSeconds: 2, titles: [],
    elements: [L({ box: { x: 0, y: 0, w: 1, h: 1 },
      content: { kind: "gradient", from: "#fff;} body{display:none", to: "red", angle: 0 },
      at: 0, durationSeconds: 1 })],
  });
  check("a stop that is not a colour takes the gradient with it", !nasty.includes("display:none") && !nasty.includes("linear-gradient"), nasty.slice(0, 160));
  // And loses it *entirely* rather than becoming a flat colour: a layer that
  // silently turned into something else is worse than one plainly absent.
  check("and does not quietly become a flat fill", nasty.includes("background:transparent"));
}

console.log("\nA layer can be soft, faint and tilted");
{
  const html = sceneHtml({
    width: 1000, height: 2000, fps: 30, durationSeconds: 2, titles: [],
    elements: [L({ box: { x: 0.2, y: 0.2, w: 0.6, h: 0.3 },
      content: { kind: "fill", color: "#2f5cff" },
      at: 0.4, durationSeconds: 1, enter: "rise", travel: 0.04,
      blur: 0.02, opacity: 0.45, rotate: -8, radius: 0.5 })],
  });
  // Against frame height, like everything else placed here: the same layer on
  // a 720 and a 1920 frame has to be the same softness.
  check("blur is a fraction of frame height", html.includes("filter:blur(40px)"), "0.02 of 2000");
  check("the layer rests at the opacity it was given", html.includes("opacity:0.45"), "not at 1");
  check("and the entrance lands on that opacity, not on full", /@keyframes in-l0 \{ to \{ opacity:0\.45/.test(html), "otherwise it fades in past where it belongs");

  /*
    The tilt has to be in both ends of the entrance.

    As a resting transform on its own it would be overwritten by the
    animation's `to`, and the layer would un-tilt exactly as it landed — a
    rotation visible in a still and gone in motion, which is worse than none.
  */
  check("the tilt is in the entrance's start", /transform:translateY\(\d+px\) rotate\(-8deg\)/.test(html), html.slice(html.indexOf("transform:"), html.indexOf("transform:") + 60));
  check("and still there when it lands", /@keyframes in-l0 \{ to \{[^}]*rotate\(-8deg\)/.test(html), "it would un-tilt as it arrives");

  check("a radius of 0.5 makes it round", html.includes("border-radius:300px"), "0.5 of min(600,600)");
}

/*
  Devices, and the one thing about them that has to be exactly right.

  r05 and r08 wrap their screen recordings in a laptop or a browser window;
  r07 holds up a phone. The frame is most of why a recording reads as a product
  rather than as somebody's desktop.

  What goes inside is a clip, and a clip is placed by ffmpeg while the frame is
  drawn by the browser. The two have to agree about the same rectangle to the
  pixel, or the result is a recording with a sliver of bezel down one edge —
  which reads as a rendering fault, not a design. `deviceScreenBox` is the one
  place that rectangle is computed, and these are the checks on it.
*/
console.log("\nA device's screen is where both halves agree it is");
{
  const box = { x: 0.1, y: 0.2, w: 0.4, h: 0.5 };
  for (const kind of ["phone", "browser", "laptop"]) {
    const scr = deviceScreenBox(kind, box);
    check(`${kind}: the screen is inside the device`,
      scr.x > box.x && scr.y > box.y && scr.x + scr.w < box.x + box.w && scr.y + scr.h < box.y + box.h,
      JSON.stringify(scr));
  }

  /*
    Each inset must depend on its own axis, and only on its own axis.

    The first spelling of this compared the side fraction against the top
    fraction and asked whether they differed — which they do in the table, so
    it passed whether or not the right axis was being read. It could not fail,
    and breaking the function to read the top off the *width* proved it: still
    green. Fourth check this session that could not go red.

    Changing one dimension at a time is what actually separates them. Double
    the height and the top inset must double while the side inset does not
    move; double the width and the opposite.
  */
  const short = deviceScreenBox("phone", { x: 0, y: 0, w: 0.3, h: 0.4 });
  const tall  = deviceScreenBox("phone", { x: 0, y: 0, w: 0.3, h: 0.8 });
  const wide  = deviceScreenBox("phone", { x: 0, y: 0, w: 0.6, h: 0.4 });

  check("the top inset follows the device's height",
    Math.abs(tall.y - short.y * 2) < 1e-9 && tall.y > short.y,
    `${short.y} -> ${tall.y} when the height doubles`);
  check("and does not follow its width",
    Math.abs(wide.y - short.y) < 1e-9,
    `${short.y} -> ${wide.y} when only the width changed`);
  check("the side inset follows the device's width",
    Math.abs(wide.x - short.x * 2) < 1e-9 && wide.x > short.x,
    `${short.x} -> ${wide.x} when the width doubles`);
  check("and does not follow its height",
    Math.abs(tall.x - short.x) < 1e-9,
    `${short.x} -> ${tall.x} when only the height changed — one axis for both gives a fat forehead and a thin chin`);

  // A browser's chrome is at the top, so its screen starts much further down
  // than a phone's. If these came out the same, the table is not being read.
  const phone = deviceScreenBox("phone", box);
  const browser = deviceScreenBox("browser", box);
  check("a browser gives up more of its top than a phone does", browser.y - box.y > (phone.y - box.y) * 2, `${browser.y - box.y} vs ${phone.y - box.y}`);

  /*
    The corner the content has to be cut to.

    Without it the screen is a rounded hole with a square picture behind it,
    and the picture's corners stick out past the bezel — four tabs of video
    on the outside of a phone. Visible in the first render anybody looks at,
    and unavoidable for a caller, because the inner radius is the outer radius
    minus the bezel and only that table knows either.
  */
  const withFrame = deviceScreenBox("phone", box, { width: 1080, height: 1920 });
  check("the screen reports the corner its content must be cut to", withFrame.radius > 0, String(withFrame.radius));
  check("and it is smaller than the device's own corner", withFrame.radius < 0.125 / 1, `${withFrame.radius} — an inner corner is the outer one minus the bezel`);
  // Asked without a frame there is no honest answer: "shorter side" is a pixel
  // comparison and these boxes are fractions of two different axes.
  check("asked without a frame it says nothing rather than guessing", deviceScreenBox("phone", box).radius === 0);
}

console.log("\nA device is a border, so its screen is a hole");
{
  const html = sceneHtml({
    width: 1080, height: 1920, fps: 30, durationSeconds: 2, titles: [],
    elements: [L({ box: { x: 0.1, y: 0.1, w: 0.4, h: 0.5 },
      content: { kind: "device", device: "browser", shell: "#2b3340" },
      at: 0, durationSeconds: 1.5 })],
  });
  /*
    The first spelling drew an opaque body with a transparent "screen" laid
    over it — which is a window onto the body behind it, not a hole, and it
    rendered a black slab with nothing showing through. What goes in the screen
    sits *underneath* this layer, so the middle has to be genuinely empty.
  */
  check("the body is drawn as a border", /\.dev \{[^}]*border-style:solid/.test(html), "an opaque body has no hole in it");
  check("and its middle is transparent", /\.dev \{[^}]*background:transparent/.test(html), html.slice(html.indexOf(".dev"), html.indexOf(".dev") + 180));
  check("the shell colour is used", html.includes("border-color:#2b3340"));
  check("and a shell that is not a colour is refused", !sceneHtml({
    width: 100, height: 100, fps: 30, durationSeconds: 1, titles: [],
    elements: [L({ box: { x: 0, y: 0, w: 1, h: 1 }, content: { kind: "device", device: "phone", shell: "red;}*{display:none" }, at: 0, durationSeconds: 1 })],
  }).includes("display:none"));

  check("a browser says what it is with three dots", (html.match(/<i><\/i>/g) ?? []).length === 3, "a title bar with no dots is a grey stripe");
  const phone = sceneHtml({
    width: 1080, height: 1920, fps: 30, durationSeconds: 2, titles: [],
    elements: [L({ box: { x: 0.1, y: 0.1, w: 0.4, h: 0.5 }, content: { kind: "device", device: "phone" }, at: 0, durationSeconds: 1.5 })],
  });
  check("a phone has a notch instead", phone.includes('class="notch"') && !phone.includes('class="dots"'));
}

console.log("\nAnd the hole is a hole in drawn pixels");
{
  const dir = path.join(buildDir, "device-frames");
  const box = { x: 0.2, y: 0.3, w: 0.6, h: 0.4 };
  const screen = deviceScreenBox("laptop", box);
  const layer = await renderMotionLayer({
    width: 800, height: 1200, fps: 25, durationSeconds: 1.2, titles: [],
    elements: [
      // What ffmpeg would put behind the frame.
      { kind: "layer", box: screen, content: { kind: "fill", color: "#00ff00" }, at: 0, durationSeconds: 1.1, z: 1 },
      { kind: "layer", box, content: { kind: "device", device: "laptop", shell: "#ff0000" }, at: 0, durationSeconds: 1.1, z: 2 },
    ],
  }, dir);

  if (layer) {
    const files = (await readdir(dir)).filter((f) => f.endsWith(".png")).sort();
    const settled = path.join(dir, files[Math.floor(files.length * 0.6)]);
    const raw = spawnSync("ffmpeg", ["-v", "error", "-i", settled, "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { maxBuffer: 1 << 30 }).stdout;
    const W = 800, H = 1200;
    const px = (xf, yf) => {
      const i = ((Math.round(yf * H) * W) + Math.round(xf * W)) * 4;
      return [raw[i], raw[i + 1], raw[i + 2], raw[i + 3]];
    };
    const middle = px(screen.x + screen.w / 2, screen.y + screen.h / 2);
    const bezel = px(box.x + box.w / 2, box.y + box.h - 0.02);

    check("what was placed behind the frame is visible through its screen",
      middle[1] > 200 && middle[0] < 90,
      `rgb(${middle.slice(0, 3)}) at the middle of the screen — red would mean the body covered it`);
    check("and the body is drawn where the body is",
      bezel[0] > 200 && bezel[1] < 90,
      `rgb(${bezel.slice(0, 3)}) on the laptop's base`);
    await rm(dir, { recursive: true, force: true });
  } else {
    console.log("  · no browser here, so the device pixel checks are skipped (not failed)");
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log("The motion is not reproducible.");
  process.exit(1);
}
console.log("Designed motion, and the same every time.");
