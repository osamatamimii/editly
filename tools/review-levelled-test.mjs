/**
 * The reviewer levels what the render levelled, and nothing it did not.
 *
 * A `normalizeLoudness` op in the plan is not proof the render applied it. The
 * renderer levels only when there is already sound at the point the audio graph
 * is built; a silent source whose whole soundtrack is sound effects mixed in
 * later is never levelled, though the op still sits in the plan. The reviewer
 * used to re-derive the fact from the plan, and so it would measure that
 * effects-only mix — quiet, nowhere near -14 LUFS — and "correct" it, boosting a
 * handful of effects a dozen-plus dB into a clipped master the render had
 * deliberately left alone. Nothing threw: the note even called it a fix.
 *
 * The render now reports `levelled`, and the reviewer measures and corrects only
 * when it is true. This proves both directions on a real file whose level is far
 * from the target: told the render levelled, the reviewer corrects it; told it
 * did not, the file is left exactly as it is. Revert the gate and the
 * un-levelled file is rewritten: red.
 *
 * Usage: node tools/review-levelled-test.mjs
 * Requires: ffmpeg/ffprobe. No keys, no network.
 */
import { mkdtemp, rm, stat, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-lvl-build-"));
const workRoot = await mkdtemp(path.join(tmpdir(), "editly-lvl-work-"));

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

const { reviewOutput } = await import(bundle("artifacts/worker/src/review.ts", "review.mjs"));

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

const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
if (spawnSync(FFMPEG, ["-version"]).status !== 0) {
  console.error("ffmpeg is not on the PATH; this suite makes and measures a real file.");
  process.exit(1);
}

// A picture plus a loud tone: ~-3 LUFS, a dozen-plus LU above a -14 target, so a
// review that decides to correct it would visibly rewrite the file.
function makeOffLevel(name) {
  const file = path.join(workRoot, name);
  const made = spawnSync(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=6",
    "-f", "lavfi", "-i", "sine=frequency=1000:duration=6",
    "-map", "0:v", "-map", "1:a",
    "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
    file,
  ]);
  if (made.status !== 0) {
    console.error(`could not build ${name}: ${String(made.stderr).slice(-400)}`);
    process.exit(1);
  }
  return file;
}

const MOVING = path.join(workRoot, "src.mp4");
spawnSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y",
  "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=6",
  "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast", MOVING]);

const context = (extra) => ({
  operations: [{ type: "normalizeLoudness", targetLufs: -14 }],
  language: undefined,
  sourcePath: MOVING,
  sourceHadAudio: true,
  expectedAudio: true,
  expectedSeconds: null,
  workDir: workRoot,
  ...extra,
});

// ── Told the render did not level: leave it alone ─────────────────────────────

section("A mix the render never levelled is not 'corrected'");
{
  const file = makeOffLevel("not-levelled.mp4");
  const before = (await stat(file)).size;
  const r = await reviewOutput(file, context({ levelled: false }));
  const after = (await stat(file)).size;

  check("the file is not rewritten", r.repaired === false, `repaired=${r.repaired}`);
  check("its bytes are untouched", before === after, `${before} -> ${after}`);
  check("and no 'levelling missed' note is invented", !r.notes.some((n) => /levelling|التسوية/.test(n)), JSON.stringify(r.notes));
}

// ── Told the render levelled and it missed: correct it ────────────────────────

section("A level the render set but missed is measured and corrected");
{
  const file = makeOffLevel("levelled.mp4");
  const r = await reviewOutput(file, context({ levelled: true }));
  // A tone this far from target is brought back: the render is rewritten and the
  // customer is told the first pass missed. This is the behaviour the gate keeps
  // for real levelled renders.
  check("the file is corrected", r.repaired === true, `repaired=${r.repaired}, warnings=${JSON.stringify(r.warnings)}`);
  check("a measured level comes back", typeof r.measuredLufs === "number", String(r.measuredLufs));
  check("and the customer is told the pass missed", r.notes.some((n) => /levelling|التسوية/.test(n)), JSON.stringify(r.notes));
}

await rm(buildDir, { recursive: true, force: true });
await rm(workRoot, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
console.log("The reviewer corrects the level the render set, and never invents one it did not.");
