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

const { spring, sceneHtml, renderMotionLayer } = await import(pathToFileURL(modulePath).href);

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

await rm(outA, { recursive: true, force: true });
await rm(outB, { recursive: true, force: true });
await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log("The motion is not reproducible.");
  process.exit(1);
}
console.log("Designed motion, and the same every time.");
