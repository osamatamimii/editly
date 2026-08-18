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
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-motion-test-"));
const modulePath = path.join(buildDir, "motion.mjs");

const esbuild = spawnSync(
  require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/worker"] }),
  [
    path.join(repoRoot, "artifacts/worker/src/motion.ts"),
    "--bundle", "--platform=node", "--format=esm", "--target=node22",
    "--external:playwright-core",
    `--outfile=${modulePath}`, "--log-level=error",
  ],
  { stdio: "inherit" },
);
if (esbuild.status !== 0) {
  console.error("could not bundle the motion module");
  process.exit(1);
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

await rm(outA, { recursive: true, force: true });
await rm(outB, { recursive: true, force: true });
await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log("The motion is not reproducible.");
  process.exit(1);
}
console.log("Designed motion, and the same every time.");
