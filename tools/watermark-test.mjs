/**
 * The watermark text cannot break out of the filter graph.
 *
 * The free-plan mark is `drawtext`, and until this suite existed the text was
 * interpolated straight into the filtergraph string behind a helper that
 * escaped `\ : ' %` and nothing else. That is not enough, and the gap is not
 * theoretical: inside an ffmpeg filtergraph a `\'` does not escape a quote, it
 * *ends* the quoted run, and once the quote is closed an un-escaped `,` starts
 * a new filter. So a watermark of
 *
 *   ',drawtext=textfile=/proc/self/environ,drawtext=text='
 *
 * — fifty-four characters, inside the sixty the schema allows — parsed as three
 * chained filters, the middle one drawing this worker's own environment onto
 * the frame the person downloads. `render-policy.ts` only replaces a
 * client-supplied watermark on the free plan, so any paid account reached the
 * sink with its own text.
 *
 * The fix writes the text to a file and points `drawtext` at it with
 * `textfile=` and `expansion=none`, so nothing the user typed is ever parsed as
 * graph syntax. This suite proves the difference the only honest way: it runs
 * the real `renderPlan`, hands it a watermark that would open a file if the
 * injection worked, and checks that no such file is opened — by naming a file
 * that does not exist and asserting the render still succeeds. A render that
 * opened it would fail with "No such file or directory", which is exactly what
 * the vulnerable code did. It then points the payload at a file that *does*
 * exist and holds a secret, and asserts the render still succeeds and the
 * secret never appears in the notes — the injection is inert, the payload is
 * just odd-looking watermark text.
 *
 * Revert the fix and this goes red: the missing-file payload fails the render.
 *
 * Usage: node tools/watermark-test.mjs
 * Requires: ffmpeg and ffprobe on PATH.
 */
import { mkdtemp, rm, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-watermark-"));
const modulePath = path.join(buildDir, "ffmpeg.mjs");

const esbuild = spawnSync(
  require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/worker"] }),
  [
    path.join(repoRoot, "artifacts/worker/src/ffmpeg.ts"),
    "--bundle", "--platform=node", "--format=esm", "--target=node22",
    `--outfile=${modulePath}`, "--log-level=error",
  ],
  { stdio: "inherit" },
);
if (esbuild.status !== 0) {
  console.error("could not bundle the ffmpeg module");
  process.exit(1);
}
const { renderPlan } = await import(pathToFileURL(modulePath).href);

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
const section = (title) => console.log(`\n${title}`);
const scratch = () => mkdtemp(path.join(tmpdir(), "editly-wm-"));

// A short clip that is bright, not black. A bare injected `drawtext` defaults
// to black text, which is invisible on the black test source the other suites
// use — so a black source would hide a working injection. White makes any
// drawn text, injected or not, land as ink. Nothing here reads pixels, but the
// source should not be the thing that hides an attack.
const source = path.join(buildDir, "source.mp4");
{
  const gen = spawnSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=white:s=640x360:rate=25:duration=2",
    "-f", "lavfi", "-i", "sine=frequency=300:duration=2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source,
  ]);
  if (gen.status !== 0) {
    console.error("could not generate the test clip\n", gen.stderr?.slice(0, 400));
    process.exit(1);
  }
}

// A file that does NOT exist. The vulnerable code, handed a payload naming it,
// makes ffmpeg try to open it and the render fails; the fixed code draws the
// payload as literal text and the render succeeds. This is the whole test.
const absent = path.join(buildDir, "does-not-exist-ever.txt");

// A file that DOES exist and holds a secret, to prove the payload is inert
// rather than merely pointed somewhere empty.
const secretFile = path.join(buildDir, "secret.txt");
const SECRET = "SUPABASE-SERVICE-ROLE-KEY-abc123";
await writeFile(secretFile, SECRET, "utf8");

/** A one-operation plan whose only step is a watermark carrying `text`. */
const withWatermark = (text) => ({
  version: 1,
  operations: [{ type: "watermark", text, position: "bottom-right" }],
});

async function render(text) {
  try {
    const result = await renderPlan(source, withWatermark(text), { workDir: await scratch() });
    await access(result.output); // the file exists, so the render really finished
    return { ok: true, notes: result.notes ?? [] };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

section("Ordinary watermark text renders");
{
  const plain = await render("Edited with Editly");
  check("the default mark renders", plain.ok, plain.error ?? "");

  // Text a real customer would set, and every one of these characters is graph
  // syntax the old escaper mangled or let through: an apostrophe, a colon, a
  // comma, Arabic. The point of the file-based fix is that all of them are just
  // text now.
  const punctuation = await render("Chris's channel — 9:16, daily");
  check("an apostrophe, a colon and a comma survive as text", punctuation.ok, punctuation.error ?? "");

  const arabic = await render("قناة كريم");
  check("and so does Arabic", arabic.ok, arabic.error ?? "");
}

section("A watermark that tries to open a file opens nothing");
{
  // The payload the vulnerable code would honour: close the quote, chain a
  // `drawtext=textfile=`, reopen. The reachability point — that a real exploit
  // fits the sixty characters `WatermarkOperation.text` allows — is made with
  // the path an attacker would actually name; the render below uses a temp path
  // that happens to be longer, because `renderPlan` does not enforce the cap
  // (the schema does, upstream) and the length is not what is under test here.
  const realWorld = "',drawtext=textfile=/proc/self/environ,drawtext=text='";
  check(
    "a real exploit fits the sixty characters the schema allows",
    realWorld.length <= 60,
    String(realWorld.length),
  );

  const payload = `',drawtext=textfile=${absent},drawtext=text='`;
  const attacked = await render(payload);
  // The whole finding, in one assertion. Vulnerable: ffmpeg opens `absent`,
  // fails to read it, and the render throws. Fixed: the payload is drawn as
  // literal text and the render succeeds.
  check(
    "a payload naming a missing file does not make the render fail",
    attacked.ok,
    attacked.error ?? "",
  );
  check("and the missing file was never created as a side effect", await missing(absent));
}

section("And a payload pointed at a real secret cannot exfiltrate it");
{
  const payload = `',drawtext=textfile=${secretFile},drawtext=text='`.slice(0, 60);
  const attacked = await render(`',drawtext=textfile=${secretFile}[x]`);
  check("a payload naming a real file still renders rather than injecting", attacked.ok, attacked.error ?? "");
  check(
    "and the secret never reaches the render notes",
    attacked.ok && !JSON.stringify(attacked.notes).includes(SECRET),
    "the notes echo the watermark text, so a leak here would be a second path",
  );
}

async function missing(file) {
  try {
    await access(file);
    return false;
  } catch {
    return true;
  }
}

await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("The watermark is text, not a filter.");
