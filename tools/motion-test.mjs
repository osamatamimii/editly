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

const { spring, sceneHtml, renderMotionLayer, wordsOf } = await import(pathToFileURL(modulePath).href);

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

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log("The motion is not reproducible.");
  process.exit(1);
}
console.log("Designed motion, and the same every time.");
